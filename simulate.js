const http = require('http');

async function sendNotify(status, pedidoId) {
    const data = JSON.stringify({ 
        number: '115328914817201', // JID do Carlos Leonidio
        status, 
        pedidoId 
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
    const testId = 'TEST-' + Date.now();
    console.log(`\n=== INICIANDO SIMULAÇÃO PEDIDO #${testId} ===`);

    console.log('1. Enviando: saiu_entrega');
    await sendNotify('saiu_entrega', testId);
    await new Promise(r => setTimeout(r, 1000));

    console.log('2. Enviando: aguardando_fechamento (Simulando clique no ADM)');
    await sendNotify('aguardando_fechamento', testId);
    await new Promise(r => setTimeout(r, 1000));

    console.log('3. Enviando: entregue (Simulando confirmação tardia do sistema)');
    await sendNotify('entregue', testId);

    console.log('\n=== SIMULAÇÃO CONCLUÍDA ===');
}

runTest();
