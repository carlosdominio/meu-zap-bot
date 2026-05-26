const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');       
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Banco de dados local
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {} }).write();
    console.log('Banco de dados pronto');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = process.env.PORT || 3000;

app.use(express.static('public'));

let lastQr = null;
let statusConexao = "DESCONECTADO";
let sock = null;

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) socket.emit('history', db.get('chats').value());

    socket.on('send_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
            const sent = await sock.sendMessage(jid, { text: data.text });
            const msgObj = { 
                id: sent.key.id, 
                text: data.text, 
                fromMe: true, 
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
                sender: jid, 
                pushName: "Voce" 
            };
            await saveMessage(jid, msgObj, "Voce");
            io.emit('new_msg', msgObj);
        } catch (e) { console.log('Erro ao enviar:', e); }
    });

    socket.on('delete_chat', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                delete chats[jid];
                await db.set('chats', chats).write();
                io.emit('chat_deleted', jid);
            }
        }
    });

    socket.on('toggle_atendimento', async (data) => {
        const { jid, status } = data;
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                chats[jid].atendimentoManual = status;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: status });
            }
        }
    });

    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

async function saveMessage(jid, msg, name) {
    if (!jid || jid.includes('@newsletter') || jid.includes('@broadcast')) return;
    
    const chats = db.get('chats').value() || {};
    if (!chats[jid]) {
        chats[jid] = { name: jid.split('@')[0], messages: [], atendimentoManual: false };
    }
    
    // Evita duplicados
    if (chats[jid].messages.some(m => m.id === msg.id)) return;

    chats[jid].messages.push(msg);
    
    // Limita o histórico (últimas 100 mensagens) para manter o db.json leve
    if (chats[jid].messages.length > 100) chats[jid].messages.shift();
    
    if (name && name !== "Voce" && name !== "Robo") {
        chats[jid].name = name;
    }
    
    await db.set('chats', chats).write();
}

async function connectToWhatsApp() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap'), printQRInTerminal: false });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;
            if (qr) { QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); }); statusConexao = "AGUARDANDO QR"; io.emit('status', {status: statusConexao}); }
            if (connection === 'open') { statusConexao = "CONECTADO"; lastQr = null; io.emit('status', {status: statusConexao}); console.log('Bot Pronto'); }
            if (connection === 'close') { setTimeout(connectToWhatsApp, 5000); statusConexao = "DESCONECTADO"; io.emit('status', {status: statusConexao}); }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message) return; // Permitir fromMe para salvar mensagens do próprio robô

            const jid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            const pushName = fromMe ? "Voce" : (msg.pushName || jid.split('@')[0]);
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!text) return;

            const msgObj = { 
                id: msg.key.id, 
                from: jid,
                text: text, 
                fromMe: fromMe, 
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
                sender: jid, 
                pushName: pushName
            };

            await saveMessage(jid, msgObj, pushName);
            io.emit('new_msg', msgObj);

            // Não responde se a mensagem for enviada pelo próprio robô (evita loop)
            if (fromMe) return;

            // Verifica se o atendimento humano está ativo para este chat
            const atendimentoManual = db.get(['chats', jid, 'atendimentoManual']).value() || false;
            if (atendimentoManual) {
                console.log(`[WhatsApp] Atendimento Humano ativo para ${jid}. Robô em silêncio.`);
                return;
            }

            // MENU DO ROBÔ (Sempre ativo)
            let reply = "";
            const lowerText = text.toLowerCase();

            if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                reply = `Olá ${pushName}! 👋 Seja bem-vindo ao *GuGA Bebidas*.\n\nComo posso te ajudar hoje?\n\n1️⃣ - Ver Cardápio Digital 📖\n2️⃣ - Fazer um Pedido 🛒\n3️⃣ - Promoções do Dia 🔥\n4️⃣ - Endereço e Horário 📍\n5️⃣ - Falar com o Atendente 👨‍💻\n\n_Digite apenas o número da opção desejada._`;
            } else {
                if (lowerText === '1') {
                    reply = "📖 *CARDÁDIO DIGITAL*\n\nVocê pode ver todos os nossos itens e preços clicando no link abaixo:\nhttps://garconnexpress.vercel.app/cardapio/\n\n_(Escolha o que deseja e nos mande o pedido por aqui!)_";
                } else if (lowerText === '2') {
                    reply = "🛒 *COMO FAZER UM PEDIDO*\n\nÉ muito simples:\n1. Veja o cardápio (opção 1)\n2. Escreva aqui o que deseja (ex: 2 Cervejas, 1 Porção de Batata)\n3. Confirme seu endereço\n\n*Um atendente irá confirmar seu pedido em instantes!*";
                } else if (lowerText === '3') {
                    try {
                        const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                        const menu = await response.json();
                        const promos = menu.filter(item => item.em_promocao && (item.visivel === true || item.visivel === 1));
                        let promoMsg = "🔥 *PROMOÇÕES DO DIA*\n\n";
                        if (promos.length > 0) {
                            promos.forEach(p => {
                                const precoOriginal = p.preco_original ? `~R$ ${parseFloat(p.preco_original).toFixed(2)}~ ` : "";
                                promoMsg += `✅ *${p.nome}*\n💰 ${precoOriginal}*R$ ${parseFloat(p.preco).toFixed(2)}*\n\n`;
                            });
                            promoMsg += "_Aproveite que é por tempo limitado!_";
                        } else {
                            promoMsg += "No momento não temos promoções ativas, mas fique de olho no nosso cardápio! 😉";
                        }
                        reply = promoMsg;
                    } catch (e) {
                        reply = "🔥 *PROMOÇÕES DO DIA*\n\nNo momento não conseguimos carregar as promoções. Por favor, tente novamente em instantes ou veja no nosso cardápio digital!";
                    }
                } else if (lowerText === '4') {
                    reply = "📍 *ENDEREÇO E HORÁRIO*\n\n🏠 Endereço: rua democrito gracindo 132 ponta grossa\n⏰ Horário: Diariamente das 18h às 02:00";
                } else if (lowerText === '5') {
                    reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nAguarde um momento. Um atendente humano já foi notificado e irá falar com você em breve!";
                    
                    // Ativa atendimento manual automaticamente ao solicitar atendente
                    const chats = db.get('chats').value() || {};
                    if (chats[jid]) {
                        chats[jid].atendimentoManual = true;
                        await db.set('chats', chats).write();
                        io.emit('status_atendimento', { jid, atendimentoManual: true });
                    }
                }
            }

            if (reply) {
                const s = await sock.sendMessage(jid, { text: reply });
                const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                await saveMessage(jid, rObj, "Robo");
                io.emit('new_msg', rObj);
            }
        });
    } catch (err) { setTimeout(connectToWhatsApp, 5000); }
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
});
