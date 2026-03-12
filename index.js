const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Servidor para o Render
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot do WhatsApp está Vivo! 🚀'));
app.listen(port, () => console.log(`Servidor na porta ${port}`));

async function connectToWhatsApp() {
    console.log('Buscando versão mais recente do WhatsApp...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando versão v${version.join('.')}, isLatest: ${isLatest}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.appropriate('Desktop'), // Seleciona automaticamente a melhor identificação
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- ESCANEIE O QR CODE ---');
            qrcode.generate(qr, { small: true });
            console.log('--- AGUARDANDO ESCANEAMENTO ---');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
            console.log('Conexão fechada. Motivo:', statusCode);

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Tentando reconectar em 10 segundos...');
                setTimeout(connectToWhatsApp, 10000);
            } else {
                console.log('Sessão encerrada. Escaneie o QR de novo.');
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

connectToWhatsApp().catch(err => console.log("Erro crítico:", err));
