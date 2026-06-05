const http = require('http');

const lid = '115328914817201';

const data = JSON.stringify({ number: lid, status: 'recebido', pedidoId: '1217', tempo: '30-50 min' });

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

console.log('Testando com LID: ' + lid);
const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('HTTP Status:', res.statusCode, 'Body:', body));
});

req.on('error', e => console.error('Erro:', e.message));
req.write(data);
req.end();
