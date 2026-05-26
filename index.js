const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');       
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {} }).write();
    const chats = db.get('chats').value();
    let changed = false;
    for (const jid in chats) {
        if (!chats[jid].name || chats[jid].name === "Voce" || chats[jid].name === "Robo") {
            chats[jid].name = jid.split('@')[0];
            changed = true;
        }
        if (chats[jid].messages) {
            const originalLen = chats[jid].messages.length;
            chats[jid].messages = chats[jid].messages.filter((m, i, a) => i === a.findIndex((t) => t.id === m.id));
            if (chats[jid].messages.length !== originalLen) changed = true;
        }
    }
    if (changed) await db.write();
    console.log('DB Cleaned');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/status', (req, res) => res.json({ status: statusConexao, qr: lastQr }));

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
        } catch (e) { console.log('Err:', e); }
    });

    socket.on('delete_chat', async (jid) => {
        if (db) {
            await db.unset(`chats.${jid}`).write();
            io.emit('chat_deleted', jid);
        }
    });
});

async function saveMessage(jid, msg, name) {
    if (jid.includes('@newsletter') || jid.includes('@broadcast')) return;
    const chatPath = `chats.${jid}`;
    if (!db.has(chatPath).value()) {
        await db.set(chatPath, { name: jid.split('@')[0], messages: [] }).write();
    }
    const msgs = db.get(`${chatPath}.messages`).value();
    if (msgs.some(m => m.id === msg.id)) return;

    await db.get(`${chatPath}.messages`).push(msg).write();
    if (name && name !== "Voce" && name !== "Robo") {
        await db.set(`${chatPath}.name`, name).write();
    }
}

async function connectToWhatsApp() {
    try {
        const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap'), printQRInTerminal: false });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); }); statusConexao = "AGUARDANDO QR"; io.emit('status', {status: statusConexao}); }
            if (connection === 'open') { statusConexao = "CONECTADO"; lastQr = null; io.emit('status', {status: statusConexao}); }
            if (connection === 'close') { setTimeout(connectToWhatsApp, 5000); statusConexao = "DESCONECTADO"; io.emit('status', {status: statusConexao}); }
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

            let reply = "";
            const lowerText = text.toLowerCase();
            if (!['1','2','3','4','5'].includes(lowerText)) {
                reply = `Ola ${pushName}! Seja bem-vindo ao GuGA Bebidas.\n\n1 - Ver Cardapio\n2 - Fazer Pedido\n3 - Promocoes\n4 - Endereco\n5 - Atendente`;
            } else {
                 if (lowerText === '1') reply = "📖 Cardapio: https://garconnexpress.vercel.app/cardapio/";
                 else if (lowerText === '4') reply = "📍 Endereco: rua democrito gracindo 132 ponta grossa";
                 else if (lowerText === '5') reply = "👨‍💻 Um momento, ja chamei um atendente!";
            }

            if (reply) {
                const s = await sock.sendMessage(jid, { text: reply });
                const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robo" };
                await saveMessage(jid, rObj, "Robo");
                io.emit('new_msg', rObj);
            }
        });
    } catch (e) { setTimeout(connectToWhatsApp, 10000); }
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
});
