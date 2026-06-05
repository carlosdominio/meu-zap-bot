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
    await db.defaults({ chats: {} }).write();
    console.log('Banco de dados pronto');
}

const app = express();
// Aumentar limite para 뿯½뿯½udios base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); // 100 MB Limit for images/audio        

const port = 3002;

app.use(express.static('public'));
// Rota de Health Check para evitar que o Render hiberne e o servi뿯½뿯½o pare

app.get('/qr', (req, res) => {
    if (typeof statusConexao !== 'undefined' && statusConexao === 'CONECTADO') {
        res.send('<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;"> <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;"> <h1 style="color:#075e54;">뿯½œ… Bot Conectado!</h1> <p style="color:#555;">O rob뿯½뿯½ j뿯½뿯½ est뿯½뿯½ operando normalmente.</p> </div> </body></html>');
    } else if (typeof lastQr !== 'undefined' && lastQr) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;margin:0;">
                    <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
                        <h2 style="color:#075e54;margin-bottom:20px;">뿯½Ÿ“뿯½ Escaneie para Conectar</h2>
                        <div style="background:#eee;padding:20px;border-radius:10px;display:inline-block;">
                            <img src="${lastQr}" style="width:300px;height:300px;display:block;" />
                        </div>
                        <p style="margin-top:20px;color:#666;">Status: <strong style="color:#25d366;">${statusConexao}</strong></p>
                        <p style="font-size:12px;color:#999;">A p뿯½뿯½gina atualiza sozinha a cada 5 segundos.</p>
                    </div>
                    <script>setTimeout(() => { location.reload(); }, 5000);</script>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e5ddd5;"> <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;"> <h2 style="color:#075e54;">뿯½뿯½뿯½ Gerando QR Code...</h2> <p style="color:#666;">Aguarde alguns segundos e a p뿯½뿯½gina ir뿯½뿯½ carregar o c뿯½뿯½digo.</p> </div> <script>setTimeout(() => { location.reload(); }, 3000);</script> </body></html>');
    }
});

app.get('/health', (req, res) => res.send('OK'));

// ROTA PARA NOTIFICA뿯½‡뿯½•ES DE STATUS DE DELIVERY (VERCEL -> ROB뿯½”)
app.post('/api/notify-delivery', async (req, res) => {
    const { number, status, pedidoId, tempo } = req.body;
    // ATUALIZA ESTADO DE DELIVERY NO BANCO LOCAL
    let jid_norm = number ? number.split('@')[0].split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net' : '';
    const chats_db = db ? db.get('chats').value() || {} : {};
    if (db && jid_norm) {
        if (!chats_db[jid_norm]) {
            chats_db[jid_norm] = { name: jid_norm.split('@')[0], messages: [], atendimentoManual: false, unreadCount: 0, lastUpdate: Date.now(), estado: 'delivery', activePedidoId: pedidoId };
        } else {
            chats_db[jid_norm].estado = (status === 'entregue' || status === 'cancelado') ? 'normal' : 'delivery';
            if (pedidoId) chats_db[jid_norm].activePedidoId = pedidoId;
        }
        await db.set('chats', { ...chats_db }).write();
    }
    console.log(`뿯½Ÿ“뿯½ [Bot] Notifica뿯½뿯½뿯½뿯½o recebida: Status=${status}, Pedido=#${pedidoId}, N뿯½뿯½mero=${number}`);

    let jid = number ? number.split('@')[0].split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net' : '';

    let message = '';
    const tempoEstimado = tempo || '30-50 min';

    const chats = db ? db.get('chats').value() || {} : {};
    const clientName = (chats[jid] && chats[jid].name && chats[jid].name !== jid.split('@')[0]) ? chats[jid].name : 'cliente';

    switch (status) {
        case 'recebido':
            message = '뿯½œ… *PEDIDO RECEBIDO!*\n\nOl뿯½뿯½! Recebemos seu pedido #' + pedidoId + ' e ele j뿯½뿯½ foi encaminhado para a cozinha. 뿯½Ÿ뿯½뿯½\n\nFique atento para novas atualiza뿯½뿯½뿯½뿯½es! 뿯½Ÿš뿯₽';
            break;
        case 'preparando':
            message = '뿯½Ÿ‘뿯½뿯½뿯₽뿯½뿯½Ÿ뿯½뿯½ *PREPARANDO SEU PEDIDO!*\n\n뿯½“timas not뿯½뿯½cias! O chef j뿯½뿯½ come뿯½뿯½ou a preparar seu pedido #' + pedidoId + '. 뿯½Ÿ뿯½뿯½뿯½뿯½뿯½\n\nLogo ele sair뿯½뿯½ para entrega! 뿯½Ÿ›뿯½';
            break;
        case 'saiu_entrega':
            message = '뿯½Ÿ›뿯½ *SAIU PARA ENTREGA!*\n\nSeu pedido #' + pedidoId + ' j뿯½뿯½ est뿯½뿯½ a caminho! 뿯½Ÿš뿯₽\n\nPrepare a mesa que estamos chegando! 뿯½Ÿ뿯½뿯½';
            break;
        case 'entregue':
            message = '뿯½œ… *PEDIDO ENTREGUE!*\n\nSeu pedido #' + pedidoId + ' foi entregue com sucesso. Bom apetite! 뿯½Ÿ뿯½뿯½뿯½뿯½뿯½\n\nObrigado pela prefer뿯½뿯½ncia!';
            break;
        default:
            return res.status(400).json({ error: 'Status inv뿯½뿯½lido' });
    }

    // --- MODO DE SIMULA뿯½‡뿯½뿯ƽO (PARA TESTES SEM QR CODE) ---
    if (!sock || statusConexao !== 'CONECTADO') {
        console.log('뿯½š뿯½뿯½뿯½뿯½ [Bot] Bot desconectado, mas tentar뿯½뿯½ enviar assim que reconectar (ou falhar뿯½뿯½ agora).');
        // Se realmente n뿯½뿯½o houver sock, n뿯½뿯½o h뿯½뿯½ o que fazer
        if (!sock) return res.status(503).json({ error: 'Bot n뿯½뿯½o inicializado' });
    }
    // ---------------------------------------------------

    try {
        console.log(`뿯½Ÿ“뿯½ [Bot] Enviando mensagem de delivery para ${jid}...`);
        const s = await sendHumanizedMessage(jid, { text: message });

        const rObj = {
            id: s.key.id,
            text: message,
            fromMe: true,
            time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
            sender: sock.user.id,
            pushName: 'Rob뿯½뿯½ 뿯½Ÿ뿯½–'
        };

        await saveMessage(jid, rObj, 'Robo');
        io.emit('new_msg', rObj);
        res.json({ success: true });
    } catch (e) {
        console.error('뿯½뿯½Œ [Bot] Erro ao enviar notifica뿯½뿯½뿯½뿯½o de delivery:', e);
        res.status(500).json({ error: e.message });
    }
});


let lastQr = null;
let statusConexao = "DESCONECTADO";
let sock = null;

// --- FUN뿯½‡뿯½뿯ƽO DE HUMANIZA뿯½‡뿯½뿯ƽO (ANTI-BAN) ---
async function sendHumanizedMessage(jid, content, options = {}) {
    if (!sock || statusConexao !== "CONECTADO") return;
    try {
        // 1. Sinaliza presen뿯½뿯½a (digitando ou gravando)
        const presence = content.audio ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presence, jid);

        // 2. Calcula delay humano (2s a 5s base + tempo por caractere)
        let delay = 2000 + (Math.random() * 3000);
        if (content.text) {
            delay += Math.min(content.text.length * 50, 7000); // No m뿯½뿯½ximo 7s extras para textos longos
        } else if (content.image || content.audio) {
            delay += 3000; // Delay fixo para m뿯½뿯½dia
        }

        await new Promise(resolve => setTimeout(resolve, delay));

        // 3. Envia a mensagem
        const result = await sock.sendMessage(jid, content, options);

        // 4. Para sinal de presen뿯½뿯½a
        await sock.sendPresenceUpdate('paused', jid);
        return result;
    } catch (e) {
        console.error('뿯½뿯½Œ Erro no sendHumanizedMessage:', e);
        throw e;
    }
}
// ----------------------------------------

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) socket.emit('history', db.get('chats').value());

    socket.on('send_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number ? data.number.split('@')[0].split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net' : '';
            // Apenas enviamos. O messages.upsert cuidar뿯½뿯½ de salvar e avisar o painel.
            await sendHumanizedMessage(jid, { text: data.text });
        } catch (e) { console.log('Erro ao enviar texto:', e); }
    });

    socket.on('delete_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            const jid = data.jid;
            const msgId = data.id;
            const fromMe = data.fromMe;

            // Delete from WhatsApp for everyone (or just for me if time limit passed)
            await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: fromMe, id: msgId } });

            // Delete from local DB history
            const chats = db.get('chats').value() || {};
            if (chats[jid] && chats[jid].messages) {
                chats[jid].messages = chats[jid].messages.filter(m => m.id !== msgId);
                await db.set('chats', chats).write();
            }

            // Notify frontend
            io.emit('history', chats);
            console.log(`[BOT] Mensagem ${msgId} apagada com sucesso!`);
        } catch (err) {
            console.error('Erro ao deletar mensagem:', err);
        }
    });

    socket.on('send_image', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number ? data.number.split('@')[0].split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net' : '';

            const base64Data = data.image.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');

            const s = await sendHumanizedMessage(jid, { image: buffer });
            const rObj = { id: s.key.id, text: '뿯½Ÿ–뿯½뿯½뿯½뿯½ Imagem enviada', fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Rob뿯½뿯½ 뿯½Ÿ뿯½–", imageUrl: data.image };

            await saveMessage(jid, rObj, "Robo");
            io.emit('new_msg', rObj);
        } catch (err) {
            console.error('Erro ao enviar imagem:', err);
        }
    });

    socket.on('send_audio', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number ? data.number.split('@')[0].split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net' : '';

            const buffer = Buffer.from(data.audio.split(',')[1], 'base64');
            const tempWebm = path.join(__dirname, `temp_${Date.now()}.webm`);
            const tempOgg = path.join(__dirname, `temp_${Date.now()}.ogg`);

            fs.writeFileSync(tempWebm, buffer);

            try {
                const ffmpeg = require('fluent-ffmpeg');
                const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
                ffmpeg.setFfmpegPath(ffmpegPath);

                ffmpeg(tempWebm)
                    .toFormat('ogg')
                    .audioCodec('libopus')
                    .on('error', async (err) => {
                        console.log('Erro na convers뿯½뿯½o ffmpeg, enviando original:', err);
                        await sendHumanizedMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                        if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
                    })
                    .on('end', async () => {
                        const oggBuffer = fs.readFileSync(tempOgg);
                        await sendHumanizedMessage(jid, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }); 
                        if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
                        if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg);
                    })
                    .save(tempOgg);
            } catch (ffmpegErr) {
                console.log('FFMPEG n뿯½뿯½o configurado:', ffmpegErr);
                await sendHumanizedMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
            }
        } catch (e) { console.log('Erro ao enviar 뿯½뿯½udio:', e); }
    });

    socket.on('delete_chat', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                delete chats[jid];
                // For뿯½뿯½amos uma nova refer뿯½뿯½ncia de objeto para o lowdb detectar a mudan뿯½뿯½a
                await db.set('chats', { ...chats }).write();
                io.emit('chat_deleted', jid);
                console.log(`[Zap] Chat exclu뿯½뿯½do: ${jid}`);
            }
        }
    });

    socket.on('toggle_atendimento', async (data) => {
        const { jid, status } = data;
        if (db) {
            const chats = db.get('chats').value() || {};
            if (!chats[jid]) {
                // Cria o chat caso n뿯½뿯½o exista para permitir ativar atendimento manual
                chats[jid] = { name: jid.split('@')[0], messages: [], atendimentoManual: status, unreadCount: 0, lastUpdate: Date.now() };
            } else {
                chats[jid].atendimentoManual = status;
            }
            await db.set('chats', { ...chats }).write();
            io.emit('status_atendimento', { jid, atendimentoManual: status });
        }
    });

    socket.on('mark_seen', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                chats[jid].unreadCount = 0;
                await db.set('chats', { ...chats }).write();
            }
        }
    });

    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
});

async function verificarCaixaAberto() {
    try {
        const response = await fetch('https://garconnexpress.vercel.app/api/caixa/status');
        const caixa = await response.json();
        return !!caixa; // Retorna true se houver um caixa aberto
    } catch (e) {
        console.error("Erro ao verificar caixa:", e);
        return true; // Fallback: assume aberto para n뿯½뿯½o perder vendas em caso de erro na API
    }
}

async function saveMessage(jid, msg, name) {
    if (!jid || jid.includes('@newsletter') || jid.includes('@broadcast')) return;

    // Normaliza뿯½뿯½뿯½뿯½o de JID (Garante que 82... e 5582... caiam no mesmo chat)
    if (jid.endsWith('@s.whatsapp.net')) {
        let num = jid.split('@')[0].split(':')[0]; // Remove :1, :2 etc
        if (num.length === 11 && num.startsWith('82')) num = '55' + num;
        if (num.length === 10) num = '55' + num;
        jid = num + '@s.whatsapp.net';
    }


    const chats = db.get('chats').value() || {};
    if (!chats[jid]) {
        chats[jid] = { name: jid.split('@')[0], messages: [], atendimentoManual: false, unreadCount: 0, lastUpdate: Date.now() };
    }

    chats[jid].lastUpdate = Date.now();

    const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
    const isSelf = myJid && jid.includes(myJid);

    if (!msg.fromMe || isSelf) {
        chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
    }

    if (isSelf) {
        chats[jid].name = "Pedidos Zap 뿯½Ÿ“뿯½";
    } else if (name && name !== "Voce" && name !== "Robo") {
        chats[jid].name = name;
    }

    if (chats[jid].messages.some(m => m.id === msg.id)) return;

    chats[jid].messages.push(msg);
    if (chats[jid].messages.length > 100) chats[jid].messages.shift();

    await db.set('chats', { ...chats }).write();
}

async function connectToWhatsApp() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadContentFromMessage } = await import('@whiskeysockets/baileys');
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap'),  });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;
            if (qr) { 
                qrcodeTerminal.generate(qr, { small: true });
                console.log('뿯½Ÿ“뿯½ [WhatsApp] Novo QR Code gerado! Escaneie acima.');
                QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); }); 
                statusConexao = "AGUARDANDO QR"; 
                io.emit('status', {status: statusConexao}); 
            }
            if (connection === 'open') { statusConexao = "CONECTADO"; lastQr = null; io.emit('status', {status: statusConexao}); console.log('뿯½œ… Bot CONECTADO e Pronto!'); }
            if (connection === 'close') {
                const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;  
                console.log('Conex뿯½뿯½o encerrada. Motivo:', update.lastDisconnect?.error, 'Tentando reconectar:', shouldReconnect);
                if (shouldReconnect) {
                    console.log('뿯½Ÿ”„ Reconectando em 5 segundos...');
                    setTimeout(connectToWhatsApp, 5000); 
                } else {
                    console.log('뿯½š뿯½뿯½뿯½뿯½ Sess뿯½뿯½o finalizada (Logout). Removendo credenciais...');
                    if (fs.existsSync('auth_info_baileys')) {
                        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    }
                    setTimeout(connectToWhatsApp, 2000);
                }
                statusConexao = "DESCONECTADO";
                io.emit('status', {status: statusConexao});
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.message) return;

                const jid = msg.key.remoteJid;
                const fromMe = msg.key.fromMe;
                const pushName = fromMe ? "Voce" : (msg.pushName || jid.split('@')[0]);

                let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
                let audioUrl = null;
                let imageUrl = null;

                // Download de m뿯½뿯½dia simplificado
                if (msg.message.audioMessage || msg.message.imageMessage) {
                    try {
                        const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
                        const type = msg.message.audioMessage ? 'audio' : 'image';
                        const stream = await downloadContentFromMessage(msg.message[type + 'Message'], type);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                        if (type === 'audio') {
                            audioUrl = `data:audio/ogg;base64,${buffer.toString('base64')}`;
                            text = "뿯½ŸŽ뿯½ 뿯½뿯½udio recebido";
                        } else {
                            imageUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                            text = "뿯½Ÿ–뿯½뿯½뿯½뿯½ Imagem recebida";
                        }
                    } catch (err) { console.log("Erro m뿯½뿯½dia:", err.message); }
                }

                if (!text && !audioUrl && !imageUrl) return;

                const msgObj = {
                    id: msg.key.id,
                    from: jid,
                    text: text,
                    audioUrl: audioUrl,
                    imageUrl: imageUrl,
                    fromMe: fromMe,
                    time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
                    sender: jid,
                    pushName: pushName
                };

                // --- FILTRO DE POLUI뿯½‡뿯½뿯ƽO DO ADMIN (ULTRA-AGRESSIVO) ---
                const numOnly = jid ? jid.split('@')[0].split(':')[0] : ''; // Pega o n뿯½뿯½mero limpo, sem :1, :2, etc
                const isAdmin = numOnly === '558293157048';
                const isShort = numOnly.length < 8; // Bloqueia 6565686 etc
                
                // 1. Se for o Admin ou n뿯½뿯½mero curto, N뿯½뿯ƽO APARECE NO PAINEL NUNCA
                if (isAdmin || isShort) {
                    return; 
                }

                // 2. Se for uma mensagem que o PR뿯½“PRIO BOT mandou (Notifica뿯½뿯½뿯½뿯½es)
                if (fromMe) {
                    const lowText = text.toLowerCase();
                    const isSystem = lowText.includes('novo pedido') || lowText.includes('chamado') || lowText.includes('rascunho');
                    const isAutoGreet = lowText.includes('boa noite') && (lowText.includes('preparo') || lowText.includes('entrega') || lowText.includes('entregue'));
                    
                    if (isSystem || isAutoGreet) {
                        return; // N뿯½뿯½o polui o chat do admin com as mensagens autom뿯½뿯½ticas do rob뿯½뿯½
                    }
                }
                // ------------------------------------------------------

                // Salva a mensagem leg뿯½뿯½tima e avisa o painel
                await saveMessage(jid, msgObj, pushName);
                io.emit('new_msg', msgObj);

                if (fromMe) return;

                const chats = db.get('chats').value() || {};
                const atendimentoManual = (chats[jid] && chats[jid].atendimentoManual === true);

                // --- RESPOSTA AUTOM뿯½뿯½TICA DE DELIVERY (NOVO PEDIDO) ---
                // Detecta se a mensagem 뿯½뿯½ um pedido de delivery (vindo do server ou do cliente)
                const isDelivery = text.toUpperCase().includes('DELIVERY') && text.toUpperCase().includes('PEDIDO');
                
                if (isDelivery) {
                    console.log('뿯½Ÿ“뿯½ [Bot] Pedido Delivery Detectado para:', jid);
                    
                    // Ativa atendimento manual para o rob뿯½뿯½ parar de responder o menu inicial
                    if (!chats[jid]) {
                        chats[jid] = { name: jid.split('@')[0], messages: [], atendimentoManual: true, unreadCount: 0, lastUpdate: Date.now() };
                    } else {
                        chats[jid].atendimentoManual = true;
                    }
                    await db.set('chats', chats).write();
                    io.emit('status_atendimento', { jid, atendimentoManual: true });

                    // ENVIA A SAUDA뿯½‡뿯½뿯ƽO DE RECEBIMENTO (Frase exata solicitada)
                    const msgOk = "boa noite ! seu pedido foi recebdido esta em preparo e mais atuliz뿯½뿯½뿯½뿯½es em breve";
                    await sendHumanizedMessage(jid, { text: msgOk });
                    return;
                }
                // -----------------------------------------------------

                if (atendimentoManual) return;

                if (text && text !== "뿯½Ÿ’뿯½뿯½뿯½뿯½udio recebido") {
                    const caixaAberto = await verificarCaixaAberto();
                    if (!caixaAberto) {
                        const closedMsg = `Ol뿯½뿯½ ${pushName}! 뿯½Ÿ‘‹ Agradecemos o seu contato.\n\nInformamos que nosso estabelecimento encontra-se *FECHADO* no momento.\n\n뿯½Ÿ•’ *Hor뿯½뿯½rio de Funcionamento:*\nDiariamente das 18h 뿯½뿯½s 02:00 de Ter뿯½뿯½a a Domingo\n\n_Aguardamos seu pedido quando estivermos abertos!_`;
                        const s = await sendHumanizedMessage(jid, { text: closedMsg });
                        const rObj = { id: s.key.id, text: closedMsg, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Rob뿯½뿯½ 뿯½Ÿ뿯½–" };
                        await saveMessage(jid, rObj, "Robo");
                        io.emit('new_msg', rObj);
                        return;
                    }

                    let reply = "";
                    const lowerText = text.toLowerCase();
                    const chatData = chats[jid] || {};
                    const estado = chatData.estado || 'normal';

                    if (estado === 'delivery') {
                        if (!['1', '2'].includes(lowerText)) {
                            reply = `Olá ${pushName}! Seu pedido está em andamento. 🛵\n\nComo posso ajudar?\n\n1️⃣ - Ver Status do Pedido 📦\n\n2️⃣ - Falar com o Atendente 👨‍💻`;
                        } else {
                            if (lowerText === '1') {
                                const pId = chatData.activePedidoId;
                                if (!pId) {
                                    reply = "Não encontrei um pedido ativo para você no momento. 😕";
                                } else {
                                    try {
                                        const resp = await fetch(`https://garconnexpress.vercel.app/api/pedidos/${pId}`);
                                        const ped = await resp.json();
                                        const stMap = {
                                            'recebido': 'Recebido (Na fila da cozinha) 📝',
                                            'preparando': 'Sendo preparado pelo Chef 👨‍🍳',
                                            'pronto': 'Pronto e aguardando entrega! 🥡',
                                            'saiu_entrega': 'A caminho da sua casa! 🛵',
                                            'entregue': 'Entregue! Bom apetite! 😋',
                                            'cancelado': 'Cancelado ❌',
                                            'aguardando_fechamento': 'Pronto/Entregue (Aguardando finalização) ✅'
                                        };
                                        reply = `📦 *STATUS DO PEDIDO #${pId}*\n\nAtualmente seu pedido está: *${stMap[ped.status] || ped.status}*\n\nFique atento, te avisaremos qualquer mudança!`;
                                    } catch (err) {
                                        reply = "Não consegui consultar o status agora. Tente novamente em instantes! ⏳";
                                    }
                                }
                                const s = await sendHumanizedMessage(jid, { text: reply });
                                const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                                await saveMessage(jid, rObj, "Robo");
                                io.emit('new_msg', rObj);
                                return;
                            } else if (lowerText === '2') {
                                reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nAguarde um momento.\n\nUm atendente humano já foi notificado!";
                                if (chats[jid]) {
                                    chats[jid].atendimentoManual = true;
                                    await db.set('chats', chats).write();
                                    io.emit('status_atendimento', { jid, atendimentoManual: true });
                                }
                            }
                        }
                    } else if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                        reply = `Ol뿯½뿯½ ${pushName}! 뿯½Ÿ‘‹ Seja bem-vindo ao *GuGA Bebidas*.\n\nComo posso te ajudar hoje?\n\n1️⃣ - Ver Card뿯½뿯½pio Digital 뿯½Ÿ"–\n\n2️⃣ - Fazer um Pedido 뿯½Ÿ›’\n\n3️⃣ - Promo뿯½뿯½뿯½뿯½es do Dia 뿯½Ÿ”뿯½\n\n4️⃣ - Endere뿯½뿯½o e Hor뿯½뿯½rio 뿯½Ÿ"뿯½\n\n5️⃣ - Falar com o Atendente 뿯½Ÿ'뿯½뿯½뿯₽뿯½뿯½Ÿ’뿯½\n\n_Digite apenas o n뿯½뿯½mero da op뿯½뿯½뿯½뿯½o desejada._`;
                    } else {
                        if (lowerText === '1') {
                            reply = "뿯½Ÿ"– *CARD뿯½뿯½PIO DIGITAL*\n\nPara visualizar nossos produtos, voc뿯½뿯½ pode acessar nosso link:\nhttps://garconnexpress.vercel.app/cardapio/\n\n뿯½Ÿ뿯½뿯½ *Dica:* Se voc뿯½뿯½ estiver no estabelecimento, pode fazer o pedido diretamente pelo link acima para agilizar seu atendimento!";
                        } else if (lowerText === '2') {
                            reply = "뿯½Ÿ›’ *FAZER UM PEDIDO*\n\nPara sua maior comodidade, utilize o link do nosso Card뿯½뿯½pio Digital:\nhttps://garconnexpress.vercel.app/cardapio/\n\n뿯½Ÿ"뿯½ *Dica:* Se estiver no estabelecimento, use o *QR Code* na sua mesa para um pedido mais r뿯½뿯½pido!\n\n뿯½Ÿš뿯₽뿯½Ÿ’뿯½ *D뿯½뿯½vidas?*\nBasta chamar o gar뿯½뿯½om ou dirigir-se ao balc뿯½뿯½o.";
                        } else if (lowerText === '3') {
                            try {
                                const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                                const menu = await response.json();
                                const promos = menu.filter(item => (item.em_promocao === true || item.em_promocao === 1) && (item.visivel === true || item.visivel === 1));
                                let promoMsg = "뿯½Ÿ”뿯½ *PROMO뿯½‡뿯½•ES DO DIA*\n\n";
                                if (promos.length > 0) {
                                    promos.forEach(p => {
                                        const precoOriginal = p.preco_original ? "~R$ " + parseFloat(p.preco_original).toFixed(2) + "~ " : "";
                                        promoMsg += "뿯½œ뿯½ *" + p.nome + "*\n뿯½Ÿ’뿯½ " + precoOriginal + "*R$ " + parseFloat(p.preco).toFixed(2) + "*\n\n";
                                    });
                                    promoMsg += "_Aproveite que 뿯½뿯½ por tempo limitado!_";
                                } else {
                                    promoMsg += "No momento n뿯½뿯½o temos promo뿯½뿯½뿯½뿯½es ativas, mas fique de olho no nosso card뿯½뿯½pio! 뿯½Ÿ뿯ʽ‰";
                                }
                                reply = promoMsg;
                            } catch (e) { reply = "Desculpe, ocorreu um erro ao consultar as promo뿯½뿯½뿯½뿯½es."; }
                        } else if (lowerText === '4') {
                            reply = "뿯½Ÿ"뿯½ *ENDERE뿯½‡O E HOR뿯½뿯½RIO*\n\n뿯½Ÿ뿯½뿯½ *Endere뿯½뿯½o:* Rua Dem뿯½뿯½crito Gracindo, 132 - Ponta Grossa\n\n뿯½뿯½뿯½ *Hor뿯½뿯½rio:* Diariamente das 18h 뿯½뿯½s 02:00 de Ter뿯½뿯½a a Domingo";
                        } else if (lowerText === '5') {
                            reply = "뿯½Ÿ'뿯½뿯½뿯₽뿯½뿯½Ÿ’뿯½ *ATENDIMENTO HUMANO*\n\nAguarde um momento.\n\nUm atendente humano j뿯½뿯½ foi notificado e ir뿯½뿯½ falar com voc뿯½뿯½ em breve!";
                            const chats = db.get('chats').value() || {};
                            if (chats[jid]) {
                                chats[jid].atendimentoManual = true;
                                await db.set('chats', chats).write();
                                io.emit('status_atendimento', { jid, atendimentoManual: true });
                            }
                        }
                    }

                    if (reply) {
                        const s = await sendHumanizedMessage(jid, { text: reply });
                        const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Rob뿯½뿯½ 뿯½Ÿ뿯½–" };
                        await saveMessage(jid, rObj, "Robo");
                        io.emit('new_msg', rObj);
                    }
                }
            } catch (e) { console.error('Erro no processamento:', e); }
        });
    } catch (err) {
        console.error('Erro na conexão:', err);
        setTimeout(connectToWhatsApp, 5000);
    }
}
