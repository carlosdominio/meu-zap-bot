const http = require('http');

const number = '5582993225452';
const status = 'recebido';
const pedidoId = '1209';

const data = JSON.stringify({ number, status, pedidoId, tempo: '30-50 min' });

const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/api/notify-delivery',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

console.log('Simulando notificação do servidor para pedido #' + pedidoId);
console.log('Payload:', data);

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status HTTP:', res.statusCode);
    console.log('Resposta:', body);
  });
});

req.on('error', e => console.error('Erro na requisição:', e.message));
req.write(data);
req.end();
