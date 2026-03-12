const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode'); // Nova biblioteca para gerar imagem
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;
let lastQr = null; // Guarda o último QR gerado

// Rota para ver o QR Code como imagem no navegador
app.get('/qr', (req, res) => {
    if (lastQr) {
        res.setHeader('Content-Type', 'image/png');
        QRCode.toBuffer(lastQr).then(buffer => res.send(buffer));
    } else {
        res.send('QR Code ainda não gerado ou bot já conectado. Verifique os logs.');
    }
});

app.get('/', (req, res) => res.send('Bot Online! Acesse /qr para escanear o código.'));
app.listen(port, () => console.log(`Servidor na porta ${port}`));

async function connectToWhatsApp() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.appropriate('Desktop'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQr = qr; // Salva o QR para a rota /qr
            console.log('\n--- NOVO QR CODE GERADO ---');
            console.log('Acesse o link abaixo para escanear:');
            console.log(`https://meu-zap-bot.onrender.com/qr`);
            console.log('---------------------------\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            lastQr = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            lastQr = null;
            console.log('--- BOT CONECTADO COM SUCESSO! ✅ ---');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

            if (text === 'oi' || text === 'olá' || text === 'menu') {
                await sock.sendMessage(from, { text: 'Olá! 👋 Bot Online!\n\n1 - Horário\n2 - Localização' });
            } else if (text === '1') {
                await sock.sendMessage(from, { text: '🕒 Horário: 08h-18h.' });
            } else if (text === '2') {
                await sock.sendMessage(from, { text: '📍 Endereço: Rua Exemplo, 123.' });
            }
        }
    });
}

connectToWhatsApp();
