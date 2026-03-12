const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Servidor para o Render
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot do WhatsApp está Vivo! 🚀'));
app.listen(port, () => console.log(`Monitorando porta ${port}`));

async function connectToWhatsApp() {
    console.log('Iniciando conexão com o WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false, // Vamos gerenciar o QR manualmente
        browser: Browsers.macOS('Desktop'), // Identifica o bot como um computador real
        auth: state,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- ESCANEIE O QR CODE ---');
            qrcode.generate(qr, { small: true });
            console.log('--- AGUARDANDO ---');
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Conexão fechada. Motivo:', reason);

            if (reason !== DisconnectReason.loggedOut) {
                console.log('Tentando reconectar em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('Você foi desconectado. Por favor, apague a pasta auth_info_baileys e escaneie o QR de novo.');
            }
        } else if (connection === 'open') {
            console.log('--- BOT CONECTADO COM SUCESSO! ✅ ---');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

            if (text === 'oi' || text === 'olá' || text === 'menu') {
                await sock.sendMessage(from, { text: 'Olá! 👋 Bot Online no Render!\n\n1 - Horário\n2 - Localização' });
            } else if (text === '1') {
                await sock.sendMessage(from, { text: '🕒 Horário: 08h-18h.' });
            } else if (text === '2') {
                await sock.sendMessage(from, { text: '📍 Rua Exemplo, 123.' });
            }
        }
    });
}

connectToWhatsApp();
