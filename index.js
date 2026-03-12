const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot do WhatsApp está Online! 🚀'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));

wppconnect
  .create({
    session: 'sessionName',
    puppeteerOptions: {
      userDataDir: path.join(__dirname, 'tokens', 'sessionName'),
      executablePath: process.env.CHROME_PATH || null, // Tenta usar o caminho do servidor se disponível
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Economiza memória no plano gratuito do Render
        '--disable-gpu'
      ],
    },
    catchQR: (base64Qr, asciiQR) => {
      console.log('Escaneie o QR Code abaixo:');
      console.log(asciiQR);
    },
  })
  .then((client) => {
    console.log('Bot conectado com sucesso!');
    client.onMessage(async (message) => {
      if (message.isGroupMsg === false) {
        const text = message.body.toLowerCase();
        if (text === 'oi' || text === 'olá' || text === 'menu') {
          await client.sendText(message.from, 'Olá! 👋 Bot Online no Render! Digite 1 para Horário ou 2 para Localização.');
        } else if (text === '1') {
          await client.sendText(message.from, '🕒 Segunda a Sexta: 08h-18h.');
        } else if (text === '2') {
          await client.sendText(message.from, '📍 Rua Exemplo, 123.');
        }
      }
    });
  })
  .catch((err) => console.log('Erro ao iniciar bot:', err));
