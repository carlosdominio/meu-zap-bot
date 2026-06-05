const http = require('http');

const data = JSON.stringify({
  number: '5582993225452',
  status: 'recebido',
  pedidoId: '9999',
  tempo: '30-50 min'
});

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

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', e => console.error('Erro:', e.message));
req.write(data);
req.end();
