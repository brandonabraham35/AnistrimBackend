const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper to add a consistent prefix to our debug logs
const log = (message) => console.log(`[AUTH] ${message}`);

// ─── Login (any valid user) ─────────────────────────────────────────
// Used by both frontend login page and admin dashboard login.
// The admin dashboard checks isAdmin clientside after receiving the token.
exports.login = async (req, res) => {
    const { email, password } = req.body;
    log('--- Login Attempt ---');

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT id, name, email, password_hash, is_admin, is_premium, avatar_url FROM users WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            log('User not found.');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const user = rows[0];

        // Users without password_hash signed up via Google — they must use Google login
        if (!user.password_hash) {
            log(`User ${email} has no password hash — Google-only account.`);
            return res.status(401).json({
                message: 'This account uses Google Sign-In. Please click "Continue with Google".'
            });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            log('Password mismatch.');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        // Update last_login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        const payload = {
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: !!user.is_admin,
            isPremium: !!user.is_premium
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

        log(`Login successful: ${email} (admin: ${!!user.is_admin})`);

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                isAdmin: !!user.is_admin,
                isPremium: !!user.is_premium,
                avatar: user.avatar_url || null
            }
        });

    } catch (error) {
        log(`CRITICAL ERROR during login: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error during authentication.' });
    }
};

// ─── Signup (create new user) ─────────────────────────────────────
exports.signup = async (req, res) => {
    const { name, email, password } = req.body;
    log('--- Signup Attempt ---');

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    try {
        // Check if email already exists
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const [result] = await pool.query(
            'INSERT INTO users (name, email, password_hash, is_admin, is_premium) VALUES (?, ?, ?, 0, 0)',
            [name, email, passwordHash]
        );

        const userId = result.insertId;

        // Update last_login for new user
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);

        const payload = {
            id: userId,
            name,
            email,
            isAdmin: false,
            isPremium: false
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

        log(`Signup successful: ${email}`);

        res.status(201).json({
            token,
            user: {
                id: userId,
                name,
                email,
                isAdmin: false,
                isPremium: false,
                avatar: null
            },
            message: 'Account created successfully!'
        });

    } catch (error) {
        log(`CRITICAL ERROR during signup: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error during registration.' });
    }
};
