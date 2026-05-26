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
    
    // --- LIMPEZA DE BANCO CORROMPIDO (Correção Automática de Nomes e Duplicados) ---
    const chats = db.get('chats').value();
    let changed = false;
    for (const jid in chats) {
        // 1. Corrige nomes genéricos
        if (chats[jid].name === "Você" || chats[jid].name === "Robô 🤖" || !chats[jid].name) {
            const msgs = chats[jid].messages || [];
            const lastClientMsg = [...msgs].reverse().find(m => !m.fromMe && m.pushName && m.pushName !== "Você" && m.pushName !== "Robô 🤖");
            chats[jid].name = lastClientMsg ? lastClientMsg.pushName : jid.split('@')[0];
            changed = true;
        }
        // 2. Remove duplicatas de mensagens pelo ID
        const originalCount = chats[jid].messages.length;
        chats[jid].messages = chats[jid].messages.filter((msg, index, self) =>
            index === self.findIndex((m) => m.id === msg.id)
        );
        if (chats[jid].messages.length !== originalCount) changed = true;
    }
    if (changed) await db.write();
    console.log('Banco de dados carregado e limpo 📦');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });
const port = process.env.PORT || 3000;

let lastQr = null;
let statusConexao = "DESCONECTADO ❌";
let sock = null;

app.use(express.static('public'));
app.get('/status', (req, res) => res.json({ status: statusConexao, qr: lastQr }));

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);

    // Enviar histórico ao conectar
    if (db) {
        socket.emit('history', db.get('chats').value());
    }

    // Enviar Mensagem de Texto
    socket.on('send_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO ✅") return;
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
                pushName: "Você" 
            };
            await saveMessage(jid, msgObj, "Você");
            io.emit('new_msg', msgObj);
        } catch (e) { console.log('Erro ao enviar:', e); }
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
        } catch (e) { console.log('Erro ao apagar msg:', e); }
    });

    // Apagar Conversa Inteira
    socket.on('delete_chat', async (jid) => {
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
    });

    socket.on('ping', (cb) => { if (typeof cb === 'function') cb(); });
});

async function saveMessage(jid, msg, name) {
    // IGNORAR CANAIS, NEWSLETTERS E STATUS
    if (jid.includes('@newsletter') || jid.includes('@broadcast') || jid === 'status@broadcast') return;

    const chatPath = `chats.${jid}`;
    if (!db.has(chatPath).value()) {
        let initialName = (name === "Robô 🤖" || name === "Você" || !name) ? jid.split('@')[0] : name;
        await db.set(chatPath, { name: initialName, messages: [], atendimentoManual: false }).write();
    }

    // EVITAR DUPLICATAS
    const messages = db.get(`${chatPath}.messages`).value() || [];
    if (messages.some(m => m.id === msg.id)) return;

    await db.get(`${chatPath}.messages`).push(msg).write();

    // SÓ ATUALIZA O NOME SE FOR UM NOME REAL (não sobrescreve com Você/Robô)
    if (name && name !== "Você" && name !== "Robô 🤖") {
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
                statusConexao = "DESCONECTADO ❌";
                io.emit('status', { status: statusConexao });
                if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 5000);
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            if (jid.includes('@newsletter') || jid.includes('@broadcast') || jid === 'status@broadcast') return;

            const from = jid.split('@')[0].replace(/\D/g, '');
            const pushName = msg.pushName || from; 
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!text) return;

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

            const chat = db.get(`chats.${jid}`).value();
            if (chat && chat.atendimentoManual) return;

            // MENU
            let reply = "";
            const lowerText = text.toLowerCase();
            if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                reply = `Olá ${pushName}! 👋 Seja bem-vindo ao *GuGA Bebidas*.\n\nComo posso te ajudar hoje?\n\n1️⃣ - Ver Cardápio Digital 📖\n2️⃣ - Fazer um Pedido 🛒\n3️⃣ - Promoções do Dia 🔥\n4️⃣ - Endereço e Horário 📍\n5️⃣ - Falar com o Atendente 👨‍💻\n\n_Digite apenas o número da opção desejada._`;
            } else {
                if (lowerText === '1') reply = "📖 *CARDÁDIO DIGITAL*\n\nhttps://garconnexpress.vercel.app/cardapio/";
                else if (lowerText === '2') reply = "🛒 *COMO FAZER UM PEDIDO*\n\nVeja o cardápio e nos mande o que deseja!";
                else if (lowerText === '3') reply = "🔥 *PROMOÇÕES DO DIA*\n\nVeja no cardápio digital!";
                else if (lowerText === '4') reply = "📍 *ENDEREÇO E HORÁRIO*\n\n🏠 rua democrito gracindo 132 ponta grossa\n⏰ Diariamente das 18h às 02:00";
                else if (lowerText === '5') {
                    reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nAguarde um momento...";
                    await db.set(`chats.${jid}.atendimentoManual`, true).write();
                    io.emit('status_atendimento', { jid, atendimentoManual: true });
                }
            }

            if (reply) {
                const sentReply = await sock.sendMessage(jid, { text: reply });
                const replyObj = { id: sentReply.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                await saveMessage(jid, replyObj, "Robô 🤖");
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
