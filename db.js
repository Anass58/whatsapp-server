require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:qCkPiGs4XyDqChkvTThkqf7OCgfHiNVOye80gI8jgXsMpWxO5G8U0ohPT4zWlkOc@postgresql-datawhatsapp-evol:5432/postgres",
    // ssl: { rejectUnauthorized: false } // Disabled for Coolify's internal network to prevent connection rejection
});

const initDB = async () => {
    const client = await pool.connect();
    try {
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

        console.log('Database Initialization Complete.');
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        client.release();
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDB
};
