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
// Aumentar limite para áudios base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); // 100 MB Limit for images/audio

// --- AUTO-PING PARA MANTER 24H NO RENDER ---
if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    const RENDER_URL = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}.onrender.com`;
    setInterval(() => {
        http.get(RENDER_URL, (res) => {
            console.log(`Self-ping: Status ${res.statusCode}`);
        }).on('error', (err) => {
            console.log('Self-ping error:', err.message);
        });
    }, 1000 * 60 * 10); // Ping a cada 10 minutos
}
const port = process.env.PORT || 3000;

app.use(express.static('public'));

// Rota para servir áudios baixados
if (!fs.existsSync('public/audios')) fs.mkdirSync('public/audios', { recursive: true });

let lastQr = null;
let statusConexao = "DESCONECTADO";
let sock = null;

io.on('connection', (socket) => {
    socket.emit('status', { status: statusConexao });
    if (lastQr) socket.emit('qr', lastQr);
    if (db) socket.emit('history', db.get('chats').value());

    socket.on('send_msg', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
            // Apenas enviamos. O messages.upsert cuidará de salvar e avisar o painel.
            await sock.sendMessage(jid, { text: data.text });
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
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';

            const base64Data = data.image.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');
            
            const s = await sock.sendMessage(jid, { image: buffer });
            const rObj = { id: s.key.id, text: '🖼️ Imagem enviada', fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖", imageUrl: data.image };
            
            await saveMessage(jid, rObj, "Robo");
            io.emit('new_msg', rObj);
        } catch (err) {
            console.error('Erro ao enviar imagem:', err);
        }
    });

    socket.on('send_audio', async (data) => {
        if (!sock || statusConexao !== "CONECTADO") return;
        try {
            let jid = data.number;
            if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
            
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
                        console.log('Erro na conversão ffmpeg, enviando original:', err);
                        await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                        if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
                    })
                    .on('end', async () => {
                        const oggBuffer = fs.readFileSync(tempOgg);
                        await sock.sendMessage(jid, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                        if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
                        if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg);
                    })
                    .save(tempOgg);
            } catch (ffmpegErr) {
                console.log('FFMPEG não configurado:', ffmpegErr);
                await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
            }
        } catch (e) { console.log('Erro ao enviar áudio:', e); }
    });

    socket.on('delete_chat', async (jid) => {
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                delete chats[jid];
                // Forçamos uma nova referência de objeto para o lowdb detectar a mudança
                await db.set('chats', { ...chats }).write();
                io.emit('chat_deleted', jid);
                console.log(`[Zap] Chat excluído: ${jid}`);
            }
        }
    });

    socket.on('toggle_atendimento', async (data) => {
        const { jid, status } = data;
        if (db) {
            const chats = db.get('chats').value() || {};
            if (chats[jid]) {
                chats[jid].atendimentoManual = status;
                await db.set('chats', { ...chats }).write();
                io.emit('status_atendimento', { jid, atendimentoManual: status });
            }
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
        return true; // Fallback: assume aberto para não perder vendas em caso de erro na API
    }
}

async function saveMessage(jid, msg, name) {
    if (!jid || jid.includes('@newsletter') || jid.includes('@broadcast')) return;
    
    const chats = db.get('chats').value() || {};
    if (!chats[jid]) {
        chats[jid] = { name: jid.split('@')[0], messages: [], atendimentoManual: false, unreadCount: 0, lastUpdate: Date.now() };
    }
    
    chats[jid].lastUpdate = Date.now();

    // Se a mensagem não é nossa, incrementamos o contador de não lidas.
    // EXCEÇÃO: No "Pedidos Zap" (nosso número), sempre incrementamos se chegar atividade nova.
    const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
    const isSelf = myJid && jid.includes(myJid);

    if (!msg.fromMe || isSelf) {
        chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
    }
    
    if (isSelf) {
        chats[jid].name = "Pedidos Zap 📦";
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
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'error' }), browser: Browsers.appropriate('Painel Zap'), printQRInTerminal: false });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;
            if (qr) { QRCode.toDataURL(qr).then(url => { lastQr = url; io.emit('qr', url); }); statusConexao = "AGUARDANDO QR"; io.emit('status', {status: statusConexao}); }
            if (connection === 'open') { statusConexao = "CONECTADO"; lastQr = null; io.emit('status', {status: statusConexao}); console.log('Bot Pronto'); }
            if (connection === 'close') { setTimeout(connectToWhatsApp, 5000); statusConexao = "DESCONECTADO"; io.emit('status', {status: statusConexao}); }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            const pushName = fromMe ? "Voce" : (msg.pushName || jid.split('@')[0]);
            
            let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            let audioUrl = null;
            let imageUrl = null;

            // Tratamento de Áudio Recebido
            if (msg.message.audioMessage) {
                try {
                    const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    audioUrl = `data:audio/ogg;base64,${buffer.toString('base64')}`;
                    text = "🎙️ Áudio recebido";
                } catch (err) { console.log("Erro ao baixar áudio:", err); }
            }

            // Tratamento de Imagem Recebida
            if (msg.message.imageMessage) {
                try {
                    const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    imageUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                    text = "🖼️ Imagem recebida";
                } catch (err) { console.log("Erro ao baixar imagem:", err); }
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

            await saveMessage(jid, msgObj, pushName);
            io.emit('new_msg', msgObj);

            if (fromMe) return;

            const atendimentoManual = db.get(['chats', jid, 'atendimentoManual']).value() || false;
            if (atendimentoManual) return;

            // MENU DO ROBÔ (Apenas para texto)
            if (text && text !== "🎙️ Áudio recebido") {
                // VERIFICAÇÃO DE CAIXA (ESTABELECIMENTO ABERTO/FECHADO)
                const caixaAberto = await verificarCaixaAberto();
                if (!caixaAberto) {
                    const closedMsg = `Olá ${pushName}! 👋 Agradecemos o seu contato.\n\nInformamos que nosso estabelecimento encontra-se *FECHADO* no momento.\n\n⏰ *Horário de Funcionamento:*\nDiariamente das 18h às 02:00\n\n_Aguardamos seu pedido quando estivermos abertos!_`;
                    const s = await sock.sendMessage(jid, { text: closedMsg });
                    const rObj = { id: s.key.id, text: closedMsg, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                    await saveMessage(jid, rObj, "Robo");
                    io.emit('new_msg', rObj);
                    return;
                }

                let reply = "";
                const lowerText = text.toLowerCase();

                if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                    reply = `Olá ${pushName}! 👋 Seja bem-vindo ao *GuGA Bebidas*.

Como posso te ajudar hoje?

1️⃣ - Ver Cardápio Digital 📖
2️⃣ - Fazer um Pedido 🛒
3️⃣ - Promoções do Dia 🔥
4️⃣ - Endereço e Horário 📍
5️⃣ - Falar com o Atendente 👨‍💻

_Digite apenas o número da opção desejada._`;
                } else {
                    if (lowerText === '1') {
                        reply = `📖 *CARDÁPIO DIGITAL*

Para visualizar nossos produtos, você pode acessar nosso link:
https://garconnexpress.vercel.app/cardapio/

🏠 *Dica:* Se você estiver no estabelecimento, pode fazer o pedido diretamente pelo link acima para agilizar seu atendimento!`;
                    } else if (lowerText === '2') {
                        reply = `🛒 *FAZER UM PEDIDO*

Para sua maior comodidade, pedimos que utilize o *QR Code* localizado na sua mesa. Ele abrirá o cardápio completo e você poderá realizar seu pedido de forma rápida! 🚀

💡 *Dúvidas?* Em caso de dúvida, basta chamar o garçom mais próximo ou dirigir-se ao balcão. Estamos aqui para ajudar!`;
                    } else if (lowerText === '3') {
                        try {
                            const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                            const menu = await response.json();
                            const promos = menu.filter(item => item.em_promocao && (item.visivel === true || item.visivel === 1));
                            let promoMsg = "🔥 *PROMOÇÕES DO DIA*\n\n";
                            if (promos.length > 0) {
                                promos.forEach(p => {
                                    const precoOriginal = p.preco_original ? `~R$ ${parseFloat(p.preco_original).toFixed(2)}~ ` : "";
                                    promoMsg += `✨ *${p.nome}*\n💰 ${precoOriginal}*R$ ${parseFloat(p.preco).toFixed(2)}*\n\n`;
                                });
                                promoMsg += "_Aproveite que é por tempo limitado!_";
                            } else {
                                promoMsg += "No momento não temos promoções ativas, mas fique de olho no nosso cardápio! 😉";
                            }
                            reply = promoMsg;
                        } catch (e) {
                            reply = "Desculpe, ocorreu um erro ao consultar as promoções. Tente novamente mais tarde.";
                        }
                    } else if (lowerText === '4') {
                        reply = "📍 *ENDEREÇO E HORÁRIO*\n\n🏠 Endereço: Rua Demócrito Gracindo, 132 - Ponta Grossa\n🕒 Horário: Diariamente das 18h às 02:00";
                    } else if (lowerText === '5') {
                        reply = "👨‍💻 *ATENDIMENTO HUMANO*\n\nAguarde um momento. Um atendente humano já foi notificado e irá falar com você em breve!";
                        const chats = db.get('chats').value() || {};
                        if (chats[jid]) {
                            chats[jid].atendimentoManual = true;
                            await db.set('chats', chats).write();
                            io.emit('status_atendimento', { jid, atendimentoManual: true });
                        }
                    }
                }

                if (reply) {
                    const s = await sock.sendMessage(jid, { text: reply });
                    const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "Robô 🤖" };
                    await saveMessage(jid, rObj, "Robo");
                    io.emit('new_msg', rObj);
                }
            }
        });
    } catch (err) { setTimeout(connectToWhatsApp, 5000); }
}

initDB().then(() => {
    server.listen(port, () => connectToWhatsApp());
});