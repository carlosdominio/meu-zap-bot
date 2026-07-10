const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');  
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// ─── PostgreSQL para sessão do WhatsApp ───────────────────────────────────────
const { Pool } = require('pg');
const pgPool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

async function usePostgresAuthState() {
    const { initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys');

    // Fallback para arquivo local se DATABASE_URL não estiver configurada
    if (!pgPool) {
        const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
        console.log('⚠️ [Auth] DATABASE_URL não configurada. Usando auth_info_baileys local.');
        return useMultiFileAuthState('auth_info_baileys');
    }

    // Cria tabela se não existir
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS zap_session (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);

    const readData = async (id) => {
        try {
            const res = await pgPool.query('SELECT value FROM zap_session WHERE id = $1', [id]);
            if (res.rows.length === 0) return null;
            return JSON.parse(res.rows[0].value, BufferJSON.reviver);
        } catch (e) { return null; }
    };

    const writeData = async (id, data) => {
        try {
            const value = JSON.stringify(data, BufferJSON.replacer);
            await pgPool.query(
                'INSERT INTO zap_session (id, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET value = $2, updated_at = NOW()',
                [id, value]
            );
        } catch (e) { console.error(`❌ [PostgreSQL] Erro ao salvar ${id}:`, e.message); }
    };

    const removeData = async (id) => {
        try {
            await pgPool.query('DELETE FROM zap_session WHERE id = $1', [id]);
        } catch (e) { console.error(`❌ [PostgreSQL] Erro ao remover ${id}:`, e.message); }
    };

    const credsData = await readData('creds') || initAuthCreds();

    const state = {
        creds: credsData,
        keys: {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(ids.map(async (id) => {
                    let value = await readData(`${type}-${id}`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }));
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];
                        tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`));
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    const saveCreds = () => writeData('creds', state.creds);
    console.log('✅ [PostgreSQL] Sessão do WhatsApp carregada do banco!');
    return { state, saveCreds };
}

async function clearPostgresSession() {
    if (!pgPool) return;
    try {
        await pgPool.query('DELETE FROM zap_session');
        console.log('🗑️ [PostgreSQL] Sessão apagada do banco.');
    } catch (e) { console.error('❌ Erro ao apagar sessão:', e.message); }
}

// Banco de dados local
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {}, pedidoIdToJid: {}, settings: { caixaFechado: 'aberto' }, lastNotifications: {}, surveysSent: {} }).write();
    console.log('✅ Banco de dados pronto');
}

const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

const port = process.env.PORT || 3002;
const getFormattedTime = (date = new Date()) => {
    return (date instanceof Date ? date : new Date(date)).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
};
const DELIVERY_API_URL = process.env.DELIVERY_API_URL || 'https://garconnexpress.vercel.app/api/pedidos';

app.get('/qr', (req, res) => {
    if (statusConexao === 'CONECTADO') {
        res.send('<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;"> <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;"> <h1 style="color:#075e54;">✅ Bot Conectado!</h1> <p style="color:#555;">O robô já está operando normalmente.</p> </div> </body></html>');
    } else if (lastQr) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;margin:0;">
                    <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
                        <h2 style="color:#075e54;margin-bottom:20px;">📸 Escaneie para Conectar</h2>
                        <div style="background:#eee;padding:20px;border-radius:10px;display:inline-block;">
                            <img src="${lastQr}" style="width:300px;height:300px;display:block;" />
                        </div>
                        <p style="margin-top:20px;color:#666;">Status: <strong style="color:#25d366;">${statusConexao}</strong></p>
                        <p style="font-size:12px;color:#999;">A página atualiza sozinha a cada 5 segundos.</p>
                    </div>
                    <script>setTimeout(() => { location.reload(); }, 5000);</script>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;"> <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;"> <h2 style="color:#075e54;">⏳ Gerando QR Code...</h2> <p style="color:#666;">Aguarde alguns segundos e a página irá carregar o código.</p> </div> <script>setTimeout(() => { location.reload(); }, 3000);</script> </body></html>');
    }
});

const INACTIVITY_THRESHOLD = 15 * 60 * 1000; // 15 minutos
const CHAT_EXPIRY_THRESHOLD = 24 * 60 * 60 * 1000; // 24 horas

async function cleanupOldChats() {
    if (!db) return;
    const chats = db.get('chats').value() || {};
    const now = Date.now();
    let changed = false;

    for (const jid in chats) {
        // Exceção: Não apaga notificações de sistema ou chats fixados
        if (chats[jid].isSystemNotification || chats[jid].isPinned) {
            continue;
        }

        if (chats[jid].lastUpdate && (now - chats[jid].lastUpdate) >= CHAT_EXPIRY_THRESHOLD) {
            console.log(`🧹 [Cleanup] Removendo chat inativo há mais de 24h: ${jid}`);
            delete chats[jid];
            changed = true;
            io.emit('chat_deleted', jid);
        }
    }

    if (changed) {
        await db.set('chats', { ...chats }).write();
    }
}

async function checkInactivity() {
    if (!db || !sock || statusConexao !== 'CONECTADO') return;

    const chats = db.get('chats').value() || {};
    const now = Date.now();
    let changed = false;

    for (const jid in chats) {
        const chat = chats[jid];
        if (chat.atendimentoManual && (now - chat.lastUpdate) >= INACTIVITY_THRESHOLD) {
            console.log(`⏰ [Timeout] Encerrando atendimento manual para ${jid} por inatividade.`);
            chat.atendimentoManual = false;
            changed = true;

            // Notifica o painel
            io.emit('status_atendimento', { jid, atendimentoManual: false });

            // Envia mensagem ao cliente
            const timeoutMsg = "Seu atendimento foi encerrado devido à inatividade. O assistente virtual voltou a operar. Se precisar de algo, é só mandar mensagem novamente! 🤖";
            try {
                const s = await sendHumanizedMessage(jid, { text: timeoutMsg });
                const rObj = { 
                    id: s?.key?.id || ('timeout-' + Date.now()), 
                    text: timeoutMsg, 
                    fromMe: true, 
                    time: getFormattedTime(), 
                    sender: sock.user.id, 
                    pushName: 'Robô 🤖' 
                };
                // Atualiza o histórico local
                if (!chat.messages) chat.messages = [];
                chat.messages.push(rObj);
                if (chat.messages.length > 100) chat.messages.shift();
                io.emit('new_msg', rObj);
            } catch (e) {
                console.error(`❌ Erro ao enviar mensagem de timeout para ${jid}:`, e);
            }
        }
    }

    if (changed) {
        await db.set('chats', chats).write();
    }
}

app.use(express.static('public'));
app.get('/health', (req, res) => res.send('OK'));
app.get('/status', (req, res) => res.json({ status: statusConexao }));

// ROTA PARA NOTIFICAÇÕES DE STATUS DE DELIVERY
app.post('/api/notify-delivery', async (req, res) => {
    let { number, status, pedidoId } = req.body;
    
    // 1. Normalização de dados
    status = String(status || '').toLowerCase().trim();
    pedidoId = String(pedidoId || '').trim();
    
    console.log(`📦 [Delivery] Nova notificação: Pedido=#${pedidoId}, Status=${status}`);

    if (!pedidoId) return res.status(400).json({ error: 'pedidoId é obrigatório' });

    const chats = db ? db.get('chats').value() || {} : {};
    let jid = number;
    if (jid && !jid.includes('@')) {
        const cleanNumber = jid.replace(/\D/g, '');
        const existingJid = Object.keys(chats).find(k => k.startsWith(cleanNumber));
        jid = existingJid || (cleanNumber + '@s.whatsapp.net');
    }

    let targetJid = jid;

    // 2. Busca robusta pelo JID
    if (db) {
        const mapping = db.get('pedidoIdToJid').value() || {};
        if (mapping[pedidoId] && mapping[pedidoId] !== 'undefined') {
            targetJid = mapping[pedidoId];
        } else {
            const foundJid = Object.keys(chats).find(k => 
                String(chats[k].activePedidoId) === pedidoId || 
                String(chats[k].ultimoPedidoId) === pedidoId
            );
            if (foundJid) targetJid = foundJid;
        }
        
        if ((!targetJid || targetJid === 'undefined') && jid) targetJid = jid;

        if (targetJid && targetJid !== 'undefined') {
            mapping[pedidoId] = targetJid;
            await db.set('pedidoIdToJid', mapping).write();
        }
    }

    if (!targetJid || targetJid === 'undefined') return res.status(404).json({ error: 'JID não encontrado' });

    // 3. Categorias e Deduplicação (Apenas Verificação Inicial)
    let currentCat = null;
    if (db) {
        const lastNotifCategory = db.get('lastNotifications').value() || {};
        const categories = {
            'recebido': 'RECEBIDO', 'preparando': 'PREPARANDO', 'pronto': 'PRONTO', 
            'saiu_entrega': 'SAIU_ENTREGA', 'entregue': 'ENTREGUE', 'servido': 'ENTREGUE',
            'concluido': 'FINALIZADO', 'finalizado': 'FINALIZADO', 'concluído': 'FINALIZADO', 'concluida': 'FINALIZADO', 'concluída': 'FINALIZADO', 'finalizada': 'FINALIZADO', 'pago': 'FINALIZADO', 'encerrado': 'FINALIZADO', 'fechado': 'FINALIZADO', 'aguardando_fechamento': 'FINALIZADO', 'cancelado': 'CANCELADO'
        };
        currentCat = categories[status];
        
        const sentCat = lastNotifCategory[pedidoId];

        // 1. Se já enviamos ESTA mesma categoria, ignoramos duplicata
        if (currentCat && sentCat === currentCat) {
            console.log(`⚠️ [Delivery] Categoria ${currentCat} já enviada para Pedido #${pedidoId}. Ignorando duplicata.`);
            return res.json({ success: true, info: 'Categoria já enviada' });
        }

        // 2. Se já finalizamos o pedido, ignoramos qualquer notificação de entrega que chegar depois
        if (currentCat === 'ENTREGUE' && sentCat === 'FINALIZADO') {
            console.log(`⚠️ [Delivery] Pedido #${pedidoId} já está FINALIZADO. Ignorando notificação de ENTREGA tardia.`);
            return res.json({ success: true, info: 'Pedido já finalizado' });
        }
    }

    const statusMessages = {
        'recebido': 'foi recebido com sucesso! 📝',
        'preparando': 'está sendo preparado! 👨‍🍳🔥',
        'pronto': 'já está PRONTO! 🥡✨',
        'saiu_entrega': 'acaba de SAIR PARA ENTREGA! 🛵💨',
        'entregue': 'foi ENTREGUE! 😋🥤',
        'servido': 'foi ENTREGUE! 😋🥤',
        'concluido': 'foi FINALIZADO com sucesso! 🌟',
        'concluído': 'foi FINALIZADO com sucesso! 🌟',
        'finalizado': 'foi FINALIZADO com sucesso! 🌟',
        'finalizada': 'foi FINALIZADO com sucesso! 🌟',
        'concluida': 'foi FINALIZADO com sucesso! 🌟',
        'concluída': 'foi FINALIZADO com sucesso! 🌟',
        'pago': 'foi FINALIZADO com sucesso! 🌟',
        'encerrado': 'foi FINALIZADO com sucesso! 🌟',
        'fechado': 'foi FINALIZADO com sucesso! 🌟',
        'aguardando_fechamento': 'foi FINALIZADO com sucesso! 🌟',
        'cancelado': 'foi CANCELADO. ❌'
    };

    const chatData = chats[targetJid] || {};
    const clientName = (chatData.name && chatData.name !== targetJid.split('@')[0]) ? chatData.name : 'cliente';
    
    // Lista de status que disparam o template de ENTREGA
    const isEntregueStatus = ['entregue', 'servido'].includes(status);
    
    // Lista de status que disparam o template de FINALIZAÇÃO
    const isFinalizedStatus = ['entregue', 'servido', 'concluido', 'finalizado', 'concluído', 'concluida', 'concluída', 'finalizada', 'pago', 'encerrado', 'fechado', 'aguardando_fechamento'].includes(status);

    if (status === 'recebido') return res.json({ success: true, info: 'Recebimento silenciado' });

    if (!sock || statusConexao !== 'CONECTADO') {
        console.error(`❌ [Delivery] Erro: Bot está ${statusConexao}. Não foi possível enviar para o Pedido #${pedidoId}`);
        return res.status(503).json({ error: 'Bot offline' });
    }

    try {
        // --- SEQUENCE PROTECTOR: Se for FINALIZAR mas não enviamos o ENTREGUE, envia agora primeiro ---
        if (db && isFinalizedStatus && !isEntregueStatus) {
            const lastNotifCategory = db.get('lastNotifications').value() || {};
            if (lastNotifCategory[pedidoId] !== 'ENTREGUE' && lastNotifCategory[pedidoId] !== 'FINALIZADO') {
                console.log(`⚡ [Sequence] Forçando mensagem de ENTREGA antes da FINALIZAÇÃO para Pedido #${pedidoId}`);
                const forceDeliveryMsg = `Olá, ${clientName}! 👋\n\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\n\nInformamos que seu pedido foi ENTREGUE! 🎉\nEsperamos que aproveite muito. Bom apetite! 😋🥤\n\nAtenciosamente,\nEquipe GuGA Bebidas 🍻`;
                await sendHumanizedMessage(targetJid, { text: forceDeliveryMsg });

                const dObj = { id: 'f-' + Date.now(), text: forceDeliveryMsg, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: 'Robô 🤖' };
                await saveMessage(targetJid, dObj, 'Robo');
                io.emit('new_msg', dObj);

                lastNotifCategory[pedidoId] = 'ENTREGUE';
                await db.set('lastNotifications', lastNotifCategory).write();
                await new Promise(r => setTimeout(r, 2500)); // Pausa para garantir ordem no Zap
            }
        }

        let message = "";
        if (isEntregueStatus) {
            message = `Olá, ${clientName}! 👋\n\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\n\nInformamos que seu pedido foi ENTREGUE! 🎉\nEsperamos que aproveite muito. Bom apetite! 😋🥤\n\nAtenciosamente,\nEquipe GuGA Bebidas 🍻`;
        } else if (isFinalizedStatus) {
            message = `Olá, ${clientName}! 👋\n\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\n\n✅ PEDIDO FINALIZADO COM SUCESSO!\n\nAgradecemos imensamente pela sua preferência. Esperamos que sua experiência tenha sido excelente e que você aproveite cada detalhe! 😋🥤\n\nAtenciosamente,\nEquipe GuGA Bebidas 🍻`;
        } else {
            const statusText = statusMessages[status] || `está com o status: ${status}`;
            message = `Olá ${clientName}! 👋\n\n🔔 *ATUALIZAÇÃO DO PEDIDO #${pedidoId}*\n\nInformamos que seu pedido ${statusText}\n\nAtenciosamente,\n*Equipe GuGA Bebidas* 🍻`;
        }

        console.log(`🚀 [Delivery] Enviando mensagem de "${status}" para ${targetJid} (Pedido #${pedidoId})...`);
        const s = await sendHumanizedMessage(targetJid, { text: message });

        // --- SÓ SALVA A CATEGORIA NO BANCO SE O ENVIO FUNCIONOU ---
        if (db && currentCat) {
            const lastNotifCategory = db.get('lastNotifications').value() || {};
            lastNotifCategory[pedidoId] = currentCat;
            await db.set('lastNotifications', lastNotifCategory).write();
        }

        const rObj = { id: s.key.id, text: message, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: 'Robô 🤖' };
        await saveMessage(targetJid, rObj, 'Robo');
        io.emit('new_msg', rObj);
        console.log(`✅ [Delivery] Mensagem enviada com sucesso para Pedido #${pedidoId}`);

        if (db) {
            if (!chats[targetJid]) chats[targetJid] = { name: targetJid.split('@')[0], messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'delivery', activePedidoId: pedidoId };
            chats[targetJid].ultimoPedidoId = pedidoId;

            // Um pedido só é considerado TERMINAL quando é FINALIZADO ou CANCELADO
            const isTerminalStatus = isFinalizedStatus || status === 'cancelado';

            if (isTerminalStatus) {
                console.log(`✅ [Bot] Pedido #${pedidoId} atingiu status terminal (${status}).`);
                chats[targetJid].estado = 'normal';
                chats[targetJid].activePedidoId = null;
            } else {
                // Status intermediários (Recebido, Preparando, Pronto, A caminho, Entregue) mantêm o modo delivery
                chats[targetJid].estado = 'delivery';
                chats[targetJid].activePedidoId = pedidoId;
            }
            await db.set('chats', chats).write();

            const mapping = db.get('pedidoIdToJid').value() || {};
            mapping[String(pedidoId)] = targetJid;
            await db.set('pedidoIdToJid', mapping).write();
        }
        if (isFinalizedStatus) {
            const surveysSent = db.get('surveysSent').value() || {};
            if (surveysSent[pedidoId]) {
                console.log(`⚠️ [Survey] Pesquisa já enviada anteriormente para Pedido #${pedidoId}.`);
                return res.json({ success: true, info: 'Pesquisa já enviada' });
            }
            surveysSent[pedidoId] = true;
            await db.set('surveysSent', surveysSent).write();

            console.log(`⏳ [Survey] Agendando pesquisa para Pedido #${pedidoId} em 8 segundos...`);
            setTimeout(async () => {
                if (!sock || statusConexao !== 'CONECTADO') return;
                const surveyMessage = `Sua opinião é muito importante para nós! ⭐\n\nComo foi sua experiência com nosso atendimento e entrega?\n\nResponda com uma nota de *1 a 5*:\n\n1️⃣ - Muito Insatisfeito\n2️⃣ - Insatisfeito\n3️⃣ - Regular\n4️⃣ - Satisfeito\n5️⃣ - Muito Satisfeito\n\nAtenciosamente,\nEquipe GuGA Bebidas 🍻`;
                try {
                    const s2 = await sendHumanizedMessage(targetJid, { text: surveyMessage });
                    if (s2) {
                        // Ativa a flag de que há uma pesquisa aguardando resposta
                        if (db) {
                            const chatsDB = db.get('chats').value() || {};
                            if (chatsDB[targetJid]) {
                                chatsDB[targetJid].surveyPending = true;
                                await db.set('chats', chatsDB).write();
                            }
                        }
                        const rObj2 = { id: s2.key.id, text: surveyMessage, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: 'Robô 🤖' };
                        await saveMessage(targetJid, rObj2, 'Robo');
                        io.emit('new_msg', rObj2);
                        console.log(`✅ [Survey] Pesquisa enviada para Pedido #${pedidoId}`);
                    }
                } catch (e) { console.error('❌ [Survey] Erro:', e.message); }
            }, 8000);
        }
        res.json({ success: true });
    } catch (e) { 
        console.error(`❌ [Delivery] Erro ao enviar mensagem para Pedido #${pedidoId}:`, e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// ROTA PARA SINCRONIZAR STATUS DO CAIXA COM O PAINEL ADM
app.post('/api/sync-caixa', async (req, res) => {
    console.log('📩 [API] Requisicao em /api/sync-caixa:', req.body);
    let input = req.body.status !== undefined ? req.body.status : req.body.caixaFechado;
    if (input === undefined) return res.status(400).json({ error: 'Status ou caixaFechado é obrigatório' });
    
    let normalized = "aberto";
    const val = String(input).toLowerCase().trim();

    if (val === 'fechado' || val === 'true' || val === '1') {
        normalized = 'fechado';
    }
    
    if (db) {
        await db.get('settings').set('caixaFechado', normalized).write();
        io.emit('status_caixa', normalized);
        console.log(`🏪 [Sincronização] Status do Caixa atualizado via API para: ${normalized.toUpperCase()}`);
        return res.json({ success: true, status: normalized });
    }
    res.status(500).json({ error: 'DB não pronto' });
});

// ─── ROTA: Notificações do Painel ADM → WhatsApp do Admin ────────────────────
app.post('/api/notify-admin', async (req, res) => {
    const { titulo, descricao, numero } = req.body;

    if (!numero) return res.status(400).json({ error: 'numero é obrigatório' });
    if (!titulo)  return res.status(400).json({ error: 'titulo é obrigatório' });

    const cleanNumber = String(numero).replace(/\D/g, '');
    const jid = cleanNumber + '@s.whatsapp.net';

    if (!sock || statusConexao !== 'CONECTADO') {
        console.warn('⚠️ [Notif-Admin] Bot offline. Notificação ignorada:', titulo);
        return res.status(503).json({ error: 'Bot offline' });
    }

    const hora = getFormattedTime();
    const mensagem = `🔔 *PAINEL ADM — ${titulo}*\n\n${descricao || ''}\n\n🕒 _${hora}_`;

    try {
        // Envia SEM delay humanizado (notificação de sistema deve ser imediata)
        const s = await sock.sendMessage(jid, { text: mensagem });

        const msgObj = {
            id: s?.key?.id || ('adm-' + Date.now()),
            text: mensagem,
            fromMe: true,
            time: hora,
            sender: sock.user?.id,
            pushName: 'Notificações Meu zap 🔔 🤖'
        };

        if (db) {
            const chats = db.get('chats').value() || {};
            if (!chats[jid]) {
                chats[jid] = {
                    name: 'Notificações Meu zap 🔔 🤖',
                    messages: [],
                    unreadCount: 0,
                    lastUpdate: Date.now(),
                    estado: 'normal',
                    isSystemNotification: true
                };
            }
            // Garante nome e flag de sistema sempre
            chats[jid].name = 'Notificações Meu zap 🔔 🤖';
            chats[jid].isSystemNotification = true;
            chats[jid].lastUpdate = Date.now();
            chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
            if (!chats[jid].messages) chats[jid].messages = [];
            chats[jid].messages.push(msgObj);
            if (chats[jid].messages.length > 100) chats[jid].messages.shift();
            await db.set('chats', chats).write();
        }

        io.emit('new_msg', msgObj);
        console.log(`✅ [Notif-Admin] Enviado para ${jid}: ${titulo}`);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ [Notif-Admin] Erro ao enviar:', e.message);
        res.status(500).json({ error: e.message });
    }
});

let statusConexao = "DESCONECTADO";
let sock = null;
let lastQr = null;

async function sendHumanizedMessage(jid, content, options = {}) {
    if (!sock || statusConexao !== "CONECTADO") return;
    try {
        await sock.sendPresenceUpdate('composing', jid);
        let delay = 1500 + (Math.random() * 2000);
        if (content.text) delay += Math.min(content.text.length * 30, 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
        const result = await sock.sendMessage(jid, content, options);
        await sock.sendPresenceUpdate('paused', jid);
        return result;
    } catch (e) { throw e; }
}

async function getPedidoResumo(pedidoId, statusText, pushName) {
    try {
        const resp = await fetch(`${DELIVERY_API_URL}/${pedidoId}`);
        if (!resp.ok) return null;
        const ped = await resp.json();
        
        let itemsText = "";
        try {
            const itemsResp = await fetch(`${DELIVERY_API_URL}/${pedidoId}/itens`);
            if (itemsResp.ok) {
                const items = await itemsResp.json();
                if (items && items.length > 0) {
                    itemsText = "\n\n📋 *Itens do Pedido:*\n" + items.map(i => `▫️ ${i.quantidade}x ${i.nome} (R$ ${parseFloat(i.preco).toFixed(2)})`).join('\n');
                }
            }
        } catch(e) {}

        const details = ped.observacao || '';
        
        return `🛍️ *DETALHES DO PEDIDO #${pedidoId}*\n\n📌 *Status Atual:* *${statusText}*\n\n${details}${itemsText}\n\n💵 *Total:* *R$ ${parseFloat(ped.total).toFixed(2)}*\n\nComo posso te ajudar agora?\n\n1️⃣ - Ver Status Atual 🕒\n2️⃣ - Falar com Atendente 👨‍💻\n3️⃣ - Voltar ao Menu Principal ↩️`;
    } catch (e) {
        return null;
    }
}

async function getBotTexts() {
    try {
        const baseUrl = DELIVERY_API_URL.replace('/pedidos', '');
        const res = await fetch(`${baseUrl}/bot-responses`);
        if (res.ok) {
            const data = await res.json();
            if (Object.keys(data).length > 0) return data;
        }
    } catch(e) {}
    return {
        welcome: "Olá {nome}! 👋 Seja muito bem-vindo ao *GuGA Bebidas*! 🍻\n\nComo podemos deixar o seu dia melhor hoje?\n\n1️⃣ - Ver nosso Cardápio 📋\n2️⃣ - Fazer um Pedido agora 🛵\n3️⃣ - Ver Promoções do Dia 🤑\n4️⃣ - Endereço e Horários 📍\n5️⃣ - Falar com um Atendente 👨‍💻\n6️⃣ - Acompanhar Pedido Delivery 🛵\n\n_Basta digitar o número da opção desejada._",
        delivery: "Olá {nome}! 👋\n\nIdentificamos que você tem um pedido ativo conosco! 🛵🍔\n\nComo posso te ajudar agora?\n\n1️⃣ - Ver Status Atual 🕒\n2️⃣ - Falar com Atendente 👨‍💻\n3️⃣ - Voltar ao Menu Principal ↩️",
        menu1: "📋 *NOSSO CARDÁPIO DIGITAL*\n\nExplore todas as nossas bebidas e delícias diretamente pelo link abaixo:\n🔗 https://garconnexpress.vercel.app/delivery\n\n_Dê uma olhadinha e escolha o seu preferido!_ 😋",
        menu2: "🛵 *FAZER UM PEDIDO AGORA*\n\nJá escolheu? Então não perca tempo! Peça agora pelo nosso sistema de Delivery:\n🔗 https://garconnexpress.vercel.app/delivery\n\n💡 *Dica:* Seus dados ficam salvos para o próximo pedido ser ainda mais rápido!",
        menu3: "No momento não temos promoções ativas, mas nossos preços continuam os melhores da região! 😉\n\nConfira tudo aqui: https://garconnexpress.vercel.app/delivery",
        menu4: "📍 *ONDE ESTAMOS E QUANDO ABRIMOS*\n\n🏢 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\n\n🕒 *Horário de Funcionamento:*\nTerça a Domingo: das 18h às 02h\n\n_Venha nos visitar ou peça no conforto do seu sofá!_ 🛵🍻",
        menu5: "👨‍💻 *ATENDIMENTO HUMANO*\n\nEntendi! Já avisei a nossa equipe. Um de nossos atendentes falará com você em instantes.\n\n_Por favor, aguarde um momento..._",
        delivery_opt1: "🚚 *ACOMPANHAMENTO DO PEDIDO #{pId}*\n\nOlá ${pushName}, identificamos o seu pedido em nosso sistema! 🔍\n\n📌 *Status Atual:* *{status}*\n\n💡 *Dica:* Fique tranquilo(a), te avisaremos assim que ele sair para entrega! 🛵💨",
        delivery_opt2: "👨‍💻 *ATENDIMENTO HUMANO*\n\nEntendido! Já acionei nossa equipe. Um de nossos atendentes falará com você em instantes para tirar suas dúvidas ou resolver qualquer problema. 💬\n\n⏳ *Tempo médio de espera:* 2 a 5 minutos.\n\n_Por favor, aguarde um momento..._",
        store_closed: "Olá {nome}! No momento estamos *FECHADOS* 🌙\n\n⏰ *Horário de Funcionamento:*\nTerça a Domingo: das 18h às 02h\n\n🏠 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\n\n_Aguardamos seu pedido em breve!_ 🛵"
    };
}

async function saveMessage(jid, msg, name) {
    if (!jid || jid.includes('@newsletter')) return;
    const chats = db.get('chats').value() || {};

    // REGRA DE OURO: Identifica se é o próprio robô falando consigo mesmo
    const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
    const isSelf = myJid && jid.includes(myJid);

    if (!chats[jid]) {
        chats[jid] = { name: jid.split('@')[0], messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'normal' };
    }

    if (isSelf) {
        chats[jid].name = "Notificações Meu zap 🔔";
    } else if (chats[jid].isSystemNotification) {
        // Trava o nome se for o número de notificações
    } else if (name && name !== "Voce" && name !== "Robo") {
        chats[jid].name = name;
    }

    chats[jid].lastUpdate = Date.now();
    if (!msg.fromMe || isSelf) chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;

    if (chats[jid].messages.some(m => m.id === msg.id)) return;
    chats[jid].messages.push(msg);
    if (chats[jid].messages.length > 100) chats[jid].messages.shift();
    await db.set('chats', chats).write();
}

function isStoreOpen() {
    if (!db) return true;
    const settings = db.get('settings').value() || {};
    const rawValue = settings.caixaFechado;

    // Normalização robusta: Assume 'aberto' como padrão
    let status = "aberto";
    if (rawValue === 'fechado' || rawValue === true || rawValue === 'true' || rawValue === '1') {
        status = "fechado";
    }

    const isOpen = status === 'aberto';
    console.log(`🏪 [Caixa] Status no DB: "${rawValue}" | Loja Aberta: ${isOpen ? 'SIM' : 'NÃO'}`);
    
    return isOpen;
}

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) {
        socket.emit('history', db.get('chats').value());
        
        // Normaliza o status para o Painel Visual (Aberto ou Fechado)
        const rawStatus = db.get('settings').value()?.caixaFechado;
        const currentStatus = String(rawStatus || 'aberto').toLowerCase().trim();
        let normalized = "aberto";
        if (currentStatus === 'fechado' || currentStatus === 'true' || currentStatus === '1') normalized = 'fechado';
        
        socket.emit('status_caixa', normalized);
    }

    socket.on('send_msg', async (data) => {
        let jid = data.number;
        if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
        await sendHumanizedMessage(jid, { text: data.text });
    });

    socket.on('send_image', async (data) => {
        let jid = data.number;
        if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
        const buffer = Buffer.from(data.image.split(';base64,').pop(), 'base64');
        const s = await sendHumanizedMessage(jid, { image: buffer });
        const rObj = { id: s.key.id, text: '🖼️ Imagem', fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖", imageUrl: data.image };
        await saveMessage(jid, rObj, "Robo");
        io.emit('new_msg', rObj);
    });

    socket.on('mark_seen', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) { chats[jid].unreadCount = 0; await db.set('chats', chats).write(); }
        }
    });

    socket.on('toggle_atendimento', async (data) => {
        const { jid, status } = data;
        if (db) {
            const chats = db.get('chats').value() || {};
            if (!chats[jid]) chats[jid] = { name: jid.split('@')[0], messages: [], unreadCount: 0 };
            chats[jid].atendimentoManual = status;
            await db.set('chats', chats).write();
            io.emit('status_atendimento', { jid, atendimentoManual: status });
        }
    });

    socket.on('toggle_caixa', async (status) => {
        if (db) {
            let normalized = "aberto";
            const val = String(status).toLowerCase().trim();

            if (val === 'fechado' || val === 'true' || val === '1') {
                normalized = 'fechado';
            }

            console.log(`👆 [Painel] Solicitada alteração do Caixa para: ${normalized.toUpperCase()}`);
            await db.get('settings').set('caixaFechado', normalized).write();

            // Emite o status normalizado para todos
            io.emit('status_caixa', normalized);

            // Também emite um log para o console do servidor
            const effectivelyOpen = isStoreOpen();
            console.log(`🏪 [Caixa] Novo status: ${normalized.toUpperCase()} | Funcionando agora: ${effectivelyOpen ? 'SIM' : 'NÃO'}`);
        }
    });

    socket.on('rename_chat', async (data) => {
        const { jid, name } = data;
        if (db && jid && name) {
            const chats = db.get('chats').value() || {};
            if (!chats[jid]) {
                chats[jid] = { name: name, messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'normal' };
            } else {
                chats[jid].name = name;
            }
            chats[jid].isSystemNotification = true;
            await db.set('chats', chats).write();
            io.emit('chat_renamed', { jid, name });
        }
    });

    socket.on('pin_chat', async (data) => {
        try {
            if (sock && data.jid) {
                const pinState = data.unpin ? false : true;
                await sock.chatModify({ pin: pinState }, data.jid);
                console.log(pinState ? `📌 Conversa fixada: ${data.jid}` : `📍 Conversa desfixada: ${data.jid}`);
                
                // Salvar o estado no banco e notificar a UI
                if (db) {
                    const chats = db.get('chats').value() || {};
                    if (chats[data.jid]) {
                        chats[data.jid].isPinned = pinState;
                        await db.set('chats', chats).write();
                        io.emit('chat_renamed', { jid: data.jid, name: chats[data.jid].name, isPinned: pinState });
                    }
                }
            }
        } catch (error) {
            console.error('❌ Erro ao modificar fixação da conversa:', error.message);
        }
    });

    socket.on('delete_chat', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            delete chats[jid];
            await db.set('chats', { ...chats }).write();
            io.emit('chat_deleted', jid);
        }
    });
});

async function connectToWhatsApp() {
    const { default: makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await usePostgresAuthState();
    
    sock = makeWASocket({ 
        version,
        auth: state, 
        logger: pino({ level: 'error' }), 
        browser: Browsers.appropriate('Painel Zap')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('📸 [WhatsApp] Novo QR Code gerado!');
            qrcodeTerminal.generate(qr, { small: true });
            QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); });
            statusConexao = "AGUARDANDO QR";
            io.emit('status', { status: statusConexao });
        }
        if (connection === 'open') {
            statusConexao = "CONECTADO";
            lastQr = null;
            io.emit('status', { status: statusConexao });
            console.log('✅ Bot CONECTADO e Pronto!');
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ Conexão fechada. Motivo:', reason);
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                clearPostgresSession().finally(() => {
                    if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    setTimeout(connectToWhatsApp, 2000);
                });
            }
            statusConexao = "DESCONECTADO";
            io.emit('status', { status: statusConexao });
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        
        // IGNORA GRUPOS, LISTAS DE TRANSMISSÃO E STATUS
        if (jid === 'status@broadcast' || jid.includes('@g.us') || jid.includes('@broadcast') || jid.startsWith('-')) {
            return;
        }

        const fromMe = msg.key.fromMe;
        const pushName = fromMe ? "Voce" : (msg.pushName || jid.split('@')[0]);
        let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        
        // Identifica e dá nome para mídias
        if (msg.message.imageMessage) text = "📷 Imagem recebida";
        else if (msg.message.audioMessage) text = "🎵 Áudio recebido";
        else if (msg.message.videoMessage) text = "🎥 Vídeo recebido";
        else if (msg.message.stickerMessage) text = "🏷️ Figurinha recebida";
        else if (msg.message.reactionMessage) return; // Ignora reações invisíveis
        
        // Se após tudo isso ainda for vazio (como um evento de sistema ou protocolo), ignora!
        if (!text) {
            console.log(`[Sistema] Mensagem de protocolo ou vazia ignorada de ${jid}`);
            return;
        }
        
        const msgObj = { id: msg.key.id, from: jid, text, fromMe, time: getFormattedTime(msg.messageTimestamp ? msg.messageTimestamp * 1000 : undefined), sender: jid, pushName };
        await saveMessage(jid, msgObj, pushName);
        io.emit('new_msg', msgObj);

        if (fromMe) return;

        // BLOQUEIO: O robô JAMAIS deve tentar atender ou mandar mensagem de boas-vindas para si mesmo ou para o dono
        const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
        const isSelf = myJid && jid.includes(myJid);
        const isAdmin = jid.includes('558293157048');

        if (isSelf || isAdmin) {
            console.log(`🛡️ [Bloqueio] Ignorando fluxo de robô para Admin/Si mesmo: ${jid}`);
            return;
        }

        // --- VERIFICAÇÃO DE STATUS DA LOJA (LOG EM TEMPO REAL) ---
        const storeOpen = isStoreOpen();
        const chats = db.get('chats').value() || {};
        const chatData = chats[jid] || {};
        const hasActiveOrder = chatData.estado === 'delivery' && chatData.activePedidoId;

        console.log(`📩 [Mensagem] De: ${jid} | Loja Aberta: ${storeOpen} | Pedido Ativo: ${!!hasActiveOrder}`);

        if (!storeOpen && !hasActiveOrder) {
            console.log(`🚫 [Bloqueio] Caixa FECHADO. Enviando mensagem de fechamento para ${jid}`);
            const btexts = await getBotTexts();
            const closedMsg = (btexts.store_closed || "Olá! Estamos fechados.").split('{nome}').join(pushName || '');
            const s = await sendHumanizedMessage(jid, { text: closedMsg });
            if (s) {
                await saveMessage(jid, { id: s.key.id, text: closedMsg, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
            }
            return;
        }

        // --- TRAVA DE ATENDIMENTO HUMANO (SILÊNCIO TOTAL DO ROBÔ) ---
        if (chatData?.atendimentoManual) {
            console.log(`👤 [Humano] Atendimento manual ativo for ${jid}. Robô em silêncio.`);
            return;
        }

        // --- RESPOSTA À PESQUISA DE SATISFAÇÃO ---
        const isSurveyResponse = ['1','2','3','4','5'].includes(text) && chatData.surveyPending;
        
        // Se há uma pesquisa pendente mas o cliente digitou outra coisa, cancelamos a pesquisa e seguimos para o menu normal
        if (chatData.surveyPending && !isSurveyResponse) {
            chatData.surveyPending = false;
            await db.set('chats', chats).write();
            console.log(`📝 [Survey] Cliente ${jid} ignorou a pesquisa. Voltando ao fluxo normal.`);
        }

        if (isSurveyResponse && chatData.estado !== 'delivery') {
            const rating = parseInt(text);
            let thanks = "";
            if (rating >= 4) {
                thanks = "Ficamos muito felizes que você gostou! 😍 Obrigado pela nota máxima! Sua satisfação é o que nos move. Até a próxima! 🍻";
            } else if (rating === 3) {
                thanks = "Obrigado pelo seu feedback! 👍 Vamos trabalhar para que sua próxima experiência seja nota 5. Se tiver alguma sugestão, pode mandar aqui! 📝";
            } else {
                thanks = "Sentimos muito que sua experiência não foi como esperava. 😔 Agradecemos a nota e vamos usar seu feedback para melhorar.";
            }
            
            // Desativa a flag para não entrar em loop no próximo número digitado
            chatData.surveyPending = false;
            await db.set('chats', chats).write();

            await sendHumanizedMessage(jid, { text: thanks });
            await saveMessage(jid, { id: 'survey-thanks-' + Date.now(), text: thanks, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
            return;
        }

        const isOrder = text.includes('🛍️ *NOVO PEDIDO - DELIVERY*') || text.includes('🛵 DELIVERY');
        if (isOrder) {
            const pId = (text.match(/#(\d+)/) || [])[1];
            if (pId) {
                await db.get('pedidoIdToJid').set(String(pId), jid).write();
                chats[jid] = chats[jid] || { messages: [], unreadCount: 0 };
                chats[jid].activePedidoId = pId; 
                chats[jid].estado = 'delivery';
                await db.set('chats', chats).write();
                
                const richWelcome = `Olá ${pushName}! 👋\n\n🛍️ *PEDIDO RECEBIDO COM SUCESSO!*\n\nObrigado por escolher o *GuGA Bebidas*. Seu pedido *#${pId}* já caiu em nosso sistema e está na fila de preparo! 🚀\n\n💡 *O que acontece agora?*\nAssim que seu pedido for para a entrega, você será notificado aqui no Zap!\n\n👇 *Opções:* \n1️⃣ - Ver Status Atual 🛵\n2️⃣ - Falar com Atendente 👨‍💻`;
                await sendHumanizedMessage(jid, { text: richWelcome });
                return;
            }
        }

        // --- CAMADA DE INTELIGÊNCIA: NORMALIZAÇÃO E BUSCA DE IDs ---
        const normalizedText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const detectedPedidoId = (text.match(/#?(\d{4,6})/) || [])[1];

        // SE DETECTAR UM ID (#1234), ELE BUSCA O STATUS NA HORA!
        if (detectedPedidoId && !isOrder) {
            console.log(`🧠 [Intelligence] Buscando status para Pedido #${detectedPedidoId} solicitado por ${jid}`);
            try {
                const resp = await fetch(`${DELIVERY_API_URL}/${detectedPedidoId}`);
                if (resp.ok) {
                    const ped = await resp.json();
                    const stMap = { 
                        'recebido': 'Preparando 👨‍🍳', 
                        'preparando': 'Preparando 👨‍🍳', 
                        'pronto': 'Pronto 🥡', 
                        'saiu_entrega': 'A caminho 🛵', 
                        'servido': 'Saiu para Entrega 🛵', 
                        'entregue': 'Entregue 😋', 
                        'aguardando_fechamento': 'Entregue 😋' 
                    };
                    const statusDesc = stMap[ped.status] || ped.status || 'Em processamento... ⏳';
                    const statusReply = await getPedidoResumo(detectedPedidoId, statusDesc, pushName);
                    
                    if (statusReply) {
                        chatData.activePedidoId = detectedPedidoId;
                        chatData.estado = 'delivery';
                        await db.set('chats', chats).write();

                        await sendHumanizedMessage(jid, { text: statusReply });
                        await saveMessage(jid, { id: 'search-' + Date.now(), text: statusReply, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
                        return; // Interrompe para não mostrar o menu logo abaixo
                    }
                }
            } catch (e) {
                console.error(`❌ Erro na busca inteligente por ID #${detectedPedidoId}:`, e.message);
            }
        }

        const estado = chatData.estado || 'normal';
        let reply = "";

        // Se for uma resposta de pesquisa, já lidamos com o menu acima e demos 'return'
        if (isSurveyResponse) return;

        // --- LÓGICA DE RESPOSTAS (ESTADO: AGUARDANDO ID DO PEDIDO) ---
        if (estado === 'aguardando_id_pedido') {
            const possibleId = (text.match(/\d+/) || [])[0];
            if (possibleId) {
                try {
                    const resp = await fetch(`${DELIVERY_API_URL}/${possibleId}`);
                    if (resp.ok) {
                        const ped = await resp.json();
                        const stMap = { 
                            'recebido': 'Preparando 👨‍🍳', 
                            'preparando': 'Preparando 👨‍🍳', 
                            'pronto': 'Pronto 🥡', 
                            'saiu_entrega': 'A caminho 🛵', 
                            'servido': 'Saiu para Entrega 🛵', 
                            'entregue': 'Entregue 😋', 
                            'aguardando_fechamento': 'Entregue 😋' 
                        };
                        const statusDesc = stMap[ped.status] || ped.status || 'Em processamento... ⏳';
                        reply = await getPedidoResumo(possibleId, statusDesc, pushName);
                        
                        if (reply) {
                            chats[jid].activePedidoId = possibleId;
                            chats[jid].estado = 'delivery';
                        } else {
                            throw new Error('Falha no resumo');
                        }
                    } else {
                        reply = `Ops! Não conseguimos localizar o pedido #${possibleId}. Por favor, verifique se o número está correto ou digite '5' para falar com um atendente.`;
                        chats[jid].estado = 'normal';
                    }
                } catch (e) {
                    console.error(`❌ Erro ao consultar pedido #${possibleId}:`, e.message);
                    reply = "Erro ao consultar o status do pedido. Tente novamente mais tarde. 😕";
                    chats[jid].estado = 'normal';
                }
            } else {
                reply = "Por favor, envie apenas o NÚMERO do seu pedido. Exemplo: 1234";
            }
            await db.set('chats', chats).write();
            
            const s = await sendHumanizedMessage(jid, { text: reply });
            await saveMessage(jid, { id: s.key.id, text: reply, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
            return;
        }

        // --- LÓGICA DE RESPOSTAS (ESTADO: DELIVERY) ---
        if (estado === 'delivery') {
            const isCheckStatus = text === '1' || normalizedText.includes('status') || normalizedText.includes('rastrear') || (normalizedText.includes('pedido') && !normalizedText.includes('fazer'));
            const isCallHuman = text === '2' || normalizedText.includes('atendente') || normalizedText.includes('falar') || normalizedText.includes('ajuda') || normalizedText.includes('humano');
            const isExit = text === '3' || normalizedText.includes('voltar') || normalizedText.includes('sair') || normalizedText.includes('encerrar');

            if (isCheckStatus) {
                const pId = chatData.activePedidoId;
                try {
                    const resp = await fetch(`${DELIVERY_API_URL}/${pId}`);
                    const ped = await resp.json();
                    const stMap = { 
                        'recebido': 'Preparando 👨‍🍳', 
                        'preparando': 'Preparando 👨‍🍳', 
                        'pronto': 'Pronto 🥡', 
                        'saiu_entrega': 'A caminho 🛵', 
                        'servido': 'Saiu para Entrega 🛵', 
                        'entregue': 'Entregue 😋', 
                        'aguardando_fechamento': 'Entregue 😋' 
                    };
                    const btexts = await getBotTexts();
                    reply = btexts.delivery_opt1.replace('{pId}', pId).split('{nome}').join(pushName || '').replace('{status}', stMap[ped.status] || ped.status);
                } catch (e) { 
                    console.error(`❌ Erro ao consultar status do pedido #${pId}:`, e.message);
                    reply = "Erro ao consultar status. 😕"; 
                }
            } else if (isCallHuman) {
                const btexts = await getBotTexts();
                reply = btexts.delivery_opt2;
                chats[jid].atendimentoManual = true;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: true });
            } else if (isExit) {
                chats[jid].estado = 'normal';
                chats[jid].activePedidoId = null;
                await db.set('chats', chats).write();
                const btexts = await getBotTexts();
                reply = "Prontinho! Você saiu do acompanhamento do pedido. 🔄\n\n" + btexts.welcome.split('{nome}').join(pushName || '');
            } else {
                // Checar menus dinâmicos de delivery
                const btexts = await getBotTexts();
                if (btexts.customMenusDelivery && btexts.customMenusDelivery.length > 0) {
                    const match = btexts.customMenusDelivery.find(m => text === m.option);
                    if (match) {
                        reply = match.response;
                    }
                }
            }
        } 
        
        // --- LÓGICA DE RESPOSTAS (ESTADO: NORMAL OU SE NÃO ENTROU NO DELIVERY ACIMA) ---
        if (!reply) {
            const btexts = await getBotTexts();
            const isMenu1 = text === '1' || normalizedText.includes('cardapio') || normalizedText.includes('menu') || normalizedText.includes('lista');
            const isMenu2 = text === '2' || normalizedText.includes('fazer pedido') || normalizedText.includes('pedir') || normalizedText.includes('comprar');
            const isMenu3 = text === '3' || normalizedText.includes('promo') || normalizedText.includes('oferta');
            const isMenu4 = text === '4' || normalizedText.includes('endereco') || normalizedText.includes('local') || normalizedText.includes('onde') || normalizedText.includes('horario');
            const isMenu5 = text === '5' || normalizedText.includes('atendente') || normalizedText.includes('falar') || normalizedText.includes('ajuda') || normalizedText.includes('humano');
            const isMenu6 = text === '6' || normalizedText.includes('acompanhar pedido') || normalizedText.includes('acompanhar delivery');

            if (isMenu1) {
                reply = btexts.menu1;
            } else if (isMenu2) {
                reply = btexts.menu2;
            } else if (isMenu3) {
                try {
                    const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                    const menu = await response.json();
                    const promos = menu.filter(item => item.em_promocao && item.visivel);
                    if (promos.length > 0) {
                        reply = "🔥 *PROMOÇÕES IMPERDÍVEIS DE HOJE*\n\n" + promos.map(p => `✨ *${p.nome}*\n💰 Por apenas: *R$ ${parseFloat(p.preco).toFixed(2)}*\n`).join('\n') + "\n_Aproveite antes que acabe!_ 🏃💨";
                    } else {
                        reply = btexts.menu3;
                    }
                } catch (e) { reply = "Ops! Tive um problema ao buscar as promoções. Mas você pode ver tudo no nosso cardápio: https://garconnexpress.vercel.app/delivery"; }
            } else if (isMenu4) {
                reply = btexts.menu4;
            } else if (isMenu5) {
                reply = btexts.menu5;
                chats[jid].atendimentoManual = true;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: true });
            } else if (isMenu6) {
                const cleanPhone = jid.split('@')[0].replace(/\D/g, '');
                try {
                    const baseUrl = DELIVERY_API_URL.replace('/pedidos', '');
                    const response = await fetch(`${baseUrl}/pedidos/ativo-telefone/${cleanPhone}`);
                    if (response.ok) {
                        const pedido = await response.json();
                        if (pedido && pedido.id) {
                            chats[jid].estado = 'delivery';
                            chats[jid].activePedidoId = String(pedido.id);
                            await db.set('chats', chats).write();

                            const stMap = { 
                                'recebido': 'Recebido 📝', 
                                'preparando': 'Preparando 👨‍🍳🔥', 
                                'pronto': 'Pronto 🥡✨', 
                                'saiu_entrega': 'Saiu para Entrega 🛵💨',
                                'entregue': 'Entregue 😋🥤',
                                'cancelado': 'Cancelado ❌'
                            };
                            const statusText = stMap[pedido.status] || pedido.status;
                            const statusReply = await getPedidoResumo(pedido.id, statusText, pushName);
                            
                            if (statusReply) {
                                chats[jid].estado = 'delivery';
                                chats[jid].activePedidoId = String(pedido.id);
                                await db.set('chats', chats).write();
                                reply = statusReply;
                            } else {
                                throw new Error('Falha no resumo');
                            }
                        } else {
                            throw new Error('Sem pedido');
                        }
                    } else {
                        throw new Error('Resposta inválida');
                    }
                } catch (e) {
                    reply = "Entendido! 📦\n\nNão encontrei nenhum pedido ativo associado ao seu número de WhatsApp.\n\nPor favor, digite apenas o *número do seu Pedido Delivery* (ex: 1234) para consultarmos o status:";
                    chats[jid].estado = 'aguardando_id_pedido';
                    await db.set('chats', chats).write();
                }
            } else if (!/^[1-6]/.test(text)) {
                // Checar menus dinâmicos principais
                let match = null;
                if (btexts.customMenusMain && btexts.customMenusMain.length > 0) {
                    match = btexts.customMenusMain.find(m => text === m.option);
                }
                
                if (match) {
                    reply = match.response;
                } else {
                    // FALLBACK INTELIGENTE: Se não entendeu e está em delivery, mostra o menu de delivery
                    if (estado === 'delivery') {
                        reply = btexts.delivery.split('{nome}').join(pushName || '');
                        if (btexts.customMenusDelivery && btexts.customMenusDelivery.length > 0) {
                            btexts.customMenusDelivery.forEach(m => {
                                reply += `\n${m.option}️⃣ - ${m.title} 📌`;
                            });
                        }
                    } else {
                        // Se não está em delivery, mostra o menu normal de boas-vindas
                        reply = btexts.welcome.split('{nome}').join(pushName || '');
                        if (btexts.customMenusMain && btexts.customMenusMain.length > 0) {
                            // Procura variações de "Basta digitar", "Digite", "Escolha" para inserir o menu extra antes dessa frase final
                            const regexFim = /(_|\*)*(basta digitar|digite o n|escolha uma|para escolher|digite a op)/i;
                            const matchFim = reply.match(regexFim);
                            
                            let customMenuText = '';
                            btexts.customMenusMain.forEach(m => {
                                customMenuText += `${m.option}️⃣ - ${m.title} 📌\n`;
                            });
                            
                            if (matchFim && matchFim.index > 0) {
                                const antes = reply.substring(0, matchFim.index);
                                const depois = reply.substring(matchFim.index);
                                reply = antes + customMenuText + '\n' + depois;
                            } else {
                                reply += `\n\n${customMenuText}`;
                            }
                        }
                    }
                }
            }
        }

        if (reply) {
            const s = await sendHumanizedMessage(jid, { text: reply });
            await saveMessage(jid, { id: s.key.id, text: reply, fromMe: true, time: getFormattedTime(), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
        }
    });
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
    setInterval(checkInactivity, 60000); // Checa inatividade a cada 1 minuto
    setInterval(cleanupOldChats, 3600000); // Limpa chats antigos a cada 1 hora
    cleanupOldChats(); // Limpeza inicial ao ligar o robô
});
