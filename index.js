const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');

// Cria um mini servidor para o Render não desligar o bot
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot do WhatsApp está Online! 🚀'));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));

wppconnect
  .create({
    session: 'sessionName',
    puppeteerOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // Necessário para rodar em servidores Linux (Nuvem)
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

        // LÓGICA DO MENU DE OPÇÕES
        if (text === 'oi' || text === 'olá' || text === 'menu') {
          await client.sendText(message.from, 
            'Olá! 👋 Eu sou o seu Assistente Virtual.\n\n' +
            'Como posso te ajudar hoje? Digite o número da opção:\n\n' +
            '1️⃣ - Horário de Atendimento\n' +
            '2️⃣ - Localização da Loja\n' +
            '3️⃣ - Falar com um Humano\n' +
            '0️⃣ - Voltar ao Menu'
          );
        } 
        else if (text === '1') {
          await client.sendText(message.from, '🕒 Nosso horário é de Segunda a Sexta, das 08h às 18h.');
        }
        else if (text === '2') {
          await client.sendText(message.from, '📍 Estamos localizados na Rua Exemplo, 123 - Centro.');
        }
        else if (text === '3') {
          await client.sendText(message.from, '👨‍💻 Entendido! Vou encaminhar sua conversa para um atendente. Aguarde um momento...');
        }
      }
    });
  })
  .catch((error) => console.log(error));
