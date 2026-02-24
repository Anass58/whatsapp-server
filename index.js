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

// Store active sessions (In a real app, you'd manage multiple sessions dynamically)
let sock;
let qrCodeData = '';
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // We will also send this to the frontend via socket.io
        logger: pino({ level: "silent" })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            console.log('Sending QR code to frontend...');
            io.emit('qr_update', { qr: qrCodeData });
        }

        if (connection === 'close') {
            isConnected = false;
            io.emit('connection_status', { status: 'disconnected' });
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                // If logged out, you might need to delete the auth_info_baileys folder and restart
                console.log("Logged out. Need to scan again.");
                qrCodeData = '';
                io.emit('qr_update', { qr: '' });
                // Here you would optimally clear the directory auth_info_baileys
            }
        } else if (connection === 'open') {
            console.log('opened connection');
            isConnected = true;
            qrCodeData = ''; // Clear QR since we are connected
            io.emit('connection_status', { status: 'connected' });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async m => {
        console.log("New message received:", JSON.stringify(m, undefined, 2));

        // Emitting this to the frontend live
        if (m.type === 'notify') {
            io.emit('new_message', m.messages[0]);

            // TODO: Here you will write code to save the message to Supabase
            // e.g., await supabase.from('whatsapp_messages').insert({...})
        }
    });
}

// Start WhatsApp connection
connectToWhatsApp();

// API Endpoints

// Get current status
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: isConnected ? null : qrCodeData
    });
});

// Send a message via API
app.post('/api/sendText', async (req, res) => {
    try {
        const { number, text } = req.body;

        if (!isConnected || !sock) {
            return res.status(500).json({ success: false, error: 'WhatsApp is not connected' });
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

        const msg = await sock.sendMessage(formattedNumber, { text: text });
        res.json({ success: true, messageId: msg.key.id });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Socket.io for Real-time communication with the frontend Dashboard
io.on('connection', (socket) => {
    console.log('Dashboard connected to real-time socket');

    // Send immediate status on connect
    socket.emit('connection_status', { status: isConnected ? 'connected' : 'disconnected' });
    if (!isConnected && qrCodeData) {
        socket.emit('qr_update', { qr: qrCodeData });
    }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WhatsApp Server is running on port ${PORT}`);
});
