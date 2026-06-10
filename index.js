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
                    time: new Date().toLocaleTimeString('pt-BR'), 
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
    const { number, status, pedidoId } = req.body;
    console.log(`📦 [Bot] Notificação: Status=${status}, Pedido=#${pedidoId}`);

    let jid = number;
    if (jid && !jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';

    const chats = db ? db.get('chats').value() || {} : {};
    let targetJid = jid;

    if (pedidoId && db) {
        // --- PREVENÇÃO DE DUPLICIDADE (MENSAGEM REPETIDA) ---
        const lastNotif = db.get('lastNotifications').value() || {};
        if (lastNotif[pedidoId] === status) {
            console.log(`⚠️ [Bot] Notificação duplicada para Pedido #${pedidoId} (Status: ${status}). Ignorando para não enviar duas vezes.`);
            return res.json({ success: true, info: 'Notificação já enviada' });
        }
        lastNotif[pedidoId] = status;
        await db.set('lastNotifications', lastNotif).write();

        const mapping = db.get('pedidoIdToJid').value() || {};
        if (mapping[pedidoId]) {
            targetJid = mapping[pedidoId];
        } else {
            const foundJid = Object.keys(chats).find(k => 
                String(chats[k].activePedidoId) === String(pedidoId) || 
                String(chats[k].ultimoPedidoId) === String(pedidoId)
            );
            if (foundJid) {
                targetJid = foundJid;
                await db.get('pedidoIdToJid').set(pedidoId, targetJid).write();
            }
        }
    }

    if (!targetJid) targetJid = jid;
    if (!targetJid) return res.status(400).json({ error: 'JID não encontrado' });

    const statusMessages = {
        'recebido': 'foi recebido com sucesso e já está na nossa fila de produção! 📝',
        'preparando': 'está sendo preparado com todo carinho pela nossa equipe! 👨‍🍳🔥',
        'pronto': 'já está PRONTO e aguardando apenas o entregador! 🥡✨',
        'saiu_entrega': 'acaba de SAIR PARA ENTREGA! Prepara o coração (e o estômago) que já estamos chegando! 🛵💨',
        'entregue': 'foi ENTREGUE! Esperamos que aproveite muito. Bom apetite! 😋🥤',
        'servido': 'foi ENTREGUE! Esperamos que aproveite muito. Bom apetite! 😋🥤',
        'concluido': 'foi FINALIZADO com sucesso. Obrigado pela preferência! 🌟',
        'finalizado': 'foi FINALIZADO com sucesso. Obrigado pela preferência! 🌟',
        'aguardando_fechamento': 'foi ENTREGUE! Esperamos que aproveite muito. Bom apetite! 😋🥤',
        'cancelado': 'foi CANCELADO. Se precisar de mais informações, por favor, chame um de nossos atendentes. ❌'
    };

    if (!statusMessages[status]) return res.status(400).json({ error: 'Status inválido' });

    const chatData = chats[targetJid] || {};
    const clientName = (chatData.name && chatData.name !== targetJid.split('@')[0]) ? chatData.name : 'cliente';
    
    // MENSAGEM RICA DE ACOMPANHAMENTO
    const message = `Olá ${clientName}! 👋\n\n🔔 *ATUALIZAÇÃO DO PEDIDO #${pedidoId}*\n\nInformamos que seu pedido ${statusMessages[status]}\n\nAtenciosamente,\n*Equipe GuGA Bebidas* 🍻`;

    if (db) {
        if (!chats[targetJid]) {
            chats[targetJid] = { name: targetJid.split('@')[0], messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'delivery', activePedidoId: pedidoId };
        }

        const isTerminalStatus = ['entregue', 'servido', 'concluido', 'finalizado', 'aguardando_fechamento', 'cancelado'].includes(status);
        if (isTerminalStatus) {
            console.log(`✅ [Bot] Pedido #${pedidoId} finalizado. Resetando estado.`);
            chats[targetJid].estado = 'normal';
            chats[targetJid].activePedidoId = null;
        } else {
            chats[targetJid].estado = 'delivery';
            chats[targetJid].activePedidoId = pedidoId;
        }

        await db.set('chats', chats).write();
        await db.get('pedidoIdToJid').set(String(pedidoId), targetJid).write();
    }

    // --- FILTRO: SILENCIAR RECEBIMENTO PARA O CLIENTE ---
    if (status === 'recebido') {
        console.log(`ℹ️ [Bot] Pedido #${pedidoId} recebido. Notificação para o cliente pulada (apenas log).`);
        return res.json({ success: true, info: 'Mensagem de recebimento desativada para o cliente' });
    }

    if (!sock || statusConexao !== 'CONECTADO') return res.status(503).json({ error: 'Bot offline' });

    try {
        const s = await sendHumanizedMessage(targetJid, { text: message });
        const rObj = { id: s.key.id, text: message, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: sock.user.id, pushName: 'Robô 🤖' };
        await saveMessage(targetJid, rObj, 'Robo');
        io.emit('new_msg', rObj);

        // --- MENSAGEM DE PESQUISA DE SATISFAÇÃO (APENAS UMA VEZ POR PEDIDO) ---
        const isSurveyStatus = ['entregue', 'servido', 'aguardando_fechamento'].includes(status);
        if (isSurveyStatus && pedidoId) {
            const surveysSent = db.get('surveysSent').value() || {};
            if (!surveysSent[pedidoId]) {
                surveysSent[pedidoId] = true;
                await db.set('surveysSent', surveysSent).write();

                const surveyMessage = `Sua opinião é muito importante para nós! ⭐\n\nComo foi sua experiência com nosso atendimento e entrega?\n\nResponda com uma nota de *1 a 5*:\n\n1️⃣ - Muito Insatisfeito\n2️⃣ - Insatisfeito\n3️⃣ - Regular\n4️⃣ - Satisfeito\n5️⃣ - Muito Satisfeito\n\nAtenciosamente,\n*Equipe GuGA Bebidas* 🍻`;
                
                setTimeout(async () => {
                    if (!sock || statusConexao !== 'CONECTADO') return;
                    try {
                        const s2 = await sendHumanizedMessage(targetJid, { text: surveyMessage });
                        if (s2) {
                            const rObj2 = { id: s2.key.id, text: surveyMessage, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: sock.user.id, pushName: 'Robô 🤖' };
                            await saveMessage(targetJid, rObj2, 'Robo');
                            io.emit('new_msg', rObj2);
                        }
                    } catch (e) { console.error('❌ [Bot] Erro ao enviar pesquisa:', e.message); }
                }, 8000); // 8 segundos após a notificação
            }
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        const rObj = { id: s.key.id, text: '🖼️ Imagem', fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: jid, pushName: "Robô 🤖", imageUrl: data.image };
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
        
        const msgObj = { id: msg.key.id, from: jid, text, fromMe, time: new Date().toLocaleTimeString('pt-BR'), sender: jid, pushName };
        await saveMessage(jid, msgObj, pushName);
        io.emit('new_msg', msgObj);

        if (fromMe) return;

        // --- TRAVA DE CAIXA FECHADO (FORA DO HORÁRIO) ---
        const chats = db.get('chats').value() || {};
        const chatData = chats[jid] || {};
        const hasActiveOrder = chatData.estado === 'delivery' && chatData.activePedidoId;

        if (!isStoreOpen() && !hasActiveOrder) {
            console.log(`🔌 [Fechado] Mensagem de ${jid} ignorada por estar fora do horário.`);
            const closedMsg = "Olá! No momento estamos *FECHADOS* 😴\n\n⏰ *Horário de Funcionamento:*\nTerça a Domingo: das 18h às 02h\n\n🏠 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\n\n_Aguardamos seu pedido em breve!_ 🍻";
            const s = await sendHumanizedMessage(jid, { text: closedMsg });
            if (s) {
                await saveMessage(jid, { id: s.key.id, text: closedMsg, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: sock.user.id, pushName: "Robô 🤖" }, "Robo");
            }
            return;
        }

        // --- TRAVA DE ATENDIMENTO HUMANO (SILÊNCIO TOTAL DO ROBÔ) ---
        if (chatData?.atendimentoManual) {
            console.log(`👤 [Humano] Atendimento manual ativo for ${jid}. Robô em silêncio.`);
            return;
        }

        // --- RESPOSTA À PESQUISA DE SATISFAÇÃO ---
        const isSurveyResponse = ['1','2','3','4','5'].includes(text) && (Date.now() - (chatData.lastUpdate || 0) < 30 * 60 * 1000); // 30 minutos de validade
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
            await sendHumanizedMessage(jid, { text: thanks });
            await saveMessage(jid, { id: 'survey-thanks-' + Date.now(), text: thanks, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: jid, pushName: "Robô 🤖" }, "Robo");
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

        const estado = chatData.estado || 'normal';
        let reply = "";

        if (estado === 'delivery' && text === '1') {
            const pId = chatData.activePedidoId;
            try {
                const resp = await fetch(`${DELIVERY_API_URL}/${pId}`);
                const ped = await resp.json();
                const stMap = { 'recebido': 'Preparando 👨‍🍳', 'preparando': 'Preparando 👨‍🍳', 'pronto': 'Pronto 🥡', 'saiu_entrega': 'A caminho 🛵', 'entregue': 'Entregue 😋' };
                reply = `📦 *ACOMPANHAMENTO DO PEDIDO #${pId}*\n\nOlá ${pushName}, identificamos o seu pedido em nosso sistema! ✨\n\n📊 *Status Atual:* *${stMap[ped.status] || ped.status}*\n\n💡 *Dica:* Fique tranquilo(a), te avisaremos assim que ele sair para entrega! 🛵💨`;
            } catch (e) { 
                console.error(`❌ Erro ao consultar status do pedido #${pId}:`, e.message);
                reply = "Erro ao consultar status. 😕"; 
            }
        } else if (estado === 'delivery' && text === '2') {
            reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nEntendido! Já acionei nossa equipe. Um de nossos atendentes falará com você em instantes para tirar suas dúvidas ou resolver qualquer problema. 🚀\n\n⏳ *Tempo médio de espera:* 2 a 5 minutos.\n\n_Por favor, aguarde um momento..._";
            chats[jid].atendimentoManual = true;
            await db.set('chats', chats).write();
            io.emit('status_atendimento', { jid, atendimentoManual: true });
        }
 else if (!['1','2','3','4','5'].includes(text)) {
            reply = `Olá ${pushName}! 👋 Seja muito bem-vindo ao *GuGA Bebidas*! 🍻\n\nComo podemos deixar o seu dia melhor hoje?\n\n1️⃣ - Ver nosso Cardápio 📖\n2️⃣ - Fazer um Pedido agora 🛒\n3️⃣ - Ver Promoções do Dia 🔥\n4️⃣ - Endereço e Horários 📍\n5️⃣ - Falar com um Atendente 👨‍💻\n\n_Basta digitar o número da opção desejada._`;
        } else {
            if (text === '1') {
                reply = "📖 *NOSSO CARDÁPIO DIGITAL*\n\nExplore todas as nossas bebidas e delícias diretamente pelo link abaixo:\n🔗 https://garconnexpress.vercel.app/delivery\n\n_Dê uma olhadinha e escolha o seu preferido!_ 😉";
            } else if (text === '2') {
                reply = "🛒 *FAZER UM PEDIDO AGORA*\n\nJá escolheu? Então não perca tempo! Peça agora pelo nosso sistema de Delivery:\n🔗 https://garconnexpress.vercel.app/delivery\n\n🚀 *Dica:* Seus dados ficam salvos para o próximo pedido ser ainda mais rápido!";
            } else if (text === '3') {
                try {
                    const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                    const menu = await response.json();
                    const promos = menu.filter(item => item.em_promocao && item.visivel);
                    if (promos.length > 0) {
                        reply = "🔥 *PROMOÇÕES IMPERDÍVEIS DE HOJE*\n\n" + promos.map(p => `✨ *${p.nome}*\n💰 Por apenas: *R$ ${parseFloat(p.preco).toFixed(2)}*\n`).join('\n') + "\n_Aproveite antes que acabe!_ 🏃💨";
                    } else {
                        reply = "No momento não temos promoções ativas, mas nossos preços continuam os melhores da região! 😉\n\nConfira tudo aqui: https://garconnexpress.vercel.app/delivery";
                    }
                } catch (e) { reply = "Ops! Tive um problema ao buscar as promoções. Mas você pode ver tudo no nosso cardápio: https://garconnexpress.vercel.app/delivery"; }
            } else if (text === '4') {
                reply = "📍 *ONDE ESTAMOS E QUANDO ABRIMOS*\n\n🏠 *Endereço:* Rua Demócrito Gracindo, 132 - Ponta Grossa\n\n⏰ *Horário de Funcionamento:*\nTerça a Domingo: das 18h às 02h\n\n_Venha nos visitar ou peça no conforto do seu sofá!_ 🏠🍻";
            } else if (text === '5') {
                reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nEntendi! Já avisei a nossa equipe. Um de nossos atendentes falará com você em instantes.\n\n_Por favor, aguarde um momento..._";
                chats[jid].atendimentoManual = true;
                await db.set('chats', chats).write();
                io.emit('status_atendimento', { jid, atendimentoManual: true });
            }
        }

        if (reply) {
            const s = await sendHumanizedMessage(jid, { text: reply });
            await saveMessage(jid, { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: jid, pushName: "Robô 🤖" }, "Robo");
        }
    });
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
    setInterval(checkInactivity, 60000); // Checa inatividade a cada 1 minuto
    setInterval(cleanupOldChats, 3600000); // Limpa chats antigos a cada 1 hora
    cleanupOldChats(); // Limpeza inicial ao ligar o robô
});
