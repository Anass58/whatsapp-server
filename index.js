const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Server } = require('socket.io');
const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// CORS - dual approach for maximum compatibility with reverse proxies
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Backup manual CORS headers (in case cors package is stripped by reverse proxy)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

app.use(express.json());

// Create media directories
const MEDIA_DIR = path.join(__dirname, 'media');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve media files statically
app.use('/media', express.static(MEDIA_DIR));

// Multer config for file uploads
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 64 * 1024 * 1024 } // 64MB max
});

// Store active sessions dynamically
const sessions = new Map();

// ============================================
// WhatsApp Connection
// ============================================

// Check if WARP proxy is reachable
async function checkProxyHealth(proxyUrl) {
    try {
        const agent = new SocksProxyAgent(proxyUrl);
        const https = require('https');
        return new Promise((resolve) => {
            const req = https.get('https://web.whatsapp.com', { agent, timeout: 10000 }, (res) => {
                resolve(true);
                req.destroy();
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    } catch (e) {
        return false;
    }
}

async function connectToWhatsApp(phone, socketId = null) {
    if (!phone) return;

    // Close any existing session for this phone first to avoid duplicates
    const existingSession = sessions.get(phone);
    if (existingSession && existingSession.sock) {
        existingSession._isLoggingOut = true;
        try { existingSession.sock.ev.removeAllListeners(); } catch(e) {}
        try { existingSession.sock.end(undefined); } catch(e) {}
        sessions.delete(phone);
    }

    try {
        const authBaseDir = path.join(__dirname, 'auth_info_baileys');
        const sessionDir = path.join(authBaseDir, phone);
        if (!fs.existsSync(authBaseDir)) {
            fs.mkdirSync(authBaseDir, { recursive: true });
        }
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        // Fetch the correct WhatsApp Web version
        // The 405 error was caused by using wrong version numbers
        let version;
        try {
            // First try Baileys' built-in version fetch
            const versionInfo = await fetchLatestWaWebVersion({});
            version = versionInfo.version;
            console.log(`Baileys fetched WA Web version: ${version}`);
            
            // Verify it looks reasonable (major version should be 2, minor < 10000)
            if (!version || version[0] !== 2 || version[1] > 10000) {
                console.log('Fetched version looks suspicious, fetching from WhatsApp directly...');
                throw new Error('Suspicious version');
            }
        } catch (e) {
            console.log('Baileys version fetch failed or suspicious:', e.message);
            // Fetch directly from WhatsApp's check-update API
            try {
                const https = require('https');
                const waVersion = await new Promise((resolve, reject) => {
                    const req = https.get('https://web.whatsapp.com/check-update?version=2.2413.51&platform=web', { timeout: 10000 }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                const json = JSON.parse(data);
                                if (json.currentVersion) {
                                    const parts = json.currentVersion.split('.').map(Number);
                                    console.log(`WhatsApp check-update returned: ${json.currentVersion} → [${parts}]`);
                                    resolve(parts);
                                } else {
                                    reject(new Error('No currentVersion'));
                                }
                            } catch (pe) { reject(pe); }
                        });
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                });
                version = waVersion;
            } catch (e2) {
                console.log('WhatsApp check-update also failed:', e2.message);
                // Hardcoded fallback — verified working as of 2026-03-11
                version = [2, 2413, 51];
                console.log(`Using hardcoded fallback version: ${version}`);
            }
        }
        console.log(`Final WhatsApp Web version: [${version}]`);

        // Connect directly — WARP proxy is not accessible from this container
        // HTTPS test confirms direct WhatsApp access works
        console.log('Connecting directly to WhatsApp (no proxy)');

        const sockOptions = {
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: "error" }), // Reduce noisy logs
            browser: ['Domira CRM', 'Chrome', '2.2413.51'], // Better browser setting to avoid 405 error
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 500,
            markOnlineOnConnect: false,
            syncFullHistory: false
        };
        if (version) sockOptions.version = version;

        console.log(`Creating WhatsApp socket for ${phone}...`);
        const sock = makeWASocket(sockOptions);

        // Store session info
        sessions.set(phone, {
            sock: sock,
            qrCodeData: '',
            isConnected: false,
            lastError: null,
            chats: new Map(),
            _retryCount: 0,
            _isLoggingOut: false
        });

    // --- Connection events ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(phone);
        if (!session) return;

        if (qr) {
            session.qrCodeData = qr;
            session._retryCount = 0; // Reset retry count when QR is generated
            console.log(`Sending QR code to frontend for ${phone}...`);
            io.emit('qr_update', { phone: phone, qr: qr });
        }

        if (connection === 'close') {
            session.isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown error';
            const errorStack = lastDisconnect?.error?.stack || '';
            const errorData = lastDisconnect?.error?.data || lastDisconnect?.error?.output?.payload || null;
            session.lastError = errorMsg;
            session._lastDisconnectDetails = {
                statusCode,
                message: errorMsg,
                stack: errorStack.split('\n').slice(0, 5).join('\n'),
                data: errorData,
                timestamp: new Date().toISOString()
            };

            console.log(`\n=== CONNECTION CLOSED for ${phone} ===`);
            console.log(`  Status Code: ${statusCode}`);
            console.log(`  Error: ${errorMsg}`);
            console.log(`  Stack: ${errorStack.split('\n').slice(0, 3).join(' | ')}`);
            console.log(`  Data:`, JSON.stringify(errorData));
            console.log(`===================================\n`);

            // If intentionally logging out, don't reconnect
            if (session._isLoggingOut) {
                console.log(`Skipping reconnect for ${phone} — intentional logout`);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            session._retryCount = (session._retryCount || 0) + 1;
            console.log(`Reconnecting: ${shouldReconnect}, retry #${session._retryCount}`);

            if (shouldReconnect) {
                // If we have no QR and session failed, auth files are likely stale
                // Delete them immediately to force fresh QR generation instead of waiting 3 retries
                const hasNoQr = !session.qrCodeData;
                if (session._retryCount >= 3 || (hasNoQr && session._retryCount >= 1)) {
                    console.log(`Retry #${session._retryCount} for ${phone} with no QR — deleting auth for fresh start`);
                    const authDir = path.join(__dirname, 'auth_info_baileys', phone);
                    if (fs.existsSync(authDir)) {
                        try {
                            fs.rmSync(authDir, { recursive: true, force: true });
                            console.log(`Deleted stale auth files for ${phone}`);
                        } catch (e) { console.error('Delete failed:', e.message); }
                    }
                    session._retryCount = 0;
                }
                io.emit('connection_status', { phone: phone, status: 'reconnecting', error: session.lastError });
                setTimeout(() => connectToWhatsApp(phone), 3000);
            } else {
                // Logged out — fully clean up the session
                io.emit('connection_status', { phone: phone, status: 'logged_out' });
                console.log(`Logged out for ${phone}. Cleaning up session.`);
                session.qrCodeData = '';
                session.isConnected = false;
                // Delete auth files so next connection starts fresh
                const authDir = path.join(__dirname, 'auth_info_baileys', phone);
                if (fs.existsSync(authDir)) {
                    try {
                        fs.rmSync(authDir, { recursive: true, force: true });
                        console.log(`Deleted auth files for ${phone} after logout`);
                    } catch (e) {
                        console.error(`Failed to delete auth dir:`, e.message);
                    }
                }
                sessions.delete(phone);
                // Do NOT auto-reconnect after logout
            }
        } else if (connection === 'open') {
            console.log(`opened connection for ${phone}`);
            session.isConnected = true;
            session.qrCodeData = '';
            session.lastError = null;
            session._retryCount = 0;
            io.emit('connection_status', { phone: phone, status: 'connected' });

            // Sync chats after connection
            syncChats(phone);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- Chat updates (sync) ---
    sock.ev.on('chats.upsert', (chats) => {
        const session = sessions.get(phone);
        if (!session) return;
        chats.forEach(chat => {
            session.chats.set(chat.id, chat);
        });
    });

    sock.ev.on('chats.update', (updates) => {
        const session = sessions.get(phone);
        if (!session) return;
        updates.forEach(update => {
            const existing = session.chats.get(update.id) || {};
            session.chats.set(update.id, { ...existing, ...update });
        });
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        const session = sessions.get(phone);
        if (!session) return;
        contacts.forEach(contact => {
            const chatId = contact.id;
            const existing = session.chats.get(chatId) || {};
            session.chats.set(chatId, { ...existing, contactName: contact.name || contact.notify || existing.contactName });
        });
    });

    sock.ev.on('contacts.update', (contacts) => {
        const session = sessions.get(phone);
        if (!session) return;
        contacts.forEach(contact => {
            const chatId = contact.id;
            const existing = session.chats.get(chatId) || {};
            if (contact.name || contact.notify) {
                session.chats.set(chatId, { ...existing, contactName: contact.name || contact.notify });
            }
        });
    });

    // --- History sync (Baileys v7 - this is how ALL chats/contacts come in) ---
    sock.ev.on('messaging-history.set', (data) => {
        const session = sessions.get(phone);
        if (!session) return;

        const { chats: historyChats, contacts: historyContacts, messages: historyMessages } = data;

        // Process chats from history
        if (historyChats && historyChats.length > 0) {
            console.log(`History sync: ${historyChats.length} chats for ${phone}`);
            historyChats.forEach(chat => {
                if (!chat.id || chat.id === 'status@broadcast') return;
                const existing = session.chats.get(chat.id) || {};
                session.chats.set(chat.id, {
                    ...existing,
                    id: chat.id,
                    name: chat.name || existing.name,
                    notify: chat.notify || existing.notify,
                    conversationTimestamp: chat.conversationTimestamp || existing.conversationTimestamp,
                    unreadCount: chat.unreadCount || existing.unreadCount || 0
                });
            });
        }

        // Process contacts from history
        if (historyContacts && historyContacts.length > 0) {
            console.log(`History sync: ${historyContacts.length} contacts for ${phone}`);
            historyContacts.forEach(contact => {
                if (!contact.id) return;
                const existing = session.chats.get(contact.id) || {};
                session.chats.set(contact.id, {
                    ...existing,
                    id: contact.id,
                    contactName: contact.name || contact.notify || existing.contactName
                });
            });
        }

        // Process messages from history (extract last message per chat)
        if (historyMessages && historyMessages.length > 0) {
            console.log(`History sync: ${historyMessages.length} messages for ${phone}`);
            historyMessages.forEach(msg => {
                const jid = msg.key?.remoteJid;
                if (!jid || jid === 'status@broadcast') return;
                const existing = session.chats.get(jid) || {};
                const msgTime = (msg.messageTimestamp?.low || msg.messageTimestamp || 0) * 1000;
                if (msgTime > (existing.lastMessageTime || 0)) {
                    const content = extractMessageContent(msg);
                    session.chats.set(jid, {
                        ...existing,
                        id: jid,
                        lastMessage: content.text || `[${content.mediaType}]`,
                        lastMessageTime: msgTime
                    });
                }
            });
        }

        // Emit updated chat list
        emitChatList(phone);
    });

    // --- Alternative chats.set event (some Baileys versions) ---
    sock.ev.on('chats.set', (data) => {
        const session = sessions.get(phone);
        if (!session) return;
        const chatArray = data.chats || data;
        if (!Array.isArray(chatArray)) return;
        console.log(`chats.set: ${chatArray.length} chats for ${phone}`);
        chatArray.forEach(chat => {
            if (!chat.id || chat.id === 'status@broadcast') return;
            const existing = session.chats.get(chat.id) || {};
            session.chats.set(chat.id, {
                ...existing,
                id: chat.id,
                name: chat.name || existing.name,
                conversationTimestamp: chat.conversationTimestamp || existing.conversationTimestamp,
                unreadCount: chat.unreadCount || existing.unreadCount || 0
            });
        });
        emitChatList(phone);
    });

    // --- Message events ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const session = sessions.get(phone);
        if (!session) return;

        for (const msg of m.messages) {
            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid === 'status@broadcast') continue;

            // Handle reaction messages separately
            const rawMsg = msg.message;
            if (rawMsg?.reactionMessage) {
                io.emit('reaction_update', {
                    phone: phone,
                    remoteJid: remoteJid,
                    targetMessageId: rawMsg.reactionMessage.key?.id,
                    emoji: rawMsg.reactionMessage.text || '',
                    fromMe: msg.key.fromMe,
                    participant: msg.key.participant || remoteJid
                });
                continue;
            }

            const isGroup = remoteJid.endsWith('@g.us');
            const chatPhone = remoteJid.split('@')[0];
            const isFromMe = msg.key.fromMe;

            // Extract message content
            const msgContent = extractMessageContent(msg);

            // Download media if present
            let mediaPath = null;
            if (msgContent.mediaType !== 'text' && msg.message) {
                try {
                    mediaPath = await downloadAndSaveMedia(msg, phone);
                } catch (e) {
                    console.error('Error downloading media:', e.message);
                }
            }

            // Get contact name
            const contactName = getContactName(session, remoteJid, msg);

            // Extract quoted message info
            const quotedInfo = extractQuotedInfo(msg);

            // Emit to frontend
            const messageData = {
                phone: phone,
                chatPhone: chatPhone,
                remoteJid: remoteJid,
                messageId: msg.key.id,
                isFromMe: isFromMe,
                isGroup: isGroup,
                contactName: contactName,
                text: msgContent.text,
                mediaType: msgContent.mediaType,
                mediaUrl: mediaPath ? `/media/${path.basename(mediaPath)}` : null,
                mediaMime: msgContent.mediaMime,
                mediaFilename: msgContent.mediaFilename,
                timestamp: (msg.messageTimestamp?.low || msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
                pushName: msg.pushName || null,
                quotedMessage: quotedInfo
            };

            io.emit('new_message', messageData);

            // Update chat in session
            const chatData = session.chats.get(remoteJid) || {};
            session.chats.set(remoteJid, {
                ...chatData,
                id: remoteJid,
                contactName: contactName || chatData.contactName,
                lastMessage: msgContent.text || `[${msgContent.mediaType}]`,
                lastMessageTime: messageData.timestamp,
                unreadCount: isFromMe ? 0 : (chatData.unreadCount || 0) + 1
            });

            // Emit chat list update
            emitChatList(phone);
        }
    });

    // --- Message status updates ---
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            if (update.update?.status) {
                const statusMap = { 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read' };
                io.emit('message_status', {
                    phone: phone,
                    messageId: update.key.id,
                    remoteJid: update.key.remoteJid,
                    status: statusMap[update.update.status] || 'sent'
                });
            }
        }
    });

    // --- Message Deletions ---
    sock.ev.on('messages.delete', (item) => {
        if ('all' in item) {
            io.emit('message_deleted', { phone: phone, jid: item.jid, all: true });
        } else if ('keys' in item) {
            for (const key of item.keys) {
                io.emit('message_deleted', { phone: phone, jid: key.remoteJid, messageId: key.id });
            }
        }
    });

    // --- Presence Updates (typing/recording) ---
    sock.ev.on('presence.update', (data) => {
        if (!data.id) return;
        io.emit('presence_update', { phone: phone, jid: data.id, presences: data.presences });
    });

    } catch (err) {
        console.error(`CRITICAL: Failed to create WhatsApp socket for ${phone}:`, err.message);
        // Store a stub session so /api/status can report the error
        sessions.set(phone, {
            sock: null,
            qrCodeData: '',
            isConnected: false,
            lastError: `Socket creation failed: ${err.message}`,
            chats: new Map(),
            _retryCount: 0,
            _isLoggingOut: false
        });
        io.emit('connection_status', { phone: phone, status: 'reconnecting', error: err.message });
        // Retry after 5 seconds
        setTimeout(() => connectToWhatsApp(phone), 5000);
    }
}

// ============================================
// Helper Functions
// ============================================

function extractQuotedInfo(msg) {
    try {
        let m = msg.message;
        if (!m) return null;
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

        // Find contextInfo in any message type
        const types = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
        let ctx = null;
        for (const t of types) {
            if (m[t]?.contextInfo?.quotedMessage) {
                ctx = m[t].contextInfo;
                break;
            }
        }
        if (!ctx) return null;

        const qm = ctx.quotedMessage;
        let quotedText = '';
        if (qm.conversation) quotedText = qm.conversation;
        else if (qm.extendedTextMessage?.text) quotedText = qm.extendedTextMessage.text;
        else if (qm.imageMessage?.caption) quotedText = qm.imageMessage.caption || '📷 صورة';
        else if (qm.videoMessage?.caption) quotedText = qm.videoMessage.caption || '🎬 فيديو';
        else if (qm.audioMessage) quotedText = '🎤 رسالة صوتية';
        else if (qm.documentMessage) quotedText = `📄 ${qm.documentMessage.fileName || 'مستند'}`;
        else if (qm.imageMessage) quotedText = '📷 صورة';
        else if (qm.videoMessage) quotedText = '🎬 فيديو';
        else if (qm.stickerMessage) quotedText = '🏷️ ملصق';

        return {
            messageId: ctx.stanzaId,
            participant: ctx.participant || null,
            text: quotedText
        };
    } catch (e) {
        return null;
    }
}

function extractMessageContent(msg) {
    let m = msg.message;
    if (!m) return { text: '', mediaType: 'text', mediaMime: null, mediaFilename: null };

    // Baileys v7: unwrap nested message wrappers
    // These wrappers contain the real message inside .message
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    if (m.editedMessage) m = m.editedMessage.message;
    if (m.templateMessage?.hydratedTemplate) m = m.templateMessage.hydratedTemplate;
    if (m.buttonsMessage) m = { conversation: m.buttonsMessage.contentText || '' };
    if (m.listMessage) m = { conversation: m.listMessage.description || m.listMessage.title || '' };

    if (!m) return { text: '', mediaType: 'text', mediaMime: null, mediaFilename: null };

    // Text messages
    if (m.conversation) return { text: m.conversation, mediaType: 'text', mediaMime: null, mediaFilename: null };
    if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaType: 'text', mediaMime: null, mediaFilename: null };

    // Image
    if (m.imageMessage) return {
        text: m.imageMessage.caption || '',
        mediaType: 'image',
        mediaMime: m.imageMessage.mimetype || 'image/jpeg',
        mediaFilename: null
    };

    // Video
    if (m.videoMessage) return {
        text: m.videoMessage.caption || '',
        mediaType: 'video',
        mediaMime: m.videoMessage.mimetype || 'video/mp4',
        mediaFilename: null
    };

    // Audio / Voice Note
    if (m.audioMessage) return {
        text: '',
        mediaType: m.audioMessage.ptt ? 'voice' : 'audio',
        mediaMime: m.audioMessage.mimetype || 'audio/ogg',
        mediaFilename: null
    };

    // Document
    if (m.documentMessage) return {
        text: m.documentMessage.caption || '',
        mediaType: 'document',
        mediaMime: m.documentMessage.mimetype || 'application/octet-stream',
        mediaFilename: m.documentMessage.fileName || 'document'
    };

    // Sticker
    if (m.stickerMessage) return {
        text: '',
        mediaType: 'sticker',
        mediaMime: m.stickerMessage.mimetype || 'image/webp',
        mediaFilename: null
    };

    // Location
    if (m.locationMessage) return {
        text: `📍 ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}`,
        mediaType: 'location',
        mediaMime: null,
        mediaFilename: null
    };

    // Contact
    if (m.contactMessage) return {
        text: m.contactMessage.displayName || 'جهة اتصال',
        mediaType: 'contact',
        mediaMime: null,
        mediaFilename: null
    };

    // Contact array
    if (m.contactsArrayMessage) return {
        text: m.contactsArrayMessage.displayName || 'جهات اتصال',
        mediaType: 'contact',
        mediaMime: null,
        mediaFilename: null
    };

    // Protocol message (ignore)
    if (m.protocolMessage || m.reactionMessage || m.pollCreationMessage || m.pollUpdateMessage) {
        return { text: '', mediaType: 'text', mediaMime: null, mediaFilename: null };
    }

    // Log unknown message types for debugging
    const keys = Object.keys(m).filter(k => !['messageContextInfo', 'senderKeyDistributionMessage'].includes(k));
    console.log('Unknown message type. Keys:', keys, 'Full:', JSON.stringify(m).substring(0, 300));

    return { text: '', mediaType: 'text', mediaMime: null, mediaFilename: null };
}

async function downloadAndSaveMedia(msg, phone) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        let m = msg.message;

        // Unwrap Baileys v7 message wrappers (same as extractMessageContent)
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
        if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

        let ext = 'bin';
        const mediaMsg = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
        if (mediaMsg?.mimetype) {
            ext = mime.extension(mediaMsg.mimetype) || 'bin';
        }
        if (m.documentMessage?.fileName) {
            ext = path.extname(m.documentMessage.fileName).slice(1) || ext;
        }

        const filename = `${phone}_${msg.key.id}.${ext}`;
        const filepath = path.join(MEDIA_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        return filepath;
    } catch (e) {
        console.error('Media download failed:', e.message);
        return null;
    }
}

function getContactName(session, remoteJid, msg) {
    // 1. From contacts/chats cache
    const chatInfo = session.chats.get(remoteJid);
    if (chatInfo?.contactName) return chatInfo.contactName;
    if (chatInfo?.name) return chatInfo.name;

    // 2. From pushName
    if (msg?.pushName) return msg.pushName;

    // 3. Return phone number
    return remoteJid.split('@')[0];
}

// NOTE: syncChats and emitChatList are defined below in the "Chat Sync Functions" section

// ============================================
// Reconnect existing sessions on startup
// ============================================

function reconnectExistingSessions() {
    const baseDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(baseDir)) return;
    const folders = fs.readdirSync(baseDir).filter(f => {
        const fullPath = path.join(baseDir, f);
        return fs.statSync(fullPath).isDirectory();
    });
    folders.forEach(phone => {
        console.log(`Auto-reconnecting existing session for ${phone}`);
        connectToWhatsApp(phone);
    });
}
reconnectExistingSessions();

// ============================================
// API Endpoints
// ============================================

// --- Network Test ---
app.get('/api/test-network', async (req, res) => {
    const dns = require('dns').promises;
    const https = require('https');
    const results = {};

    try {
        const addresses = await dns.resolve4('web.whatsapp.com');
        results.dns_whatsapp = { success: true, addresses };
    } catch (e) {
        results.dns_whatsapp = { success: false, error: e.message };
    }

    try {
        const result = await new Promise((resolve, reject) => {
            const httpReq = https.get('https://web.whatsapp.com', { timeout: 10000 }, (httpRes) => {
                resolve({ success: true, statusCode: httpRes.statusCode });
            });
            httpReq.on('error', (e) => reject(e));
            httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Timeout')); });
        });
        results.https_whatsapp = result;
    } catch (e) {
        results.https_whatsapp = { success: false, error: e.message };
    }

    try {
        const pkg = require('@whiskeysockets/baileys/package.json');
        results.baileys_version = pkg.version;
    } catch (e) {
        results.baileys_version = 'unknown';
    }

    results.node_version = process.version;

    // Test WARP proxy connectivity
    const warpProxy = process.env.WARP_PROXY || '';
    if (warpProxy) {
        try {
            const net = require('net');
            // Parse proxy URL to get host and port
            const proxyMatch = warpProxy.match(/:\/\/([^:]+):(\d+)/);
            if (proxyMatch) {
                const [, host, port] = proxyMatch;
                const tcpResult = await new Promise((resolve) => {
                    const socket = new net.Socket();
                    socket.setTimeout(5000);
                    socket.on('connect', () => { socket.destroy(); resolve({ success: true, host, port }); });
                    socket.on('error', (e) => { socket.destroy(); resolve({ success: false, host, port, error: e.message }); });
                    socket.on('timeout', () => { socket.destroy(); resolve({ success: false, host, port, error: 'Timeout' }); });
                    socket.connect(parseInt(port), host);
                });
                results.warp_proxy_tcp = tcpResult;
            }
            // Also test through proxy
            const proxyHealth = await checkProxyHealth(warpProxy);
            results.warp_proxy_https = { success: proxyHealth, url: warpProxy };
        } catch (e) {
            results.warp_proxy_test = { success: false, error: e.message };
        }
    } else {
        results.warp_proxy_tcp = { skipped: true, reason: 'WARP_PROXY not set' };
    }

    // Check if inside Docker and network mode
    try {
        const hostname = require('os').hostname();
        const networkInterfaces = require('os').networkInterfaces();
        const interfaces = Object.keys(networkInterfaces);
        results.container_info = { hostname, interfaces };
    } catch (e) {}

    res.json(results);
});

// --- Debug Info ---
app.get('/api/debug', (req, res) => {
    const sessionDebug = {};
    sessions.forEach((data, phone) => {
        sessionDebug[phone] = {
            connected: data.isConnected,
            hasSocket: !!data.sock,
            hasQr: !!data.qrCodeData,
            qrLength: (data.qrCodeData || '').length,
            error: data.lastError,
            disconnectDetails: data._lastDisconnectDetails || null,
            retryCount: data._retryCount,
            isLoggingOut: data._isLoggingOut,
            chatCount: data.chats?.size || 0
        };
    });
    
    // Check auth dirs
    const authBaseDir = path.join(__dirname, 'auth_info_baileys');
    let authDirs = [];
    try {
        if (fs.existsSync(authBaseDir)) {
            authDirs = fs.readdirSync(authBaseDir);
        }
    } catch (e) {}

    res.json({
        sessions: sessionDebug,
        authDirectories: authDirs,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: {
            warpProxy: process.env.WARP_PROXY || 'not set',
            port: process.env.PORT || 3000,
            nodeVersion: process.version
        }
    });
});

// --- Start Session ---
app.post('/api/start', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });

    const formattedPhone = phone.replace(/[^0-9]/g, '');

    if (sessions.has(formattedPhone)) {
        const session = sessions.get(formattedPhone);
        return res.json({
            success: true,
            status: session.isConnected ? 'connected' : 'connecting',
            qr: session.isConnected ? null : session.qrCodeData
        });
    }

    console.log(`Starting new WhatsApp session for ${formattedPhone}`);
    connectToWhatsApp(formattedPhone);
    res.json({ success: true, status: 'initializing' });
});

// --- Request Pairing Code (alternative to QR) ---
app.post('/api/request-pairing-code', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });

    const formattedPhone = phone.replace(/[^0-9]/g, '');
    const session = sessions.get(formattedPhone);

    if (!session || !session.sock) {
        return res.status(400).json({ success: false, error: 'Session not found. Call /api/start first.' });
    }

    if (session.isConnected) {
        return res.json({ success: true, status: 'already_connected' });
    }

    try {
        const code = await session.sock.requestPairingCode(formattedPhone);
        console.log(`Pairing code for ${formattedPhone}: ${code}`);
        io.emit('pairing_code', { phone: formattedPhone, code: code });
        res.json({ success: true, code: code });
    } catch (e) {
        console.error('Pairing code request failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- Disconnect Session (keeps auth on disk) ---
app.post('/api/disconnect', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    const session = sessions.get(phone);
    if (session && session.sock) {
        try { session.sock.end(undefined); } catch (e) { /* ignore */ }
        session.isConnected = false;
        session.qrCodeData = '';
    }
    // Keep auth files — don't delete auth_info_baileys_*
    // Keep the session in memory so it can auto-reconnect
    console.log(`Disconnected ${phone} (auth files preserved)`);
    io.emit('connection_status', { phone, status: 'disconnected' });
    res.json({ success: true });
});

// --- Logout Session (deletes auth files — forces new QR scan) ---
app.post('/api/logout', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    // Collect ALL sessions to logout
    const phonesToLogout = [phone];
    sessions.forEach((data, p) => {
        if (!phonesToLogout.includes(p)) phonesToLogout.push(p);
    });

    for (const p of phonesToLogout) {
        const session = sessions.get(p);
        if (session) {
            session._isLoggingOut = true;
            if (session.sock) {
                // CRITICAL: Remove ALL event listeners BEFORE closing socket
                // This prevents creds.update from recreating auth files after deletion
                try { session.sock.ev.removeAllListeners(); } catch (e) { /* ignore */ }
                try { session.sock.end(undefined); } catch (e) { /* ignore */ }
            }
            sessions.delete(p);
        }

        // Delete auth files from disk
        const authDir = path.join(__dirname, 'auth_info_baileys', p);
        if (fs.existsSync(authDir)) {
            try {
                fs.rmSync(authDir, { recursive: true, force: true });
                console.log(`Deleted auth files for ${p}`);
            } catch (e) {
                console.error(`Failed to delete auth dir for ${p}:`, e.message);
                // Try again synchronously multiple times if locked
                let retries = 3;
                while (retries > 0 && fs.existsSync(authDir)) {
                    try {
                        require('child_process').execSync(`rm -rf "${authDir}"`); // Fallback for Linux
                    } catch (err2) {}
                    retries--;
                }
            }
        }
        console.log(`Logged out ${p} — session fully deleted`);
    }

    io.emit('connection_status', { phone, status: 'logged_out' });
    res.json({ success: true });
});

// --- Session Status ---
// --- Force Reset (nuclear option — delete everything) ---
app.post('/api/force-reset', (req, res) => {
    console.log('FORCE RESET — killing ALL sessions and auth files');
    
    // Close all active sessions
    sessions.forEach((session, p) => {
        if (session.sock) {
            session._isLoggingOut = true;
            try { session.sock.ev.removeAllListeners(); } catch(e) {}
            try { session.sock.end(undefined); } catch(e) {}
        }
    });
    sessions.clear();
    
    // Delete all auth directories
    const authBaseDir = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authBaseDir)) {
        try {
            fs.rmSync(authBaseDir, { recursive: true, force: true });
            fs.mkdirSync(authBaseDir, { recursive: true });
            console.log('Deleted ALL auth files');
        } catch (e) {
            console.error('Force reset delete failed:', e.message);
        }
    }
    
    io.emit('connection_status', { phone: 'all', status: 'logged_out' });
    res.json({ success: true, message: 'All sessions and auth files deleted' });
});

app.get('/api/status', (req, res) => {
    const { phone } = req.query;

    if (phone) {
        const session = sessions.get(phone);

        // Check if auth folder exists (session data on disk)
        const authDir = path.join(__dirname, 'auth_info_baileys', phone);
        const authExists = fs.existsSync(authDir);

        if (!session) {
            if (authExists) {
                // Session exists on disk but not in memory — auto-reconnect
                console.log(`Auto-reconnecting from /api/status for ${phone}`);
                connectToWhatsApp(phone);
                return res.json({ connected: false, exists: true, needsScan: false, qr: null, error: null });
            }
            // No session at all — needs QR scan
            return res.json({ connected: false, exists: false, needsScan: true, qr: null, error: null });
        }

        return res.json({
            exists: true,
            connected: session.isConnected,
            needsScan: false,
            qr: session.isConnected ? null : session.qrCodeData,
            error: session.lastError
        });
    }

    const allSessions = {};
    sessions.forEach((data, p) => {
        allSessions[p] = {
            connected: data.isConnected,
            qr: data.isConnected ? null : data.qrCodeData,
            error: data.lastError
        };
    });
    res.json(allSessions);
});

// --- Get Chat List ---
app.get('/api/chats', (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    const session = sessions.get(phone);
    if (!session) return res.json({ chats: [] });

    const chatList = [];
    session.chats.forEach((chat, jid) => {
        if (jid === 'status@broadcast' || !jid.includes('@')) return;
        chatList.push({
            jid: jid,
            phone: jid.split('@')[0],
            name: chat.contactName || chat.name || chat.notify || chat.subject || jid.split('@')[0],
            isGroup: jid.endsWith('@g.us'),
            lastMessage: chat.lastMessage || '',
            lastMessageTime: chat.lastMessageTime || 0,
            unreadCount: chat.unreadCount || 0
        });
    });

    chatList.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    res.json({ chats: chatList });
});

// --- Send Text Message ---
app.post('/api/sendText', async (req, res) => {
    try {
        const { senderPhone, number, text, jid: rawJid, quotedMessageId, quotedFromMe } = req.body;
        if (!senderPhone) return res.status(400).json({ success: false, error: 'Sender Phone required' });

        const session = sessions.get(senderPhone);
        if (!session || !session.isConnected || !session.sock) {
            return res.status(500).json({ success: false, error: `WhatsApp not connected for ${senderPhone}` });
        }

        if (!text) return res.status(400).json({ success: false, error: 'Text required' });

        // Determine the target JID
        let targetJid;
        if (rawJid && rawJid.includes('@')) {
            // Full JID provided — use directly (supports @s.whatsapp.net, @g.us, @lid)
            targetJid = rawJid;
        } else if (number) {
            // Only phone number provided — create standard JID
            const cleanNumber = number.replace(/[^0-9]/g, '');
            targetJid = `${cleanNumber}@s.whatsapp.net`;
        } else {
            return res.status(400).json({ success: false, error: 'Number or JID required' });
        }

        let sendOptions = {};
        if (quotedMessageId) {
            sendOptions.quoted = {
                key: { id: quotedMessageId, remoteJid: targetJid, fromMe: quotedFromMe || false },
                message: { conversation: '' }
            };
        }

        console.log(`Sending message to ${targetJid} from ${senderPhone}`);
        const msg = await session.sock.sendMessage(targetJid, { text: text }, sendOptions);
        res.json({ success: true, messageId: msg.key.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Get Profile Picture ---
app.get('/api/profilePic', async (req, res) => {
    try {
        const { phone, jid } = req.query;
        if (!phone || !jid) return res.status(400).json({ url: null });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) {
            return res.json({ url: null });
        }

        try {
            const url = await session.sock.profilePictureUrl(jid, 'image');
            res.json({ url: url || null });
        } catch (e) {
            // No profile pic or not accessible
            res.json({ url: null });
        }
    } catch (e) {
        res.json({ url: null });
    }
});

// --- Send Media Message ---
app.post('/api/sendMedia', upload.single('file'), async (req, res) => {
    try {
        const { senderPhone, number, caption, mediaType, jid: rawJid, quotedMessageId, quotedFromMe } = req.body;
        if (!senderPhone || !req.file) {
            return res.status(400).json({ success: false, error: 'senderPhone and file required' });
        }

        const session = sessions.get(senderPhone);
        if (!session || !session.isConnected || !session.sock) {
            return res.status(500).json({ success: false, error: `WhatsApp not connected for ${senderPhone}` });
        }

        // Determine the target JID
        let jid;
        if (rawJid && rawJid.includes('@')) {
            jid = rawJid;
        } else if (number) {
            let cleanNum = number.replace(/[^0-9]/g, '');
            jid = `${cleanNum}@s.whatsapp.net`;
        } else {
            return res.status(400).json({ success: false, error: 'Number or JID required' });
        }

        const fileBuffer = fs.readFileSync(req.file.path);
        const fileMime = req.file.mimetype;
        let sendPayload = {};

        if (mediaType === 'image' || fileMime.startsWith('image/')) {
            sendPayload = { image: fileBuffer, caption: caption || '' };
        } else if (mediaType === 'video' || fileMime.startsWith('video/')) {
            sendPayload = { video: fileBuffer, caption: caption || '' };
        } else if (mediaType === 'audio' || mediaType === 'voice' || fileMime.startsWith('audio/')) {
            sendPayload = { audio: fileBuffer, mimetype: fileMime, ptt: mediaType === 'voice' };
        } else {
            sendPayload = {
                document: fileBuffer,
                mimetype: fileMime,
                fileName: req.file.originalname,
                caption: caption || ''
            };
        }

        let sendOptions = {};
        if (quotedMessageId) {
            sendOptions.quoted = {
                key: { id: quotedMessageId, remoteJid: jid, fromMe: quotedFromMe || false },
                message: { conversation: '' }
            };
        }

        const msg = await session.sock.sendMessage(jid, sendPayload, sendOptions);

        // Save sent media to media dir
        const ext = path.extname(req.file.originalname) || '.bin';
        const savedFilename = `${senderPhone}_${msg.key.id}${ext}`;
        const savedPath = path.join(MEDIA_DIR, savedFilename);
        fs.copyFileSync(req.file.path, savedPath);

        // Clean up upload
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            messageId: msg.key.id,
            mediaUrl: `/media/${savedFilename}`
        });
    } catch (error) {
        console.error('Error sending media:', error);
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Get All Contacts with Names ---
app.get('/api/contacts', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    const session = sessions.get(phone);
    if (!session || !session.isConnected) {
        return res.json({ contacts: [], error: 'Not connected' });
    }

    const contacts = [];
    session.chats.forEach((chat, jid) => {
        if (jid === 'status@broadcast' || !jid.includes('@')) return;

        const chatPhone = jid.split('@')[0];
        const isGroup = jid.endsWith('@g.us');
        const name = chat.contactName || chat.name || chat.notify || chat.subject || chatPhone;

        contacts.push({
            jid: jid,
            phone: chatPhone,
            name: name,
            isGroup: isGroup,
            conversationTimestamp: chat.conversationTimestamp || chat.lastMessageTime || 0
        });
    });

    // Sort by name
    contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ contacts: contacts, total: contacts.length });
});

// --- Force Sync All Contacts ---
app.post('/api/syncContacts', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    const session = sessions.get(phone);
    if (!session || !session.isConnected || !session.sock) {
        return res.json({ success: false, error: 'Not connected' });
    }

    try {
        // Force contacts refresh from WhatsApp
        const store = session.sock.store;

        // Re-emit current chat list to force frontend sync
        emitChatList(phone);

        const contacts = [];
        session.chats.forEach((chat, jid) => {
            if (jid === 'status@broadcast' || !jid.includes('@')) return;
            const chatPhone = jid.split('@')[0];
            contacts.push({
                jid: jid,
                phone: chatPhone,
                name: chat.contactName || chat.name || chat.notify || chat.subject || chatPhone,
                isGroup: jid.endsWith('@g.us')
            });
        });

        res.json({ success: true, contacts: contacts, total: contacts.length });
    } catch (e) {
        console.error('Sync contacts error:', e);
        res.json({ success: false, error: e.message });
    }
});

// NOTE: Duplicate /api/disconnect route removed — the primary one is defined above (line ~756)

// ============================================
// Extra WhatsApp Features
// ============================================

// --- Delete Message ---
app.post('/api/deleteMessage', async (req, res) => {
    try {
        const { phone, jid, messageId, fromMe } = req.body;
        if (!phone || !jid || !messageId) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        await session.sock.sendMessage(jid, {
            delete: {
                remoteJid: jid,
                fromMe: fromMe !== false,
                id: messageId,
                participant: fromMe === false ? jid : undefined
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- React to Message ---
app.post('/api/react', async (req, res) => {
    try {
        const { phone, jid, messageId, emoji } = req.body;
        if (!phone || !jid || !messageId || !emoji) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        await session.sock.sendMessage(jid, {
            react: {
                text: emoji,
                key: { remoteJid: jid, id: messageId, fromMe: false }
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Group Management: Create ---
app.post('/api/groups/create', async (req, res) => {
    try {
        const { phone, subject, participants } = req.body; // participants: array of JIDs
        if (!phone || !subject || !participants || !Array.isArray(participants)) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        const group = await session.sock.groupCreate(subject, participants);
        res.json({ success: true, group });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Group Management: Update Participants ---
app.post('/api/groups/participants', async (req, res) => {
    try {
        const { phone, groupId, participants, action } = req.body; // action: 'add', 'remove', 'promote', 'demote'
        if (!phone || !groupId || !participants || !action) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        const responses = await session.sock.groupParticipantsUpdate(groupId, participants, action);
        res.json({ success: true, responses });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Group Management: Leave ---
app.post('/api/groups/leave', async (req, res) => {
    try {
        const { phone, groupId } = req.body;
        if (!phone || !groupId) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        await session.sock.groupLeave(groupId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Group Management: Update Group Info ---
app.post('/api/groups/update', async (req, res) => {
    try {
        const { phone, groupId, subject, description } = req.body;
        if (!phone || !groupId) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        if (subject) await session.sock.groupUpdateSubject(groupId, subject);
        if (description) await session.sock.groupUpdateDescription(groupId, description);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Send Presence (Typing/Recording) ---
app.post('/api/presence', async (req, res) => {
    try {
        const { phone, jid, presence } = req.body; // presence: 'composing', 'paused', 'recording'
        if (!phone || !jid || !presence) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        await session.sock.sendPresenceUpdate(presence, jid);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Block/Unblock ---
app.post('/api/block', async (req, res) => {
    try {
        const { phone, jid, action } = req.body; // action: 'block', 'unblock'
        if (!phone || !jid || !action) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        await session.sock.updateBlockStatus(jid, action);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Group Info ---
app.get('/api/groups/info', async (req, res) => {
    try {
        const { phone, groupId } = req.query;
        if (!phone || !groupId) return res.status(400).json({ success: false, error: 'Missing parameters' });

        const session = sessions.get(phone);
        if (!session || !session.isConnected || !session.sock) return res.status(500).json({ success: false, error: 'Not connected' });

        const metadata = await session.sock.groupMetadata(groupId);
        let profilePic = null;
        try { profilePic = await session.sock.profilePictureUrl(groupId, 'image'); } catch (e) { /* no pic */ }

        res.json({
            success: true,
            group: {
                id: metadata.id,
                subject: metadata.subject,
                description: metadata.desc || '',
                owner: metadata.owner,
                creation: metadata.creation,
                size: metadata.size || metadata.participants?.length || 0,
                profilePic: profilePic,
                participants: (metadata.participants || []).map(p => ({
                    jid: p.id,
                    phone: p.id.split('@')[0],
                    admin: p.admin || null
                }))
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================
// Chat Sync Functions  
// ============================================

function syncChats(phone) {
    const session = sessions.get(phone);
    if (!session || !session.isConnected || !session.sock) return;

    // Delay to allow Baileys to populate chats from store
    setTimeout(async () => {
        try {
            const sock = session.sock;

            // Try to fetch groups
            try {
                const groups = await sock.groupFetchAllParticipating();
                if (groups) {
                    for (const [jid, group] of Object.entries(groups)) {
                        const existing = session.chats.get(jid) || {};
                        session.chats.set(jid, {
                            ...existing,
                            id: jid,
                            name: group.subject || existing.name,
                            contactName: group.subject || existing.contactName,
                            isGroup: true
                        });
                    }
                }
            } catch (e) {
                console.log('Could not fetch groups:', e.message);
            }

            console.log(`syncChats: ${session.chats.size} chats for ${phone}`);
            emitChatList(phone);
        } catch (e) {
            console.error('syncChats error:', e.message);
        }
    }, 3000);
}

function emitChatList(phone) {
    const session = sessions.get(phone);
    if (!session) return;

    const chatList = [];
    session.chats.forEach((chat, jid) => {
        if (jid === 'status@broadcast' || !jid.includes('@')) return;

        const chatPhone = jid.split('@')[0];
        const isGroup = jid.endsWith('@g.us');

        chatList.push({
            jid: jid,
            phone: chatPhone,
            name: chat.contactName || chat.name || chat.notify || chat.subject || chatPhone,
            isGroup: isGroup,
            lastMessage: chat.lastMessage || '',
            lastMessageTime: chat.lastMessageTime || (chat.conversationTimestamp ? chat.conversationTimestamp * 1000 : 0),
            unreadCount: chat.unreadCount || 0
        });
    });

    chatList.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    console.log(`Emitting ${chatList.length} chats for ${phone}`);
    io.emit('chats_sync', { phone: phone, chats: chatList });
}

// ============================================
// Socket.IO
// ============================================

io.on('connection', (socket) => {
    console.log('Dashboard connected to socket');

    socket.on('request_status', (data) => {
        const phone = data?.phone;
        if (phone && sessions.has(phone)) {
            const session = sessions.get(phone);
            socket.emit('connection_status', {
                phone: phone,
                status: session.isConnected ? 'connected' : 'disconnected'
            });
            if (!session.isConnected && session.qrCodeData) {
                socket.emit('qr_update', { phone: phone, qr: session.qrCodeData });
            }
            if (session.isConnected) {
                emitChatList(phone);
            }
        }
    });

    socket.on('mark_read', async (data) => {
        const { phone, jid } = data;
        const session = sessions.get(phone);
        if (session?.sock && session.isConnected) {
            try {
                await session.sock.readMessages([{ remoteJid: jid }]);
                const chat = session.chats.get(jid);
                if (chat) {
                    chat.unreadCount = 0;
                    emitChatList(phone);
                }
            } catch (e) {
                console.error('Error marking read:', e.message);
            }
        }
    });

    // --- Send Media via Socket.IO (bypasses CORS/Traefik issues) ---
    socket.on('send_media', async (data, callback) => {
        try {
            const { senderPhone, jid, number, mediaType, caption, fileName, fileMime, fileBase64, quotedMessageId, quotedFromMe } = data;
            if (!senderPhone || !fileBase64) {
                return callback({ success: false, error: 'Missing required fields' });
            }

            const session = sessions.get(senderPhone);
            if (!session || !session.isConnected || !session.sock) {
                return callback({ success: false, error: `WhatsApp not connected for ${senderPhone}` });
            }

            // Determine target JID
            let targetJid;
            if (jid && jid.includes('@')) {
                targetJid = jid;
            } else if (number) {
                const cleanNum = number.replace(/[^0-9]/g, '');
                targetJid = `${cleanNum}@s.whatsapp.net`;
            } else {
                return callback({ success: false, error: 'Number or JID required' });
            }

            // Decode base64 to buffer
            const fileBuffer = Buffer.from(fileBase64, 'base64');
            const mime = fileMime || 'application/octet-stream';

            // Build Baileys send payload
            let sendPayload = {};
            if (mediaType === 'image' || mime.startsWith('image/')) {
                sendPayload = { image: fileBuffer, caption: caption || '' };
            } else if (mediaType === 'video' || mime.startsWith('video/')) {
                sendPayload = { video: fileBuffer, caption: caption || '' };
            } else if (mediaType === 'audio' || mediaType === 'voice' || mime.startsWith('audio/')) {
                sendPayload = { audio: fileBuffer, mimetype: mime, ptt: mediaType === 'voice' };
            } else {
                sendPayload = { document: fileBuffer, mimetype: mime, fileName: fileName || 'file', caption: caption || '' };
            }

            let sendOptions = {};
            if (quotedMessageId) {
                sendOptions.quoted = {
                    key: { id: quotedMessageId, remoteJid: targetJid, fromMe: quotedFromMe || false },
                    message: { conversation: '' }
                };
            }

            console.log(`Socket: sending ${mediaType} to ${targetJid} from ${senderPhone}`);
            const msg = await session.sock.sendMessage(targetJid, sendPayload, sendOptions);

            // Save to media dir
            const ext = path.extname(fileName || '.bin') || '.bin';
            const savedFilename = `${senderPhone}_${msg.key.id}${ext}`;
            const savedPath = path.join(MEDIA_DIR, savedFilename);
            fs.writeFileSync(savedPath, fileBuffer);

            callback({
                success: true,
                messageId: msg.key.id,
                mediaUrl: `/media/${savedFilename}`
            });
        } catch (error) {
            console.error('Socket send_media error:', error.message);
            callback({ success: false, error: error.message });
        }
    });
});

// ============================================
// Start Server
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server is running on port ${PORT}`);
});
