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
const io = new Server(server, { cors: { origin: "*" } });
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
                // ForÃ§amos uma nova referÃªncia de objeto para o lowdb detectar a mudanÃ§a
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
    // EXCEÃÂÃÂO: No "Pedidos Zap" (nosso número), sempre incrementamos se chegar atividade nova.
    const myJid = sock?.user?.id?.split(':')[0]?.split('@')[0];
    const isSelf = myJid && jid.includes(myJid);

    if (!msg.fromMe || isSelf) {
        chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
    }
    
    if (isSelf) {
        chats[jid].name = "Pedidos Zap Ã°ÂÂÂ¦";
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

            // Tratamento de ÃÂudio Recebido
            if (msg.message.audioMessage) {
                try {
                    const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    audioUrl = `data:audio/ogg;base64,${buffer.toString('base64')}`;
                    text = "Ã°ÂÂÂ¤ ÃÂudio recebido";
                } catch (err) { console.log("Erro ao baixar áudio:", err); }
            }

            if (!text && !audioUrl) return;

            const msgObj = { 
                id: msg.key.id, 
                from: jid,
                text: text, 
                audioUrl: audioUrl,
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

            // MENU DO ROBÃÂ (Apenas para texto)
            if (text && text !== "Ã°ÂÂÂ¤ ÃÂudio recebido") {
                // VERIFICAÃÂÃÂO DE CAIXA (ESTABELECIMENTO ABERTO/FECHADO)
                const caixaAberto = await verificarCaixaAberto();
                if (!caixaAberto) {
                    const closedMsg = `Olá ${pushName}! Ã°ÂÂÂ Agradecemos o seu contato.\n\nInformamos que nosso estabelecimento encontra-se *FECHADO* no momento.\n\nâ° *Horário de Funcionamento:*\nDiariamente das 18h Ã s 02:00\n\n_Aguardamos seu pedido quando estivermos abertos!_`;
                    const s = await sock.sendMessage(jid, { text: closedMsg });
                    const rObj = { id: s.key.id, text: closedMsg, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "RobÃ´ Ã°ÂÂ¤Â" };
                    await saveMessage(jid, rObj, "Robo");
                    io.emit('new_msg', rObj);
                    return;
                }

                let reply = "";
                const lowerText = text.toLowerCase();

                if (!['1', '2', '3', '4', '5'].includes(lowerText)) {
                    reply = `Olá ${pushName}! Ã°ÂÂÂ Seja bem-vindo ao *GuGA Bebidas*.\n\nComo posso te ajudar hoje?\n\n1Ã¯Â¸ÂÃ¢ÂÂ£ - Ver Cardápio Digital Ã°ÂÂÂ\n2Ã¯Â¸ÂÃ¢ÂÂ£ - Fazer um Pedido Ã°ÂÂÂ\n3Ã¯Â¸ÂÃ¢ÂÂ£ - PromoÃ§ões do Dia Ã°ÂÂÂ¥\n4Ã¯Â¸ÂÃ¢ÂÂ£ - EndereÃ§o e Horário Ã°ÂÂÂ\n5Ã¯Â¸ÂÃ¢ÂÂ£ - Falar com o Atendente Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ»\n\n_Digite apenas o número da opção desejada._`;
                } else {
                    if (lowerText === '1') {
                        reply = `Ã°ÂÂÂ *CARDÃÂPIO DIGITAL*\n\nPara visualizar nossos produtos, vocÃª pode acessar nosso link:\nhttps://garconnexpress.vercel.app/cardapio/\n\nÃ°ÂÂÂ¡ *Dica:* Se vocÃª estiver em uma de nossas mesas, utilize o *QR Code* fixado nela para fazer o seu pedido diretamente!`;
                    } else if (lowerText === '2') {
                        reply = `Ã°ÂÂÂ *FAZER UM PEDIDO*\n\nPara sua maior comodidade, pedimos que utilize o *QR Code* localizado na sua mesa. Ele abrirá o cardápio completo e vocÃª poderá realizar seu pedido de forma rápida! Ã°ÂÂÂ\n\nÃ°ÂÂÂ¬ *Dúvidas?* Em caso de dúvida, basta chamar o garÃ§om mais próximo ou dirigir-se ao balcão. Estamos aqui para ajudar!`;
                    } else if (lowerText === '3') {
                        try {
                            const response = await fetch('https://garconnexpress.vercel.app/api/menu');
                            const menu = await response.json();
                            const promos = menu.filter(item => item.em_promocao && (item.visivel === true || item.visivel === 1));
                            let promoMsg = "Ã°ÂÂÂ¥ *PROMOÃÂÃÂES DO DIA*\n\n";
                            if (promos.length > 0) {
                                promos.forEach(p => {
                                    const precoOriginal = p.preco_original ? `~R$ ${parseFloat(p.preco_original).toFixed(2)}~ ` : "";
                                    promoMsg += `Ã¢ÂÂ *${p.nome}*\nÃ°ÂÂÂ° ${precoOriginal}*R$ ${parseFloat(p.preco).toFixed(2)}*\n\n`;
                                });
                                promoMsg += "_Aproveite que é por tempo limitado!_";
                            } else {
                                promoMsg += "No momento não temos promoÃ§ões ativas, mas fique de olho no nosso cardápio! Ã°ÂÂÂ";
                            }
                            reply = promoMsg;
                        } catch (e) {
                            reply = "Ã°ÂÂÂ¥ *PROMOÃÂÃÂES DO DIA*\n\nNo momento não conseguimos carregar as promoÃ§ões. Por favor, tente novamente em instantes ou veja no nosso cardápio digital!";
                        }
                    } else if (lowerText === '4') {
                        reply = "Ã°ÂÂÂ *ENDEREÃÂO E HORÃÂRIO*\n\nÃ°ÂÂÂ  EndereÃ§o: rua democrito gracindo 132 ponta grossa\nâ° Horário: Diariamente das 18h Ã s 02:00";
                    } else if (lowerText === '5') {
                        reply = "Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ» *ATENDIMENTO HUMANO*\n\nAguarde um momento. Um atendente humano já foi notificado e irá falar com vocÃª em breve!";
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
                    const rObj = { id: s.key.id, text: reply, fromMe: true, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), sender: jid, pushName: "RobÃ´ Ã°ÂÂ¤Â" };
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