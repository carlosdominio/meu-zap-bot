const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;
let lastQr = null;
let statusConexao = "DESCONECTADO ❌"; // Variável para controlar o status

app.get('/qr', (req, res) => {
    if (lastQr) {
        res.setHeader('Content-Type', 'image/png');
        QRCode.toBuffer(lastQr).then(buffer => res.send(buffer));
    } else {
        res.send(`Status: ${statusConexao}. Se estiver conectado, não há QR Code.`);
    }
});

app.get('/', (req, res) => res.send(`O Bot está: ${statusConexao} 🚀`));
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
            lastQr = qr;
            statusConexao = "AGUARDANDO QR 📲";
            console.log('\n#########################################');
            console.log('#   STATUS: AGUARDANDO ESCANEAMENTO 📲   #');
            console.log('#   Acesse: /qr para ver a imagem       #');
            console.log('#########################################\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            lastQr = null;
            statusConexao = "DESCONECTADO ❌";
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log('\n#########################################');
            console.log(`#   STATUS: CONEXÃO FECHADA ❌          #`);
            console.log(`#   MOTIVO: ${statusCode}                 #`);
            console.log('#########################################\n');

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Tentando reconectar em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('SESSÃO ENCERRADA DEFINITIVAMENTE. ESCANEIE DE NOVO.');
            }
        } else if (connection === 'open') {
            lastQr = null;
            statusConexao = "CONECTADO ✅";
            console.log('\n#########################################');
            console.log('#   STATUS: BOT CONECTADO COM SUCESSO! ✅ #');
            console.log('#   PRONTO PARA RECEBER MENSAGENS       #');
            console.log('#########################################\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const from = msg.key.remoteJid;
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

            if (text === 'oi' || text === 'olá' || text === 'menu') {
                await sock.sendMessage(from, { text: 'Olá! 👋 Seu bot no Render está online!\n\n1 - Horário\n2 - Localização' });
            } else if (text === '1') {
                await sock.sendMessage(from, { text: '🕒 Horário: 08h às 18h.' });
            } else if (text === '2') {
                await sock.sendMessage(from, { text: '📍 Endereço: Rua Exemplo, 123.' });
            }
        }
    });
}

connectToWhatsApp();
