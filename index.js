const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Banco de dados local (ASSÍNCRONO para melhor performance)
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {} }).write();
    console.log('Banco de dados carregado 📦');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });
const port = process.env.PORT || 3000;

let lastQr = null;
let statusConexao = "DESCONECTADO ❌";
let sock;

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', async (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    socket.emit('history', db.get('chats').value());

    // Resposta de Ping para medir latência
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') callback();
    });

    // Enviar Mensagem
    socket.on('send_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO ✅") return;
        try {
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
            const sent = await sock.sendMessage(jid, { text: data.text });
            const msgObj = { id: sent.key.id, text: data.text, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Você" };
            await saveMessage(jid, msgObj, "Você");
            io.emit('new_msg', msgObj);
        } catch (e) { console.log('Erro envio:', e); }
    });

    // Enviar Áudio
    socket.on('send_audio', async (data) => {
        if (!sock || statusConexao !== "CONECTADO ✅") return;
        try {
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
            const sent = await sock.sendMessage(jid, { audio: data.audio, mimetype: 'audio/mp4', ptt: true });
            const msgObj = { id: sent.key.id, text: "🎤 Áudio enviado", fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Você" };
            await saveMessage(jid, msgObj, "Você");
            io.emit('new_msg', msgObj);
        } catch (e) { console.log('Erro áudio:', e); }
    });

    // Apagar Mensagem Individual
    socket.on('delete_msg', async (data) => {
        console.log(`[APAGAR] Solicitado apagar msg ${data.id} de ${data.jid}`);
        if (!sock || statusConexao !== "CONECTADO ✅") return;
        try {
            const { jid, id, fromMe } = data;
            if (fromMe) {
                await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: id } });
            }
            const chatPath = `chats.${jid}.messages`;
            const messages = db.get(chatPath).value() || [];
            await db.set(chatPath, messages.filter(m => m.id !== id)).write();
            io.emit('msg_deleted', { jid, id });
            console.log(`[APAGAR] Mensagem ${id} removida do banco.`);
        } catch (e) { console.log('Erro ao apagar msg:', e); }
    });

    // Apagar Conversa Inteira
    socket.on('delete_chat', async (jid) => {
        console.log(`[APAGAR CHAT] Deletando tudo de ${jid}`);
        try {
            await db.unset(`chats.${jid}`).write();
            io.emit('chat_deleted', jid);
        } catch (e) { console.log('Erro ao apagar chat:', e); }
    });

    // Alternar Modo de Atendimento (Manual/Automático)
    socket.on('toggle_atendimento', async (data) => {
        const { jid, atendimentoManual } = data;
        await db.set(`chats.${jid}.atendimentoManual`, atendimentoManual).write();
        io.emit('status_atendimento', { jid, atendimentoManual });
        console.log(`[ATENDIMENTO] ${jid} agora está em modo ${atendimentoManual ? 'MANUAL' : 'AUTOMÁTICO'}`);
    });
});

async function saveMessage(jid, msg, name) {
    const chatPath = `chats.${jid}`;
    if (!db.has(chatPath).value()) {
        await db.set(chatPath, { name: name, messages: [], atendimentoManual: false }).write();
    }
    await db.get(`${chatPath}.messages`).push(msg).write();
    if (name !== "Você" && name !== "Robô 🤖") {
        await db.set(`${chatPath}.name`, name).write();
    }
}

async function connectToWhatsApp() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap'), printQRInTerminal: false });
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = await QRCode.toDataURL(qr); statusConexao = "AGUARDANDO QR 📲"; io.emit('status', { status: statusConexao }); io.emit('qr', lastQr); }
            if (connection === 'open') { statusConexao = "CONECTADO ✅"; lastQr = null; io.emit('status', { status: statusConexao }); console.log('BOT PRONTO!'); }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
                statusConexao = "DESCONECTADO ❌"; io.emit('status', { status: statusConexao });
                if (statusCode === DisconnectReason.loggedOut) {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    setTimeout(connectToWhatsApp, 3000);
                } else { setTimeout(connectToWhatsApp, 5000); }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const from = jid.split('@')[0].replace(/\D/g, '');
            const pushName = msg.pushName || "Cliente";
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!text) return;

            console.log(`📩 Mensagem de ${pushName} (${from}): ${text}`);

            const msgObj = { 
                id: msg.key.id, 
                from: jid,
                text: text, 
                fromMe: false, 
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
                sender: jid, 
                pushName: pushName,
                body: text
            };

            await saveMessage(jid, msgObj, pushName);
            io.emit('new_msg', msgObj);

            // INTELIGÊNCIA DO MENU (DENTRO DO BOT PARA RESPOSTA INSTANTÂNEA)
            let reply = "";
            const lowerText = text.toLowerCase();

            if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                reply = `Olá ${pushName}! 👋 Seja bem-vindo ao *GuGA Bebidas*.

Como posso te ajudar hoje?

1️⃣ - Ver Cardápio Digital 📖
2️⃣ - Fazer um Pedido 🛒
3️⃣ - Promoções do Dia 🔥
4️⃣ - Endereço e Horário 📍
5️⃣ - Falar com o Atendente 👨‍💻

_Digite apenas o número da opção desejada._`;
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
                    await db.set(`chats.${jid}.atendimentoManual`, true).write();
                    io.emit('status_atendimento', { jid, atendimentoManual: true });
                }
            }

            if (reply) {
                const sentReply = await sock.sendMessage(jid, { text: reply });
                const replyObj = { id: sentReply.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                await saveMessage(jid, replyObj, pushName);
                io.emit('new_msg', replyObj);
            }
        });
        } catch (err) { setTimeout(connectToWhatsApp, 5000); }
}

initDB().then(() => {
    server.listen(port, () => { 
        console.log(`🚀 PAINEL: http://localhost:${port}`); 
        connectToWhatsApp(); 
    });
});

