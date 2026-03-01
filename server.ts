/* eslint-disable react-hooks/rules-of-hooks */
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import next from 'next';
import { 
    makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const port = 3000;

// Logger
const logger = pino({ level: 'info' });

// In-memory store for messages (simplified)
const messageStore: any[] = [];
const chatStore: any = {};

async function startServer() {
    await app.prepare();
    const expressApp = express();
    const httpServer = createServer(expressApp);
    const io = new Server(httpServer, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    // WhatsApp logic
    let sock: any;
    let isConnecting = false;
    
    const connectToWhatsApp = async () => {
        if (isConnecting) return;
        if (sock?.user) return;

        isConnecting = true;
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            browser: ["WhatsApp Insight", "Chrome", "1.0.0"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                const qrDataUrl = await qrcode.toDataURL(qr);
                io.emit('whatsapp:qr', qrDataUrl);
            }

            if (connection === 'close') {
                isConnecting = false;
                const error = lastDisconnect?.error as any;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const errorMessage = error?.message || error?.toString() || '';
                
                console.log('connection closed due to ', errorMessage);
                
                if (errorMessage.includes('QR refs attempts ended')) {
                    console.log('QR attempts ended. Waiting for user to retry.');
                    io.emit('whatsapp:status', 'qr_timeout');
                } else {
                    io.emit('whatsapp:status', 'disconnected');
                    if (shouldReconnect) {
                        setTimeout(() => connectToWhatsApp(), 3000);
                    }
                }
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('opened connection');
                io.emit('whatsapp:status', 'connected');
            }
        });

        sock.ev.on('messages.upsert', async (m: any) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                        if (text) {
                            const messageData = {
                                id: msg.key.id,
                                remoteJid: msg.key.remoteJid,
                                pushName: msg.pushName,
                                text: text,
                                timestamp: msg.messageTimestamp
                            };
                            messageStore.push(messageData);
                            // Keep only last 1000 messages
                            if (messageStore.length > 1000) messageStore.shift();
                            io.emit('whatsapp:new_message', messageData);
                        }
                    }
                }
            }
        });

        sock.ev.on('chats.upsert', (chats: any) => {
            chats.forEach((chat: any) => {
                chatStore[chat.id] = chat;
            });
            io.emit('whatsapp:chats', Object.values(chatStore));
        });
    };

    io.on('connection', (socket) => {
        console.log('Client connected');
        if (!sock?.user && !isConnecting) {
            connectToWhatsApp();
        }
    });

    // API Endpoints
    expressApp.get('/api/whatsapp/messages', (req, res) => {
        res.json(messageStore);
    });

    expressApp.get('/api/whatsapp/status', (req, res) => {
        res.json({ status: sock?.user ? 'connected' : 'disconnected', user: sock?.user });
    });

    expressApp.post('/api/whatsapp/retry', (req, res) => {
        connectToWhatsApp();
        res.json({ success: true });
    });

    expressApp.post('/api/whatsapp/reset', async (req, res) => {
        try {
            if (sock) {
                sock.logout();
                sock.end();
            }
        } catch (e) {}
        
        const authPath = path.join(process.cwd(), 'auth_info');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        
        connectToWhatsApp();
        res.json({ success: true });
    });

    // Next.js handler
    expressApp.all('/{*any}', (req, res) => {
        return handle(req, res);
    });

    httpServer.listen(port, () => {
        console.log(`> Ready on http://localhost:${port}`);
    });
}

startServer().catch(err => {
    console.error('Error starting server:', err);
});
