const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Servidor para o Render (Evita que o bot seja desligado)
const app = express();
app.get('/', (req, res) => res.send('Bot do WhatsApp está Online! 🚀'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Monitorando porta ${port}`));

async function connectToWhatsApp() {
    // Pasta onde o login será salvo (auth_info_baileys)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }) // Silencia avisos desnecessários
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // SE TIVER UM QR CODE, ELE APARECE AQUI
        if (qr) {
            console.log('\n\n--- ESCANEIE O QR CODE ABAIXO ---');
            qrcode.generate(qr, { small: true });
            console.log('--- AGUARDANDO ESCANEAMENTO ---\n\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Tentando reconectar...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('--- BOT CONECTADO COM SUCESSO! ✅ ---');
        }
    });

    // RESPOSTAS DO BOT
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

            if (text === 'oi' || text === 'olá' || text === 'menu') {
                await sock.sendMessage(from, { text: 'Olá! 👋 Seu bot no Render está funcionando!\n\n1 - Horário\n2 - Localização' });
            } else if (text === '1') {
                await sock.sendMessage(from, { text: '🕒 Horário: 08h às 18h.' });
            } else if (text === '2') {
                await sock.sendMessage(from, { text: '📍 Endereço: Rua Exemplo, 123.' });
            }
        }
    });
}

connectToWhatsApp();
