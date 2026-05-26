const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');       
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Banco de dados local (ASSÍNCRONO)
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {} }).write();
    
    // LIMPEZA AO INICIAR: Remove "Você" ou "Robô" dos nomes das conversas
    const chats = db.get('chats').value();
    let changed = false;
    for (const jid in chats) {
        if (chats[jid].name === "Você" || chats[jid].name === "Robô 🤖" || !chats[jid].name) {
            chats[jid].name = jid.split('@')[0];
            changed = true;
        }
        // Remove duplicatas
        const originalLen = chats[jid].messages.length;
        chats[jid].messages = chats[jid].messages.filter((m, i, a) => i === a.findIndex((t) => t.id === m.id));
        if (chats[jid].messages.length !== originalLen) changed = true;
    }
    if (changed) await db.write();
    console.log('Banco de dados higienizado ✅');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/status', (req, res) => res.json({ status: statusConexao, qr: lastQr }));

let lastQr = null;
let statusConexao = "DESCONECTADO ❌";
let sock = null;

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) socket.emit('history', db.get('chats').value());

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
        } catch (e) { console.log('Erro envio:', e); }
    });

    socket.on('toggle_atendimento', async (data) => {
        await db.set(`chats.${data.jid}.atendimentoManual`, data.atendimentoManual).write();
        io.emit('status_atendimento', data);
    });

    socket.on('delete_chat', async (jid) => {
        await db.unset(`chats.${jid}`).write();
        io.emit('chat_deleted', jid);
    });
});

async function saveMessage(jid, msg, name) {
    if (jid.includes('@newsletter') || jid.includes('@broadcast')) return;
    const chatPath = `chats.${jid}`;
    if (!db.has(chatPath).value()) {
        await db.set(chatPath, { name: jid.split('@')[0], messages: [], atendimentoManual: false }).write();
    }
    const msgs = db.get(`${chatPath}.messages`).value();
    if (msgs.some(m => m.id === msg.id)) return;

    await db.get(`${chatPath}.messages`).push(msg).write();
    
    // Atualiza nome apenas se NÃO for genérico
    if (name && name !== "Você" && name !== "Robô 🤖") {
        await db.set(`${chatPath}.name`, name).write();
    }
}

async function connectToWhatsApp() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap') });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); }); statusConexao = "AGUARDANDO QR 📲"; io.emit('status', {status: statusConexao}); }
        if (connection === 'open') { statusConexao = "CONECTADO ✅"; lastQr = null; io.emit('status', {status: statusConexao}); }
        if (connection === 'close') { setTimeout(connectToWhatsApp, 5000); }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const pushName = msg.pushName || jid.split('@')[0];
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        const msgObj = { id: msg.key.id, from: jid, text, fromMe: false, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName };
        await saveMessage(jid, msgObj, pushName);
        io.emit('new_msg', msgObj);

        const chat = db.get(`chats.${jid}`).value();
        if (chat?.atendimentoManual) return;

        // Resposta do Robô
        let reply = "";
        if (!['1','2','3','4','5'].includes(text.toLowerCase())) {
            reply = `Olá ${pushName}! 👋 Bem-vindo.\n\n1️⃣ - Cardápio\n2️⃣ - Pedido\n3️⃣ - Promoções\n4️⃣ - Endereço\n5️⃣ - Atendente`;
        } else {
             if (text === '1') reply = "📖 Cardápio: https://garconnexpress.vercel.app/cardapio/";
             else if (text === '4') reply = "🏠 Rua Democrito Gracindo 132";
             else if (text === '5') {
                 reply = "👨‍💻 Aguarde um momento...";
                 await db.set(`chats.${jid}.atendimentoManual`, true).write();
                 io.emit('status_atendimento', { jid, atendimentoManual: true });
             }
        }

        if (reply) {
            const s = await sock.sendMessage(jid, { text: reply });
            const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
            await saveMessage(jid, rObj, "Robô 🤖");
            io.emit('new_msg', rObj);
        }
    });
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
});
