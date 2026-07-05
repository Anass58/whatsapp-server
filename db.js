require('dotenv').config();
const { Pool } = require('pg');

// DATABASE_URL is required — no hardcoded fallback (it would leak DB credentials in source).
// If you previously relied on the internal-IP fallback to bypass Docker DNS (EAI_AGAIN),
// set DATABASE_URL in whatsapp-server/.env to that IP-based connection string instead.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    // Missing required config is a real misconfiguration, not a transient error:
    // fail fast with an actionable message instead of an unhandled throw/stack trace.
    console.error('[FATAL] DATABASE_URL is not set. Configure it in the environment (Coolify → Environment Variables). Refusing to start.');
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10000, // fail a stalled connect in 10s instead of hanging ~2min on ETIMEDOUT
    idleTimeoutMillis: 30000,
    max: 10,
    // ssl: { rejectUnauthorized: false } // Disabled for Coolify's internal network to prevent connection rejection
});

// A pg Pool emits 'error' on idle backend clients (DB restarted, network blip, etc.).
// With no listener, Node crashes the whole process — which is exactly how a transient
// DB hiccup previously turned into a Coolify restart storm. Log and keep the gateway alive.
pool.on('error', (err) => {
    console.error('[db] idle client error (non-fatal):', err.message);
});

const initDB = async (attempt = 1) => {
    let client;
    try {
        client = await pool.connect();
        console.log('Initializing Database Schema...');
        
        // Instances table: Stores WhatsApp sessions and their webhook URLs
        await client.query(`
            CREATE TABLE IF NOT EXISTS instances (
                phone VARCHAR(50) PRIMARY KEY,
                webhook_url TEXT,
                status VARCHAR(50) DEFAULT 'disconnected',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Messages table: Stores chat history for the Dashboard Web UI
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                instance_phone VARCHAR(50) REFERENCES instances(phone) ON DELETE CASCADE,
                remote_jid VARCHAR(100) NOT NULL,
                message_id VARCHAR(100) NOT NULL,
                from_me BOOLEAN DEFAULT false,
                push_name VARCHAR(255),
                message_text TEXT,
                media_url TEXT,
                message_type VARCHAR(50),
                timestamp BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(instance_phone, remote_jid, message_id)
            );
        `);
        
        // Contacts table: Stores basic contact info
        await client.query(`
            CREATE TABLE IF NOT EXISTS contacts (
                instance_phone VARCHAR(50) REFERENCES instances(phone) ON DELETE CASCADE,
                remote_jid VARCHAR(100) NOT NULL,
                push_name VARCHAR(255),
                profile_pic_url TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(instance_phone, remote_jid)
            );
        `);

        // Speeds up the message-stats aggregation (per number, per day/time-window)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_instance_ts ON messages (instance_phone, timestamp);
        `);

        console.log('Database Initialization Complete.');
    } catch (err) {
        // Never let a boot-time DB outage crash the process. Retry with capped backoff
        // (2s, 4s, 8s, 16s, 32s → max 30s) until the DB becomes reachable.
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        console.error(`[db] initDB attempt ${attempt} failed: ${err.message}. Retrying in ${Math.round(delay / 1000)}s...`);
        setTimeout(() => initDB(attempt + 1), delay);
    } finally {
        if (client) client.release();
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDB
};
