const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
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

app.use(cors());
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

async function connectToWhatsApp(phone, socketId = null) {
    if (!phone) return;

    const sessionDir = `auth_info_baileys_${phone}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Fetch the latest WhatsApp Web version
    let version;
    try {
        const versionInfo = await fetchLatestWaWebVersion({});
        version = versionInfo.version;
        console.log(`Using WhatsApp Web version: ${version}`);
    } catch (e) {
        console.log('Could not fetch latest WA version, using default:', e.message);
    }

    // Create SOCKS5 proxy agent to route through Cloudflare WARP VPN
    const proxyUrl = process.env.WARP_PROXY || 'socks5h://10.0.0.1:40000';
    console.log(`Using SOCKS5 proxy: ${proxyUrl}`);
    const agent = new SocksProxyAgent(proxyUrl);

    const sockOptions = {
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "warn" }),
        browser: ["Domira CRM", "Chrome", "22.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 500,
        markOnlineOnConnect: false,
        agent: agent,
        fetchAgent: agent,
        syncFullHistory: false
    };
    if (version) sockOptions.version = version;

    const sock = makeWASocket(sockOptions);

    // Store session info
    sessions.set(phone, {
        sock: sock,
        qrCodeData: '',
        isConnected: false,
        lastError: null,
        chats: new Map()
    });

    // --- Connection events ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(phone);
        if (!session) return;

        if (qr) {
            session.qrCodeData = qr;
            console.log(`Sending QR code to frontend for ${phone}...`);
            io.emit('qr_update', { phone: phone, qr: qr });
        }

        if (connection === 'close') {
            session.isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            session.lastError = lastDisconnect?.error?.message || statusCode || 'Unknown error';

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`connection closed for ${phone} due to`, session.lastError, ', reconnecting', shouldReconnect);

            if (shouldReconnect) {
                io.emit('connection_status', { phone: phone, status: 'reconnecting', error: session.lastError });
                setTimeout(() => connectToWhatsApp(phone), 5000);
            } else {
                io.emit('connection_status', { phone: phone, status: 'disconnected', error: session.lastError });
                console.log(`Logged out for ${phone}. Need to scan again.`);
                session.qrCodeData = '';
                io.emit('qr_update', { phone: phone, qr: '' });
                sessions.delete(phone);
            }
        } else if (connection === 'open') {
            console.log(`opened connection for ${phone}`);
            session.isConnected = true;
            session.qrCodeData = '';
            session.lastError = null;
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

    // --- Message events ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const session = sessions.get(phone);
        if (!session) return;

        for (const msg of m.messages) {
            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid === 'status@broadcast') continue;

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
                pushName: msg.pushName || null
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
}

// ============================================
// Helper Functions
// ============================================

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
        const m = msg.message;

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

async function syncChats(phone) {
    const session = sessions.get(phone);
    if (!session || !session.isConnected) return;

    // Give Baileys time to receive chats
    setTimeout(() => {
        emitChatList(phone);
    }, 3000);
}

function emitChatList(phone) {
    const session = sessions.get(phone);
    if (!session) return;

    const chatList = [];
    session.chats.forEach((chat, jid) => {
        if (jid === 'status@broadcast') return;
        if (!jid.includes('@')) return;

        const chatPhone = jid.split('@')[0];
        const isGroup = jid.endsWith('@g.us');

        chatList.push({
            jid: jid,
            phone: chatPhone,
            name: chat.contactName || chat.name || chat.notify || chat.subject || chatPhone,
            isGroup: isGroup,
            lastMessage: chat.lastMessage || chat.conversationTimestamp ? '' : '',
            lastMessageTime: chat.lastMessageTime || (chat.conversationTimestamp ? chat.conversationTimestamp * 1000 : 0),
            unreadCount: chat.unreadCount || chat.unreadCount || 0,
            profilePicture: null
        });
    });

    // Sort by last message time
    chatList.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    io.emit('chats_sync', { phone: phone, chats: chatList });
}

// ============================================
// Reconnect existing sessions on startup
// ============================================

function reconnectExistingSessions() {
    const folders = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_baileys_'));
    folders.forEach(folder => {
        const phone = folder.replace('auth_info_baileys_', '');
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
    res.json(results);
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

// --- Session Status ---
app.get('/api/status', (req, res) => {
    const { phone } = req.query;

    if (phone) {
        const session = sessions.get(phone);

        // Check if auth folder exists (session data on disk)
        const authDir = path.join(__dirname, `auth_info_baileys_${phone}`);
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
        const { senderPhone, number, text } = req.body;
        if (!senderPhone) return res.status(400).json({ success: false, error: 'Sender Phone required' });

        const session = sessions.get(senderPhone);
        if (!session || !session.isConnected || !session.sock) {
            return res.status(500).json({ success: false, error: `WhatsApp not connected for ${senderPhone}` });
        }

        if (!number || !text) return res.status(400).json({ success: false, error: 'Number and text required' });

        let jid = number.replace(/[^0-9]/g, '');
        if (!jid.endsWith('@s.whatsapp.net')) jid = `${jid}@s.whatsapp.net`;

        const msg = await session.sock.sendMessage(jid, { text: text });
        res.json({ success: true, messageId: msg.key.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Send Media Message ---
app.post('/api/sendMedia', upload.single('file'), async (req, res) => {
    try {
        const { senderPhone, number, caption, mediaType } = req.body;
        if (!senderPhone || !number || !req.file) {
            return res.status(400).json({ success: false, error: 'senderPhone, number, and file required' });
        }

        const session = sessions.get(senderPhone);
        if (!session || !session.isConnected || !session.sock) {
            return res.status(500).json({ success: false, error: `WhatsApp not connected for ${senderPhone}` });
        }

        let jid = number.replace(/[^0-9]/g, '');
        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@g.us')) {
            jid = `${jid}@s.whatsapp.net`;
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

        const msg = await session.sock.sendMessage(jid, sendPayload);

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

// --- Disconnect Session ---
app.post('/api/disconnect', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    const session = sessions.get(phone);
    if (session?.sock) {
        await session.sock.logout();
        sessions.delete(phone);
        // Remove auth folder
        const authDir = path.join(__dirname, `auth_info_baileys_${phone}`);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true });
        }
    }

    res.json({ success: true });
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
});

// ============================================
// Start Server
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server is running on port ${PORT}`);
});
