const http = require('http');

async function sendNotify(status, pedidoId) {
    const data = JSON.stringify({ 
        number: '115328914817201', // Usando um ID que existe no db.json
        status, 
        pedidoId 
    });

    const options = {
        hostname: 'localhost',
        port: 3004,
        path: '/api/notify-delivery',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    return new Promise((resolve) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', e => resolve({ error: e.message }));
        req.write(data);
        req.end();
    });
}

async function runTest() {
    console.log('--- TESTE: STATUS ENTREGUE ---');
    const r1 = await sendNotify('entregue', '361');
    console.log('Result 1:', r1);

    setTimeout(async () => {
        console.log('\n--- TESTE: STATUS FINALIZADO ---');
        const r2 = await sendNotify('finalizado', '361');
        console.log('Result 2:', r2);
    }, 2000);
}

runTest();
