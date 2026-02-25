const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Server } = require('socket.io');
const http = require('http');

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

// Store active sessions dynamically
const sessions = new Map();

async function connectToWhatsApp(phone, socketId = null) {
    if (!phone) return;

    // Use a specific folder for each phone number
    const sessionDir = `auth_info_baileys_${phone}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        browser: ["Domira CRM", "Chrome", "120.0.0"],
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 250
    });

    // Store session info
    sessions.set(phone, {
        sock: sock,
        qrCodeData: '',
        isConnected: false,
        lastError: null
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(phone);
        if (!session) return;

        if (qr) {
            session.qrCodeData = qr;
            console.log(`Sending QR code to frontend for ${phone}...`);
            // Broadcast the QR code but tag it with the phone number
            io.emit('qr_update', { phone: phone, qr: qr });
        }

        if (connection === 'close') {
            session.isConnected = false;
            session.lastError = lastDisconnect.error?.message || lastDisconnect.error?.output?.statusCode || 'Unknown error';
            io.emit('connection_status', { phone: phone, status: 'disconnected', error: session.lastError });

            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`connection closed for ${phone} due to `, session.lastError, ', reconnecting ', shouldReconnect);

            if (shouldReconnect) {
                // Wait a bit before reconnecting
                setTimeout(() => connectToWhatsApp(phone), 5000);
            } else {
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
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async m => {
        console.log(`New message received for ${phone}:`, JSON.stringify(m, undefined, 2));

        if (m.type === 'notify') {
            // Include the phone number in the emitted event so the frontend knows who it belongs to
            const messageData = m.messages[0];
            io.emit('new_message', { phone: phone, message: messageData });
        }
    });
}

// Ensure previously authenticated sessions are reconnected on startup
const fs = require('fs');
function reconnectExistingSessions() {
    const folders = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_baileys_'));
    folders.forEach(folder => {
        const phone = folder.replace('auth_info_baileys_', '');
        console.log(`Auto-reconnecting existing session for ${phone}`);
        connectToWhatsApp(phone);
    });
}
reconnectExistingSessions();

// API Endpoints

// Start a new session or get QR for an existing unauthenticated one
app.post('/api/start', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const formattedPhone = phone.replace(/[^0-9]/g, '');

    // If session exists, return current status
    if (sessions.has(formattedPhone)) {
        const session = sessions.get(formattedPhone);
        return res.json({
            success: true,
            status: session.isConnected ? 'connected' : 'connecting',
            qr: session.isConnected ? null : session.qrCodeData
        });
    }

    // Start a new session
    console.log(`Starting new WhatsApp session initialization for ${formattedPhone}`);
    connectToWhatsApp(formattedPhone);
    res.json({ success: true, status: 'initializing' });
});

// Get current status of all sessions or a specific one
app.get('/api/status', (req, res) => {
    const { phone } = req.query;

    if (phone) {
        const session = sessions.get(phone);
        if (!session) return res.json({ connected: false, qr: null, exists: false, error: null });
        return res.json({
            exists: true,
            connected: session.isConnected,
            qr: session.isConnected ? null : session.qrCodeData,
            error: session.lastError
        });
    }

    // Return all
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

// Send a message via API
app.post('/api/sendText', async (req, res) => {
    try {
        const { senderPhone, number, text } = req.body;

        if (!senderPhone) {
            return res.status(400).json({ success: false, error: 'Sender Phone is required' });
        }

        const session = sessions.get(senderPhone);

        if (!session || !session.isConnected || !session.sock) {
            return res.status(500).json({ success: false, error: `WhatsApp is not connected for ${senderPhone}` });
        }

        if (!number || !text) {
            return res.status(400).json({ success: false, error: 'Number and text are required' });
        }

        // Format number: if it doesn't have @s.whatsapp.net, add it. Support both with and without '+'
        let formattedNumber = number.replace(/[^0-9]/g, ''); // Extract only digits

        // Basic check for Iraqi numbers or generic international prefix (adapt as needed)
        // Ensure it ends with @s.whatsapp.net
        if (!formattedNumber.endsWith('@s.whatsapp.net')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }

        const msg = await session.sock.sendMessage(formattedNumber, { text: text });
        res.json({ success: true, messageId: msg.key.id });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Socket.io for Real-time communication with the frontend Dashboard
io.on('connection', (socket) => {
    console.log('Dashboard connected to real-time socket');

    // Optionally handle when the dashboard asks for the status of a specific phone
    socket.on('request_status', (data) => {
        const phone = data?.phone;
        if (phone && sessions.has(phone)) {
            const session = sessions.get(phone);
            socket.emit('connection_status', { phone: phone, status: session.isConnected ? 'connected' : 'disconnected' });
            if (!session.isConnected && session.qrCodeData) {
                socket.emit('qr_update', { phone: phone, qr: session.qrCodeData });
            }
        }
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WhatsApp Server is running on port ${PORT}`);
});
