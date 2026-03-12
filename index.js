const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Servidor para o Render
const app = express();
app.get('/', (req, res) => res.send('Bot Online! 🚀'));
app.listen(process.env.PORT || 3000);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Mostra o QR Code nos logs do Render
        logger: pino({ level: 'silent' }) // Deixa os logs limpos
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('--- ESCANEIE ESTE QR CODE ---');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('BOT CONECTADO COM SUCESSO! ✅');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

            // MENU DE OPÇÕES
            if (text === 'oi' || text === 'olá' || text === 'menu') {
                await sock.sendMessage(from, { text: 'Olá! 👋 Sou seu Bot no Render.\n\n1 - Horário\n2 - Localização' });
            } else if (text === '1') {
                await sock.sendMessage(from, { text: '🕒 Atendimento: 08h-18h.' });
            } else if (text === '2') {
                await sock.sendMessage(from, { text: '📍 Endereço: Rua Exemplo, 123.' });
            }
        }
    });
}

connectToWhatsApp();
