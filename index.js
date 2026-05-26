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
            const pushName = msg.pushName || "Cliente";
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (!text) return;

            console.log(`📩 Mensagem de ${pushName} (${jid}): ${text}`);

            const msgObj = { 
                id: msg.key.id, 
                from: jid,
                text: text, 
                fromMe: false, 
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
                sender: jid, 
                pushName: pushName,
                body: text // Compatibilidade com server.js
            };

            await saveMessage(jid, msgObj, pushName);
            // EMITE para o server.js processar a inteligência do menu
            io.emit('new_msg', msgObj);
        });
        } catch (err) { setTimeout(connectToWhatsApp, 5000); }
}

initDB().then(() => {
    server.listen(port, () => { 
        console.log(`🚀 PAINEL: http://localhost:${port}`); 
        connectToWhatsApp(); 
    });
});

