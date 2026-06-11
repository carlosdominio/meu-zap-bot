const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');  
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Banco de dados local
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const adapter = new FileAsync('db.json');
let db;

async function initDB() {
    db = await low(adapter);
    await db.defaults({ chats: {}, pedidoIdToJid: {}, settings: { caixaFechado: false }, lastNotifications: {}, surveysSent: {} }).write();
    console.log('✅ Banco de dados pronto');
}

const app = express();
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
    const isFinalizedStatus = ['concluido', 'finalizado', 'concluído', 'concluida', 'concluída', 'finalizada', 'pago', 'encerrado', 'fechado', 'aguardando_fechamento'].includes(status);

    if (status === 'recebido') return res.json({ success: true, info: 'Recebimento silenciado' });

    if (!sock || statusConexao !== 'CONECTADO') {
        console.error(`❌ [Delivery] Erro: Bot está ${statusConexao}. Não foi possível enviar para o Pedido #${pedidoId}`);
        return res.status(503).json({ error: 'Bot offline' });
    }

    try {
        // --- SEQUENCE PROTECTOR: Se for FINALIZAR mas não enviamos o ENTREGUE, envia agora primeiro ---
        if (db && isFinalizedStatus) {
            const lastNotifCategory = db.get('lastNotifications').value() || {};
            if (lastNotifCategory[pedidoId] !== 'ENTREGUE' && lastNotifCategory[pedidoId] !== 'FINALIZADO') {
                console.log(`⚡ [Sequence] Forçando mensagem de ENTREGA antes da FINALIZAÇÃO para Pedido #${pedidoId}`);
                const forceDeliveryMsg = `Olá, ${clientName}! 👋\\n\\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\\n\\nInformamos que seu pedido foi ENTREGUE! 🎉\\nEsperamos que aproveite muito. Bom apetite! 😋🥤\\n\\nAtenciosamente,\\nEquipe GuGA Bebidas 🍻`;
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
            message = `Olá, ${clientName}! 👋\\n\\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\\n\\nInformamos que seu pedido foi ENTREGUE! 🎉\\nEsperamos que aproveite muito. Bom apetite! 😋🥤\\n\\nAtenciosamente,\\nEquipe GuGA Bebidas 🍻`;
        } else if (isFinalizedStatus) {
            message = `Olá, ${clientName}! 👋\\n\\n🔔 ATUALIZAÇÃO DO PEDIDO #${pedidoId}\\n\\n✅ PEDIDO FINALIZADO COM SUCESSO!\\n\\nAgradecemos imensamente pela sua preferência. Esperamos que sua experiência tenha sido excelente e que você aproveite cada detalhe! 😋🥤\\n\\nAtenciosamente,\\nEquipe GuGA Bebidas 🍻`;
        } else {
            const statusText = statusMessages[status] || `está com o status: ${status}`;
            message = `Olá ${clientName}! 👋\\n\\n🔔 *ATUALIZAÇÃO DO PEDIDO #${pedidoId}*\\n\\nInformamos que seu pedido ${statusText}\\n\\nAtenciosamente,\\n*Equipe GuGA Bebidas* 🍻`;
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
                const surveyMessage = `Sua opinião é muito importante para nós! ⭐\\n\\nComo foi sua experiência com nosso atendimento e entrega?\\n\\nResponda com uma nota de *1 a 5*:\\n\\n1️⃣ - Muito Insatisfeito\\n2️⃣ - Insatisfeito\\n3️⃣ - Regular\\n4️⃣ - Satisfeito\\n5️⃣ - Muito Satisfeito\\n\\nAtenciosamente,\\nEquipe GuGA Bebidas 🍻`;
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

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) {
        socket.emit('history', db.get('chats').value());
        socket.emit('status_caixa', db.get('settings').value()?.caixaFechado || false);
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
        const rObj = { id: s.key.id, text: '🖼️ Imagem', fromMe: true, time: getFormattedTime(), sender: jid, pushName: "Robô 🤖", imageUrl: data.image };
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
            await db.get('settings').set('caixaFechado', status).write();
            io.emit('status_caixa', status);
            const statusLabel = typeof status === 'string' ? status.toUpperCase() : (status ? 'FECHADO' : 'ABERTO');
            console.log(`🏪 [Loja] Status do Caixa alterado para: ${statusLabel}`);
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
        chats[jid].name = "Pedidos Zap 📦";
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
    
    const status = settings.caixaFechado;

    // Se estiver em 'aberto', o robô funciona sempre
    if (status === 'aberto') return true;
    
    // Caso contrário (modo 'auto'), segue o horário programado
    const now = new Date();
    const localized = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    
    const day = localized.getDay(); 
    const hour = localized.getHours();

    const isNightOpen = (hour >= 18 && [2, 3, 4, 5, 6, 0].includes(day));
    const isEarlyMorningOpen = (hour < 2 && [3, 4, 5, 6, 0, 1].includes(day));

    return isNightOpen || isEarlyMorningOpen;
}

async function connectToWhatsApp() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({ 
        version,
        auth: state, 
        logger: pino({ level: 'error' }), 
        browser: Browsers.appropriate('Painel Zap')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
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
                if (fs.existsSync('auth_info_baileys')) fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                setTimeout(connectToWhatsApp, 2000);
            }
            statusConexao = "DESCONECTADO";
            io.emit('status', { status: statusConexao });
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const pushName = fromMe ? "Voce" : (msg.pushName || jid.split('@')[0]);
        let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        
        const msgObj = { id: msg.key.id, from: jid, text, fromMe, time: getFormattedTime(msg.messageTimestamp ? msg.messageTimestamp * 1000 : undefined), sender: jid, pushName };
        await saveMessage(jid, msgObj, pushName);
        io.emit('new_msg', msgObj);

        if (fromMe) return;

        // --- TRAVA DE CAIXA FECHADO (FORA DO HORÁRIO) ---
        const chats = db.get('chats').value() || {};
        const chatData = chats[jid] || {};
        const hasActiveOrder = chatData.estado === 'delivery' && chatData.activePedidoId;

        if (!isStoreOpen() && !hasActiveOrder) {
            console.log(`🔌 [Fechado] Mensagem de ${jid} ignorada por estar fora do horário.`);
            const closedMsg = "Olá! No momento estamos *FECHADOS* 😴\\n\\n⏰ *Horário de Funcionamento:*\\nTerça a Domingo: das 18h às 02h\\n\\n🏠 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\\n\\n_Aguardamos seu pedido em breve!_ 🍻";
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
            await saveMessage(jid, { id: 'survey-thanks-' + Date.now(), text: thanks, fromMe: true, time: getFormattedTime(), sender: jid, pushName: "Robô 🤖" }, "Robo");
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
                
                const richWelcome = `Olá ${pushName}! 👋\\n\\n🛍️ *PEDIDO RECEBIDO COM SUCESSO!*\\n\\nObrigado por escolher o *GuGA Bebidas*. Seu pedido *#${pId}* já caiu em nosso sistema e está na fila de preparo! 🚀\\n\\n💡 *O que acontece agora?*\\nAssim que seu pedido for para a entrega, você será notificado aqui no Zap!\\n\\n👇 *Opções:* \\n1️⃣ - Ver Status Atual 🛵\\n2️⃣ - Falar com Atendente 👨‍💻`;
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
                    const statusReply = `📦 *STATUS DO PEDIDO #${detectedPedidoId}*\\n\\nOlá ${pushName}, localizamos o seu pedido! ✨\\n\\n📊 *Status Atual:* *${statusDesc}*\\n\\n💡 *Dica:* Te avisaremos aqui assim que houver uma nova atualização! 🛵💨`;
                    
                    // Vincula o chat ao pedido para futuras consultas rápidas (Opção 1)
                    chatData.activePedidoId = detectedPedidoId;
                    chatData.estado = 'delivery';
                    await db.set('chats', chats).write();

                    await sendHumanizedMessage(jid, { text: statusReply });
                    await saveMessage(jid, { id: 'search-' + Date.now(), text: statusReply, fromMe: true, time: getFormattedTime(), sender: jid, pushName: "Robô 🤖" }, "Robo");
                    return; // Interrompe para não mostrar o menu logo abaixo
                }
            } catch (e) {
                console.error(`❌ Erro na busca inteligente por ID #${detectedPedidoId}:`, e.message);
            }
        }

        const estado = chatData.estado || 'normal';
        let reply = "";

        // Se for uma resposta de pesquisa, já lidamos com o menu acima e demos 'return'
        if (isSurveyResponse) return;

        // --- LÓGICA DE RESPOSTAS (ESTADO: DELIVERY) ---
        if (estado === 'delivery') {
            const isCheckStatus = text === '1' || normalizedText.includes('status') || normalizedText.includes('rastrear') || (normalizedText.includes('pedido') && !normalizedText.includes('fazer'));
            const isCallHuman = text === '2' || normalizedText.includes('atendente') || normalizedText.includes('falar') || normalizedText.includes('ajuda') || normalizedText.includes('humano');

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
                    reply = `📦 *ACOMPANHAMENTO DO PEDIDO #${pId}*\\n\\nOlá ${pushName}, identificamos o seu pedido em nosso sistema! ✨\\n\\n📊 *Status Atual:* *${stMap[ped.status] || ped.status}*\\n\\n💡 *Dica:* Fique tranquilo(a), te avisaremos assim que ele sair para entrega! 🛵💨`;
                } catch (e) { 
                    console.error(`❌ Erro ao consultar status do pedido #${pId}:`, e.message);
                    reply = "Erro ao consultar status. 😕"; 
                }
            } else if (isCallHuman) {
                reply = "👨‍💻 *ATENDIMENTO HUMANO*\\n\\nEntendido! Já acionei nossa equipe. Um de nossos atendentes falará com você em instantes para tirar suas dúvidas ou resolver qualquer problema. 🚀\\n\\n⏳ *Tempo médio de espera:* 2 a 5 minutos.\\n\\n_Por favor, aguarde um momento..._";
                chats[jid].atendimentoManual = true;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: true });
            }
        } 
        
        // --- LÓGICA DE RESPOSTAS (ESTADO: NORMAL OU SE NÃO ENTROU NO DELIVERY ACIMA) ---
        if (!reply) {
            const isMenu1 = text === '1' || normalizedText.includes('cardapio') || normalizedText.includes('menu') || normalizedText.includes('lista');
            const isMenu2 = text === '2' || normalizedText.includes('fazer pedido') || normalizedText.includes('pedir') || normalizedText.includes('comprar');
            const isMenu3 = text === '3' || normalizedText.includes('promo') || normalizedText.includes('oferta');
            const isMenu4 = text === '4' || normalizedText.includes('endereco') || normalizedText.includes('local') || normalizedText.includes('onde') || normalizedText.includes('horario');
            const isMenu5 = text === '5' || normalizedText.includes('atendente') || normalizedText.includes('falar') || normalizedText.includes('ajuda') || normalizedText.includes('humano');

            if (isMenu1) {
                reply = "📖 *NOSSO CARDÁPIO DIGITAL*\\n\\nExplore todas as nossas bebidas e delícias diretamente pelo link abaixo:\\n🔗 https://garconnexpress.vercel.app/delivery\\n\\n_Dê uma olhadinha e escolha o seu preferido!_ 😉";
            } else if (isMenu2) {
                reply = "🛒 *FAZER UM PEDIDO AGORA*\\n\\nJá escolheu? Então não perca tempo! Peça agora pelo nosso sistema de Delivery:\\n🔗 https://garconnexpress.vercel.app/delivery\\n\\n🚀 *Dica:* Seus dados ficam salvos para o próximo pedido ser ainda mais rápido!";
            } else if (isMenu3) {
                try {
                    const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                    const menu = await response.json();
                    const promos = menu.filter(item => item.em_promocao && item.visivel);
                    if (promos.length > 0) {
                        reply = "🔥 *PROMOÇÕES IMPERDÍVEIS DE HOJE*\\n\\n" + promos.map(p => `✨ *${p.nome}*\\n💰 Por apenas: *R$ ${parseFloat(p.preco).toFixed(2)}*\\n`).join('\\n') + "\\n_Aproveite antes que acabe!_ 🏃💨";
                    } else {
                        reply = "No momento não temos promoções ativas, mas nossos preços continuam os melhores da região! 😉\\n\\nConfira tudo aqui: https://garconnexpress.vercel.app/delivery";
                    }
                } catch (e) { reply = "Ops! Tive um problema ao buscar as promoções. Mas você pode ver tudo no nosso cardápio: https://garconnexpress.vercel.app/delivery"; }
            } else if (isMenu4) {
                reply = "📍 *ONDE ESTAMOS E QUANDO ABRIMOS*\\n\\n🏠 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\\n\\n⏰ *Horário de Funcionamento:*\\nTerça a Domingo: das 18h às 02h\\n\\n_Venha nos visitar ou peça no conforto do seu sofá!_ 🏠🍻";
            } else if (isMenu5) {
                reply = "👨‍💻 *ATENDIMENTO HUMANO*\\n\\nEntendi! Já avisei a nossa equipe. Um de nossos atendentes falará com você em instantes.\\n\\n_Por favor, aguarde um momento..._";
                chats[jid].atendimentoManual = true;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: true });
            } else if (!/^[1-5]/.test(text)) {
                // FALLBACK INTELIGENTE: Se não entendeu e está em delivery, mostra o menu de delivery
                if (estado === 'delivery') {
                    reply = `Olá ${pushName}! 👋\\n\\nIdentificamos que você tem um pedido ativo conosco! 🛍️\\n\\nComo posso te ajudar agora?\\n\\n1️⃣ - Ver Status Atual 🛵\\n2️⃣ - Falar com Atendente 👨‍💻`;
                } else {
                    // Se não está em delivery, mostra o menu normal de boas-vindas
                    reply = `Olá ${pushName}! 👋 Seja muito bem-vindo ao *GuGA Bebidas*! 🍻\\n\\nComo podemos deixar o seu dia melhor hoje?\\n\\n1️⃣ - Ver nosso Cardápio 📖\\n2️⃣ - Fazer um Pedido agora 🛒\\n3️⃣ - Ver Promoções do Dia 🔥\\n4️⃣ - Endereço e Horários 📍\\n5️⃣ - Falar com um Atendente 👨‍💻\\n\\n_Basta digitar o número da opção desejada._`;
                }
            }
        }

        if (reply) {
            const s = await sendHumanizedMessage(jid, { text: reply });
            await saveMessage(jid, { id: s.key.id, text: reply, fromMe: true, time: getFormattedTime(), sender: jid, pushName: "Robô 🤖" }, "Robo");
        }
    });
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
    setInterval(checkInactivity, 60000); // Checa inatividade a cada 1 minuto
    setInterval(cleanupOldChats, 3600000); // Limpa chats antigos a cada 1 hora
    cleanupOldChats(); // Limpeza inicial ao ligar o robô
});
