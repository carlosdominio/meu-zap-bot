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
    await db.defaults({ chats: {}, pedidoIdToJid: {} }).write();
    console.log('✅ Banco de dados pronto');
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

const port = 3002;
const DELIVERY_API_URL = process.env.DELIVERY_API_URL || 'http://localhost:3001/api/pedidos';

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
// 3. ATUALIZAÇÃO DE ESTADO NO DB
if (db) {
    if (!chats[targetJid]) {
        chats[targetJid] = { name: targetJid.split('@')[0], messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'delivery', activePedidoId: pedidoId };
    }

    // TERMINAL STATUS: Se entregue, concluído ou cancelado, volta para o estado normal
    const isTerminalStatus = ['entregue', 'servido', 'concluido', 'finalizado', 'aguardando_fechamento', 'cancelado'].includes(status);

    if (isTerminalStatus) {
        console.log(`✅ [Bot] Pedido #${pedidoId} finalizado. Resetando estado do cliente ${targetJid} para normal.`);
        chats[targetJid].estado = 'normal';
        chats[targetJid].activePedidoId = null; // Limpa o ID ativo
    } else {
        chats[targetJid].estado = 'delivery';
        chats[targetJid].activePedidoId = pedidoId;
    }

    await db.set('chats', chats).write();
    await db.get('pedidoIdToJid').set(String(pedidoId), targetJid).write();
}

    if (!sock || statusConexao !== 'CONECTADO') return res.status(503).json({ error: 'Bot offline' });

    try {
        const s = await sendHumanizedMessage(targetJid, { text: message });
        const rObj = { id: s.key.id, text: message, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: sock.user.id, pushName: 'Robô 🤖' };
        await saveMessage(targetJid, rObj, 'Robo');
        io.emit('new_msg', rObj);
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
    if (db) socket.emit('history', db.get('chats').value());

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
    if (!chats[jid]) chats[jid] = { name: jid.split('@')[0], messages: [], unreadCount: 0, lastUpdate: Date.now(), estado: 'normal' };
    chats[jid].lastUpdate = Date.now();
    if (!msg.fromMe) chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
    if (name && name !== "Voce" && name !== "Robo") chats[jid].name = name;
    if (chats[jid].messages.some(m => m.id === msg.id)) return;
    chats[jid].messages.push(msg);
    if (chats[jid].messages.length > 100) chats[jid].messages.shift();
    await db.set('chats', chats).write();
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
                console.log('🔄 Reconectando em 5s...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('⚠️ Sessão finalizada. Limpando dados...');
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

        const isOrder = text.includes('🛍️ *NOVO PEDIDO - DELIVERY*') || text.includes('🛵 DELIVERY');
        if (isOrder) {
            const pId = (text.match(/#(\d+)/) || [])[1];
            if (pId) {
                await db.get('pedidoIdToJid').set(String(pId), jid).write();
                const chats = db.get('chats').value();
                chats[jid].activePedidoId = pId; chats[jid].estado = 'delivery';
                await db.set('chats', chats).write();
                
                const richWelcome = `Olá ${pushName}! 👋\n\n🛍️ *PEDIDO RECEBIDO COM SUCESSO!*\n\nObrigado por escolher o *GuGA Bebidas*. Seu pedido *#${pId}* já caiu em nosso sistema e está na fila de preparo! 🚀\n\n💡 *O que acontece agora?*\nAssim que seu pedido for para a entrega, você será notificado aqui no Zap!\n\n👇 *Opções:* \n1️⃣ - Ver Status Atual 🛵\n2️⃣ - Falar com Atendente 👨‍💻`;
                
                await sendHumanizedMessage(jid, { text: richWelcome });
                return;
            }
        }

        const chats = db.get('chats').value() || {};
        const chatData = chats[jid] || {};
        const estado = chatData.estado || 'normal';
        let reply = "";

        if (estado === 'delivery' && text === '1') {
            const pId = chatData.activePedidoId;
            try {
                const resp = await fetch(`${DELIVERY_API_URL}/${pId}`);
                const ped = await resp.json();
                const stMap = { 'recebido': 'Recebido 📝', 'preparando': 'Preparando 👨‍🍳', 'pronto': 'Pronto 🥡', 'saiu_entrega': 'A caminho 🛵', 'entregue': 'Entregue 😋' };
                reply = `📦 *STATUS #${pId}*: *${stMap[ped.status] || ped.status}*`;
            } catch (e) { reply = "Erro ao consultar status. 😕"; }
        } else if (estado === 'delivery' && text === '2') {
            reply = "👨‍💻 Aguarde um momento, um atendente já foi notificado!";
        } else if (!['1','2','3','4','5'].includes(text)) {
            reply = `Olá ${pushName}! 👋 Bem-vindo ao *GuGA Bebidas*.\n\n1️⃣ - Ver Cardápio Digital 📖\n2️⃣ - Fazer um Pedido 🛒\n3️⃣ - Promoções 🔥\n4️⃣ - Endereço/Horário 📍\n5️⃣ - Atendente 👨‍💻`;
        } else {
            if (text === '1') reply = "📖 Cardápio: https://garconnexpress.vercel.app/cardapio/";
            else if (text === '2') reply = "🛒 Peça aqui: https://garconnexpress.vercel.app/cardapio/";
            else if (text === '3') {
                const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                const menu = await response.json();
                const promos = menu.filter(item => item.em_promocao && item.visivel);
                reply = promos.length ? "🔥 *PROMOÇÕES:* \n" + promos.map(p => `✨ *${p.nome}* - R$ ${p.preco}`).join('\n') : "Sem promoções hoje. 😉";
            }
            else if (text === '4') reply = "📍 Rua Demócrito Gracindo, 132 - Ponta Grossa\n⏰ 18h às 02h (Ter a Dom)";
            else if (text === '5') reply = "👨‍💻 Atendente notificado! Aguarde.";
        }

        if (reply) {
            const s = await sendHumanizedMessage(jid, { text: reply });
            await saveMessage(jid, { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR'), sender: jid, pushName: "Robô 🤖" }, "Robo");
        }
    });
}

initDB().then(() => server.listen(port, () => connectToWhatsApp()));
