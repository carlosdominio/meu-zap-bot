const fetch = require('node-fetch');

// Configurações do teste
const SERVER_URL = 'http://localhost:3002/api/notify-delivery';
const TEST_PEDIDO_ID = '1281'; // ID que existe no seu db.json conforme vimos
const TEST_STATUS = 'saiu_entrega';

async function testNotification() {
    console.log(`🚀 Iniciando teste de notificação para o Pedido #${TEST_PEDIDO_ID}...`);
    
    const payload = {
        pedidoId: TEST_PEDIDO_ID,
        status: TEST_STATUS,
        number: '5582993225452' // Número opcional, o servidor deve priorizar a busca pelo ID
    };

    try {
        const response = await fetch(SERVER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            console.log('✅ Sucesso!');
            console.log('Respostas do Servidor:', data);
        } else {
            console.log('❌ Falha no teste.');
            console.log('Status:', response.status);
            console.log('Erro:', data);
        }
    } catch (error) {
        console.error('❌ Erro ao conectar com o servidor:', error.message);
        console.log('Certifique-se de que o servidor (node index.js) está rodando na porta 3002.');
    }
}

testNotification();
