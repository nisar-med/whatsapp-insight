#!/usr/bin/env node
/* eslint-disable react-hooks/rules-of-hooks */
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import next from 'next';
import crypto from 'crypto';
import { 
    makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packagedRuntime = path.basename(currentDir) === 'dist';
const dev = process.env.WHATSAPP_INSIGHTS_DEV === 'true'
    || (!packagedRuntime && process.env.NODE_ENV !== 'production');

function hasNextAppStructure(dir: string) {
    return fs.existsSync(path.join(dir, 'app')) || fs.existsSync(path.join(dir, 'pages'));
}

function resolveNextRootDir() {
    const candidates = [
        process.cwd(),
        currentDir,
        path.resolve(currentDir, '..')
    ];

    for (const candidate of candidates) {
        if (hasNextAppStructure(candidate)) {
            return candidate;
        }
    }

    return process.cwd();
}

const appRootDir = resolveNextRootDir();
const app = next({ dev, dir: appRootDir });
const handle = app.getRequestHandler();

const port = 3000;
const MESSAGE_CACHE_LIMIT = 1000;
const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 30;
const SESSION_CLEANUP_INTERVAL_MS = 1000 * 60 * 5;
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

// Logger
const logger = pino({ level: 'info' });

type SessionStatus = 'disconnected' | 'connecting' | 'connected' | 'qr_timeout';

type WhatsAppSession = {
    id: string;
    authPath: string;
    sock: any;
    isConnecting: boolean;
    status: SessionStatus;
    qrCode: string | null;
    messageStore: any[];
    chatStore: Record<string, any>;
    lastActivity: number;
};

const sessions = new Map<string, WhatsAppSession>();

function getSessionRoom(sessionId: string) {
    return `session:${sessionId}`;
}

function loadMessageStore(authPath: string): any[] {
    try {
        const filePath = path.join(authPath, 'messages.json');
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveMessageStore(session: WhatsAppSession) {
    try {
        if (!fs.existsSync(session.authPath)) return;
        fs.writeFileSync(
            path.join(session.authPath, 'messages.json'),
            JSON.stringify(session.messageStore),
            'utf-8'
        );
    } catch (e) {}
}

function getOrCreateSession(sessionId: string): WhatsAppSession {
    const existing = sessions.get(sessionId);
    if (existing) return existing;

    const authPath = path.join(process.cwd(), 'auth_info', sessionId);
    const created: WhatsAppSession = {
        id: sessionId,
        authPath,
        sock: null,
        isConnecting: false,
        status: 'disconnected',
        qrCode: null,
        messageStore: loadMessageStore(authPath),
        chatStore: {},
        lastActivity: Date.now()
    };
    sessions.set(sessionId, created);
    return created;
}

function touchSession(session: WhatsAppSession) {
    session.lastActivity = Date.now();
}

function isValidSessionId(value: unknown): value is string {
    return typeof value === 'string' && SESSION_ID_REGEX.test(value);
}

function getRequestSessionId(req: express.Request) {
    const candidate = req.query.sid;
    if (Array.isArray(candidate)) return candidate[0];
    return candidate;
}

function getSocketSessionId(socket: any) {
    const authSid = socket?.handshake?.auth?.sid;
    if (typeof authSid === 'string') return authSid;

    const querySid = socket?.handshake?.query?.sid;
    if (typeof querySid === 'string') return querySid;
    if (Array.isArray(querySid)) return querySid[0];
    return undefined;
}

function resolveSessionIdFromRequest(req: express.Request, res: express.Response) {
    const sessionId = getRequestSessionId(req);
    if (!isValidSessionId(sessionId)) {
        res.status(400).json({
            error: 'Invalid or missing session id. Pass a valid sid query parameter.'
        });
        return null;
    }
    return sessionId;
}

function extractMessageData(msg: any) {
    if (msg.key.fromMe || !msg.message) return null;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return null;
    return {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        pushName: msg.pushName,
        text,
        timestamp: Number(msg.messageTimestamp)
    };
}

function hasRoomClients(io: Server, sessionId: string) {
    const room = io.sockets.adapter.rooms.get(getSessionRoom(sessionId));
    return !!room && room.size > 0;
}

function stopSocket(session: WhatsAppSession) {
    try {
        if (session.sock) {
            session.sock.end();
        }
    } catch (e) {}
    session.sock = null;
    session.isConnecting = false;
}

function removeSession(sessionId: string, options?: { removeAuthData?: boolean }) {
    const session = sessions.get(sessionId);
    if (!session) return;

    stopSocket(session);

    if (options?.removeAuthData && fs.existsSync(session.authPath)) {
        fs.rmSync(session.authPath, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
}

async function connectToWhatsApp(sessionId: string, io: Server) {
    const session = getOrCreateSession(sessionId);
    touchSession(session);

    if (session.isConnecting) return;
    if (session.sock?.user) return;

    session.isConnecting = true;
    session.status = 'connecting';
    io.to(getSessionRoom(sessionId)).emit('whatsapp:status', session.status);

    if (!fs.existsSync(session.authPath)) {
        fs.mkdirSync(session.authPath, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(session.authPath);
        const { version } = await fetchLatestBaileysVersion();

        session.sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            browser: ["WhatsApp Insights", "Chrome", "1.0.0"]
        });

        session.sock.ev.on('creds.update', saveCreds);

        session.sock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update;

            touchSession(session);

            if (qr) {
                const qrDataUrl = await qrcode.toDataURL(qr);
                session.qrCode = qrDataUrl;
                session.status = 'disconnected';
                io.to(getSessionRoom(sessionId)).emit('whatsapp:qr', qrDataUrl);
                io.to(getSessionRoom(sessionId)).emit('whatsapp:status', session.status);
            }

            if (connection === 'close') {
                session.isConnecting = false;
                session.sock = null;

                const error = lastDisconnect?.error as any;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const errorMessage = error?.message || error?.toString() || '';

                console.log(`session ${sessionId} closed due to`, errorMessage);

                if (errorMessage.includes('QR refs attempts ended')) {
                    session.status = 'qr_timeout';
                } else {
                    session.status = 'disconnected';
                }

                io.to(getSessionRoom(sessionId)).emit('whatsapp:status', session.status);

                if (shouldReconnect && hasRoomClients(io, sessionId)) {
                    setTimeout(() => connectToWhatsApp(sessionId, io), 3000);
                }
            } else if (connection === 'open') {
                session.isConnecting = false;
                session.status = 'connected';
                session.qrCode = null;
                console.log(`session ${sessionId} opened connection`);
                io.to(getSessionRoom(sessionId)).emit('whatsapp:status', session.status);
            }
        });

        session.sock.ev.on('messaging-history.set', ({ messages: historyMessages, chats: historyChats }: any) => {
            touchSession(session);

            if (historyChats?.length) {
                historyChats.forEach((chat: any) => {
                    session.chatStore[chat.id] = chat;
                });
                io.to(getSessionRoom(sessionId)).emit('whatsapp:chats', Object.values(session.chatStore));
            }

            if (historyMessages?.length) {
                const newMessages = historyMessages.map(extractMessageData).filter(Boolean);

                if (newMessages.length > 0) {
                    session.messageStore = [...session.messageStore, ...newMessages].slice(0, MESSAGE_CACHE_LIMIT);
                    saveMessageStore(session);
                    io.to(getSessionRoom(sessionId)).emit('whatsapp:messages', session.messageStore);
                }
            }
        });

        session.sock.ev.on('messages.upsert', async (m: any) => {
            touchSession(session);

            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    const messageData = extractMessageData(msg);
                    if (messageData) {
                        session.messageStore.push(messageData);
                        if (session.messageStore.length > MESSAGE_CACHE_LIMIT) {
                            session.messageStore.shift();
                        }
                        saveMessageStore(session);
                        io.to(getSessionRoom(sessionId)).emit('whatsapp:new_message', messageData);
                    }
                }
            } else if (m.type === 'append') {
                const appendedMessages = m.messages.map(extractMessageData).filter(Boolean);

                if (appendedMessages.length > 0) {
                    session.messageStore = [...session.messageStore, ...appendedMessages].slice(0, MESSAGE_CACHE_LIMIT);
                    saveMessageStore(session);
                    io.to(getSessionRoom(sessionId)).emit('whatsapp:messages', session.messageStore);
                }
            }
        });

        session.sock.ev.on('chats.upsert', (chats: any) => {
            touchSession(session);

            chats.forEach((chat: any) => {
                session.chatStore[chat.id] = chat;
            });
            io.to(getSessionRoom(sessionId)).emit('whatsapp:chats', Object.values(session.chatStore));
        });
    } catch (error) {
        session.isConnecting = false;
        session.status = 'disconnected';
        session.sock = null;
        io.to(getSessionRoom(sessionId)).emit('whatsapp:status', session.status);
        console.error(`failed to connect session ${sessionId}:`, error);
    }
}

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

    io.on('connection', (socket) => {
        const sessionId = getSocketSessionId(socket);

        if (!isValidSessionId(sessionId)) {
            socket.emit('whatsapp:error', 'Invalid or missing session id');
            socket.disconnect(true);
            return;
        }

        const session = getOrCreateSession(sessionId);
        touchSession(session);

        socket.join(getSessionRoom(sessionId));
        socket.emit('whatsapp:status', session.status);
        if (session.qrCode) {
            socket.emit('whatsapp:qr', session.qrCode);
        }
        socket.emit('whatsapp:chats', Object.values(session.chatStore));
        socket.emit('whatsapp:messages', session.messageStore);

        if (!session.sock?.user && !session.isConnecting) {
            connectToWhatsApp(sessionId, io);
        }

        socket.on('disconnect', () => {
            const existing = sessions.get(sessionId);
            if (existing) {
                touchSession(existing);
            }
        });
    });

    setInterval(() => {
        const now = Date.now();
        for (const [sessionId, session] of sessions.entries()) {
            const hasClients = hasRoomClients(io, sessionId);
            if (!hasClients && now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
                removeSession(sessionId, { removeAuthData: false });
            }
        }
    }, SESSION_CLEANUP_INTERVAL_MS);

    // API Endpoints
    expressApp.get('/api/whatsapp/messages', (req, res) => {
        const sessionId = resolveSessionIdFromRequest(req, res);
        if (!sessionId) return;

        const session = getOrCreateSession(sessionId);
        touchSession(session);
        res.json(session.messageStore);
    });

    expressApp.get('/api/whatsapp/status', (req, res) => {
        const sessionId = resolveSessionIdFromRequest(req, res);
        if (!sessionId) return;

        const session = getOrCreateSession(sessionId);
        touchSession(session);
        res.json({ status: session.status, user: session.sock?.user || null });
    });

    expressApp.post('/api/whatsapp/retry', (req, res) => {
        const sessionId = resolveSessionIdFromRequest(req, res);
        if (!sessionId) return;

        const session = getOrCreateSession(sessionId);
        touchSession(session);
        connectToWhatsApp(sessionId, io);
        res.json({ success: true });
    });

    expressApp.post('/api/whatsapp/reset', async (req, res) => {
        const sessionId = resolveSessionIdFromRequest(req, res);
        if (!sessionId) return;

        const existing = sessions.get(sessionId);
        if (existing?.sock) {
            try {
                await existing.sock.logout();
            } catch (e) {}
        }

        removeSession(sessionId, { removeAuthData: true });
        connectToWhatsApp(sessionId, io);
        res.json({ success: true });
    });

    expressApp.post('/api/session', express.json(), (req, res) => {
        const requested = req.body?.sid;
        if (isValidSessionId(requested)) {
            getOrCreateSession(requested);
            return res.json({ sid: requested });
        }

        const sid = crypto.randomUUID().replace(/-/g, '_');
        getOrCreateSession(sid);
        return res.json({ sid });
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
