const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

// ─── Compatibility: fetch current user for profile state ────────
exports.getMe = async (req, res) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: 'Not authenticated. Please log in.' });
        }

        const [rows] = await pool.query(
            'SELECT id, name, email, avatar_url, is_admin, is_premium, premium_expires_at FROM users WHERE id = ?',
            [userId]
        );

        if (!rows.length) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = rows[0];
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            avatar_url: user.avatar_url || null,
            avatar: user.avatar_url || null,
            is_admin: !!user.is_admin,
            isAdmin: !!user.is_admin,
            is_premium: !!user.is_premium,
            isPremium: !!user.is_premium,
            premium_expires_at: user.premium_expires_at || null,
        });
    } catch (error) {
        log(`CRITICAL ERROR during getMe: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching profile.' });
    }
};

// ─── Compatibility: request password reset link ─────────────────
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    try {
        const [rows] = await pool.query('SELECT id, email FROM users WHERE email = ?', [email]);

        if (rows.length === 0) {
            return res.status(200).json({
                message: 'If an account exists for that email, a reset link has been sent.'
            });
        }

        const token = jwt.sign(
            { email: rows[0].email, purpose: 'password-reset', sub: rows[0].id },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        const frontendBase = process.env.FRONTEND_URL || process.env.BACKEND_URL || 'http://localhost:5000';
        const devLink = `${frontendBase.replace(/\/$/, '')}/reset-password.html?token=${token}`;

        return res.status(200).json({
            message: 'If an account exists for that email, a reset link has been sent.',
            dev_link: devLink,
        });
    } catch (error) {
        log(`CRITICAL ERROR during forgotPassword: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while processing reset request.' });
    }
};

// ─── Compatibility: reset password using token ─────────────────
exports.resetPassword = async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ message: 'Reset token and new password are required.' });
    }

    if (String(newPassword).length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded?.email || decoded?.purpose !== 'password-reset') {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }

        const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [decoded.email]);
        if (!rows.length) {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        await pool.query(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [passwordHash, rows[0].id]
        );

        return res.json({ message: 'Password reset successfully.' });
    } catch (error) {
        if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }
        log(`CRITICAL ERROR during resetPassword: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while resetting password.' });
    }
};
