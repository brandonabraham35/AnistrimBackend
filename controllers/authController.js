const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('../utils/mailer');

// Helper to add a consistent prefix to our debug logs
const log = (message) => console.log(`[AUTH] ${message}`);

// OTP lifetime in minutes (strict email verification)
const VERIFICATION_TTL_MINUTES = 15;
// Max failed OTP attempts before the code is invalidated
const MAX_VERIFICATION_ATTEMPTS = 5;
// Minimum seconds between resend requests
const RESEND_THROTTLE_SECONDS = 60;

// Simple disposable-domain blocklist (anti-burner control).
// Extend as needed. Lowercase, no leading dot.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'sharklasers.com',
  'yopmail.com', 'temp-mail.org', 'throwawaymail.com', 'maildrop.cc',
  'getnada.com', 'dispostable.com', 'mailnesia.com', 'tempmail.com',
]);

// Generate a secure random 6-digit verification code
function generateVerificationCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

// Basic email format validation
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Reject disposable / throwaway domains
function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain && DISPOSABLE_DOMAINS.has(domain));
}

// Timing-safe comparison of two strings (equal-length buffers)
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Sign a JWT that ALWAYS carries the user's current isVerified status from DB.
// Emits BOTH `id` and `userId` so every consumer (getMe, watch, download) works
// during the migration window. The `user` object must include id, email,
// is_admin, is_premium, is_verified.
function signUserToken(user) {
  return jwt.sign(
    {
      id: user.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      isAdmin: !!user.is_admin,
      isPremium: !!user.is_premium,
      isVerified: !!user.is_verified,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' }
  );
}

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
            'SELECT id, name, email, password_hash, is_admin, is_premium, is_verified, avatar_url FROM users WHERE email = ?',
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

        // Unverified manual account — block login and signal the OTP funnel.
        if (!user.is_verified) {
            log(`Login blocked for unverified user: ${email}`);
            return res.status(403).json({
                success: false,
                requiresVerification: true,
                email: user.email,
                message: 'Verification required.',
            });
        }

        // Update last_login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        const token = signUserToken(user);

        log(`Login successful: ${email} (admin: ${!!user.is_admin})`);

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                isAdmin: !!user.is_admin,
                isPremium: !!user.is_premium,
                isVerified: !!user.is_verified,
                avatar: user.avatar_url || null
            }
        });

    } catch (error) {
        log(`CRITICAL ERROR during login: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error during authentication.' });
    }
};

// ─── Signup (create new user + require email verification) ──────
// Strict manual registration flow:
//   1. Validate email format + reject disposable domains
//   2. Create the user with is_verified = 0 (UNIQUE email key closes the race)
//   3. Generate a secure 6-digit OTP, save it with a 15-minute expiry
//   4. Email the OTP via SMTP
//   5. Return 201 so the frontend knows to prompt for the code
exports.signup = async (req, res) => {
    const { name, email, password } = req.body;
    log('--- Signup Attempt ---');

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    if (isDisposableEmail(email)) {
        return res.status(400).json({ message: 'Please use a real email address.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Generate a secure 6-digit OTP and set a 15-minute expiry
        const verificationCode = generateVerificationCode();
        const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
        const expiresSql = verificationExpires.toISOString().slice(0, 19).replace('T', ' ');

        let userId;
        try {
            const [result] = await pool.query(
                `INSERT INTO users (name, email, password_hash, is_admin, is_premium, is_verified, verification_code, verification_expires)
                 VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
                [name, email, passwordHash, verificationCode, expiresSql]
            );
            userId = result.insertId;
        } catch (insertError) {
            // UNIQUE key on email closes the TOCTOU race — surface a neutral 409.
            if (insertError.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'An account with this email already exists.' });
            }
            throw insertError;
        }

        // Update last_login for new user
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);

        // Dispatch the verification email (HTML with the 6-digit code)
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
            <div style="text-align:center;font-size:1.3rem;font-weight:800;color:#111827;margin-bottom:8px;">
              Ani<span style="color:#6c2bd9;">Strim</span>
            </div>
            <p style="color:#374151;font-size:0.95rem;text-align:center;">Welcome to AniStrim! Verify your email to activate your account.</p>
            <div style="text-align:center;margin:24px 0;">
              <span style="display:inline-block;background:#f3f4f6;color:#111827;font-size:2rem;font-weight:700;letter-spacing:8px;padding:14px 24px;border-radius:8px;">${verificationCode}</span>
            </div>
            <p style="color:#6b7280;font-size:0.85rem;text-align:center;">
              This code expires in ${VERIFICATION_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.
            </p>
          </div>`;

        try {
            await sendEmail(email, 'Verify your AniStrim account', html);
            await pool.query('UPDATE users SET verification_last_sent = NOW() WHERE id = ?', [userId]);
            log(`Verification email dispatched to: ${email}`);
        } catch (mailError) {
            // Registration succeeds regardless; email failures surface later.
            log(`WARN: verification email failed for ${email}: ${mailError.message}`);
        }

        log(`Signup successful (pending verification): ${email}`);

        res.status(201).json({
            success: true,
            requiresVerification: true,
            message: 'Account created. Please enter the verification code sent to your email.',
        });

    } catch (error) {
        log(`CRITICAL ERROR during signup: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error during registration.' });
    }
};

// ─── Verify email using the 6-digit OTP ─────────────────────────
// Accepts { email, code }. If the code matches and has not expired,
// mark the user verified, clear the verification fields, and return a
// brand-new JWT whose payload includes { userId, email, isVerified: true }.
// Anti-abuse: neutral errors (no account-existence oracle), OTP attempt
// lockout, and timing-safe code comparison.
exports.verifyEmailToken = async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT id, name, email, is_admin, is_premium, is_verified, verification_code, verification_expires, verification_attempts
             FROM users WHERE email = ?`,
            [email]
        );

        // Neutral response — do not reveal whether the account exists.
        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
        }

        const user = rows[0];

        // Already verified — do NOT mint a session here (prevents account takeover
        // by anyone who knows an email). The user must log in normally.
        if (user.is_verified) {
            return res.status(400).json({ success: false, message: 'Account already verified. Please log in.' });
        }

        // Attempt lockout: invalidate the code after too many misses.
        if (Number(user.verification_attempts) >= MAX_VERIFICATION_ATTEMPTS) {
            await pool.query(
                `UPDATE users SET verification_code = NULL, verification_expires = NULL WHERE id = ?`,
                [user.id]
            );
            return res.status(400).json({ success: false, message: 'Too many attempts. Please request a new code.' });
        }

        // Expiry check
        const expires = new Date(user.verification_expires);
        if (!user.verification_code || Number.isNaN(expires.getTime()) || Date.now() > expires.getTime()) {
            return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new code.' });
        }

        // Timing-safe code comparison
        if (!safeEqual(user.verification_code, String(code).trim())) {
            await pool.query(
                'UPDATE users SET verification_attempts = verification_attempts + 1 WHERE id = ?',
                [user.id]
            );
            return res.status(400).json({ success: false, message: 'Invalid verification code.' });
        }

        // Mark verified and clear the verification fields
        await pool.query(
            `UPDATE users SET is_verified = 1, verification_code = NULL, verification_expires = NULL, verification_attempts = 0 WHERE id = ?`,
            [user.id]
        );

        // Sign a brand-new JWT via the shared helper (id + userId + isVerified: true)
        const token = signUserToken({ ...user, is_verified: 1 });

        log(`Email verified for: ${email}`);

        return res.json({
            success: true,
            token,
            user: { id: user.id, name: user.name, email: user.email, isVerified: true },
        });
    } catch (error) {
        log(`CRITICAL ERROR during verifyEmailToken: ${error.message}`);
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error during email verification.' });
    }
};

// ─── Resend the verification OTP ────────────────────────────────
// Regenerates the code, resets the expiry, and throttles on
// verification_last_sent (>= 60s). Silently no-ops for unknown/verified emails
// to avoid an account-existence oracle.
exports.resendVerification = async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT id, is_verified, verification_last_sent FROM users WHERE email = ?`,
            [email]
        );

        // Neutral — never reveal whether the account exists.
        if (rows.length === 0 || rows[0].is_verified) {
            return res.json({ success: true, message: 'If your account needs verification, a new code has been sent.' });
        }

        const user = rows[0];

        // Throttle resends to >= 60s apart.
        const lastSent = new Date(user.verification_last_sent);
        if (!Number.isNaN(lastSent.getTime()) && (Date.now() - lastSent.getTime()) < RESEND_THROTTLE_SECONDS * 1000) {
            return res.status(429).json({ success: false, message: 'Please wait before requesting another code.' });
        }

        const verificationCode = generateVerificationCode();
        const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
        const expiresSql = verificationExpires.toISOString().slice(0, 19).replace('T', ' ');

        await pool.query(
            `UPDATE users SET verification_code = ?, verification_expires = ?, verification_attempts = 0, verification_last_sent = NOW() WHERE id = ?`,
            [verificationCode, expiresSql, user.id]
        );

        const html = `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
            <div style="text-align:center;font-size:1.3rem;font-weight:800;color:#111827;margin-bottom:8px;">
              Ani<span style="color:#6c2bd9;">Strim</span>
            </div>
            <p style="color:#374151;font-size:0.95rem;text-align:center;">Here is your new AniStrim verification code.</p>
            <div style="text-align:center;margin:24px 0;">
              <span style="display:inline-block;background:#f3f4f6;color:#111827;font-size:2rem;font-weight:700;letter-spacing:8px;padding:14px 24px;border-radius:8px;">${verificationCode}</span>
            </div>
            <p style="color:#6b7280;font-size:0.85rem;text-align:center;">
              This code expires in ${VERIFICATION_TTL_MINUTES} minutes.
            </p>
          </div>`;

        try {
            await sendEmail(email, 'Your new AniStrim verification code', html);
            log(`Verification code resent to: ${email}`);
        } catch (mailError) {
            log(`WARN: resend email failed for ${email}: ${mailError.message}`);
        }

        return res.json({ success: true, message: 'If your account needs verification, a new code has been sent.' });
    } catch (error) {
        log(`CRITICAL ERROR during resendVerification: ${error.message}`);
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error while resending verification code.' });
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
            'SELECT id, name, email, avatar_url, is_admin, is_premium, is_verified, premium_expires_at FROM users WHERE id = ?',
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
            is_verified: !!user.is_verified,
            isVerified: !!user.is_verified,
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
            { expiresIn: '1h', algorithm: 'HS256' }
        );

        const frontendBase = process.env.FRONTEND_URL || process.env.BACKEND_URL || 'http://localhost:5000';
        const devLink = `${frontendBase.replace(/\/$/, '')}/reset-password.html?token=${token}`;

        // Only expose the reset link in non-production environments.
        // In production the link is delivered by email (see email transport).
        const isProduction = process.env.NODE_ENV === 'production';
        const response = {
            message: 'If an account exists for that email, a reset link has been sent.',
        };
        if (!isProduction) {
            response.dev_link = devLink;
        }

        return res.status(200).json(response);
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
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
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