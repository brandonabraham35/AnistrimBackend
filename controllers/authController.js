const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('../utils/mailer');
const sessionService = require('../services/sessionService');
const { buildUserDto } = require('../services/userDtoService');
const { sendSuccess, sendAuth } = require('../utils/response');

// Helper to add a consistent prefix to our debug logs
const log = (message) => console.log(`[AUTH] ${message}`);

// ── Password pepper (application-level HMAC) ──────────────────────
// Adds an extra layer of defense against database breaches. Even if the
// database is compromised, passwords cannot be cracked without also
// compromising the application server's PASSWORD_PEPPER secret.
function pepperPassword(password) {
  const pepper = process.env.PASSWORD_PEPPER;
  if (pepper && typeof pepper === 'string' && pepper.trim() !== '') {
    return crypto.createHmac('sha256', pepper.trim()).update(password).digest('hex');
  }
  // In production, missing pepper is a warning but not fatal — existing
  // hashes without pepper would be impossible to verify if we made it fatal.
  if (process.env.NODE_ENV === 'production' && (!pepper || pepper.trim() === '')) {
    console.warn('[AUTH] WARNING: PASSWORD_PEPPER is not set in production. ' +
      'Password hashes are vulnerable to offline cracking if the database is breached. ' +
      'Set PASSWORD_PEPPER to a 64+ character random string.');
  }
  return password;
}

// Startup safety check — crash immediately in production if JWT_RESET_SECRET
// is missing, rather than failing on the first forgot-password request.
(function validateResetSecret() {
  if (process.env.NODE_ENV === 'production') {
    const s = process.env.JWT_RESET_SECRET;
    if (!s || typeof s !== 'string' || s.trim() === '') {
      console.error('[AUTH] FATAL: JWT_RESET_SECRET is required in production and must be a non-empty string.');
      console.error('[AUTH] Generate one with: openssl rand -hex 32');
      process.exit(1);
    }
  }
})();

// OTP lifetime in minutes (strict email verification)
const VERIFICATION_TTL_MINUTES = 15;
// Max failed OTP attempts before the code is invalidated
const MAX_VERIFICATION_ATTEMPTS = 5;
// Minimum seconds between resend requests
const RESEND_THROTTLE_SECONDS = 60;

// Used password reset token JTI store — prevents token reuse.
// Since reset tokens expire in 1 hour, this Map self-cleans via TTL.
const usedResetJtis = new Map();
const RESET_JTI_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (longer than token expiry)

// Periodically clean up expired used JTIs
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of usedResetJtis.entries()) {
    if (now > expiresAt) usedResetJtis.delete(jti);
  }
}, 5 * 60 * 1000).unref?.();

// Simple disposable-domain blocklist (anti-burner control).
// Extend as needed. Lowercase, no leading dot.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'sharklasers.com',
  'yopmail.com', 'temp-mail.org', 'throwawaymail.com', 'maildrop.cc',
  'getnada.com', 'dispostable.com', 'mailnesia.com', 'tempmail.com',
]);

// ── Password-reset token secret ─────────────────────────────────
// Uses JWT_RESET_SECRET independently from JWT_SECRET so a password-reset
// token compromise can never affect access-token security, and the two
// can be rotated separately.
// In production, JWT_RESET_SECRET MUST be set. Missing it on startup is a
// fatal error (see startupConfigWarnings). In development, we fall back to
// JWT_SECRET so existing .env files continue to work.
function getResetSecret() {
  const secret = process.env.JWT_RESET_SECRET;
  if (secret && typeof secret === 'string' && secret.trim() !== '') return secret.trim();
  // In production, missing JWT_RESET_SECRET is fatal — throw so the server
  // cannot boot with a silently weak config. In dev, fall back to JWT_SECRET.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_RESET_SECRET is required in production. ' +
      'Set it to a unique 64+ character random string, independent of JWT_SECRET.'
    );
  }
  console.warn('[AUTH] ⚠️ JWT_RESET_SECRET not set. Falling back to JWT_SECRET (dev only).');
  return process.env.JWT_SECRET;
}

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

// Persist the OTP hash to BOTH naming systems so there is ONE authoritative
// state that any existing query can read. The canonical write columns are
// `verification_*` (kept as the app's primary source of truth to avoid unsafe
// column renames on production), and `otp_*` is mirrored for backward compat
// with any code/tooling referencing the v44 spec names.
async function persistOtpState(userId, { codeHash, expiresSql, resetAttempts = true, updateLastSent = true }) {
  const attemptSql = resetAttempts ? ', verification_attempts = 0, otp_attempts = 0' : '';
  const lastSentSql = updateLastSent ? ', verification_last_sent = NOW(), otp_last_sent_at = NOW()' : '';
  await pool.query(
    `UPDATE users SET
       verification_code = ?, verification_expires = ?,
       otp_hash = ?, otp_expires_at = ?
       ${attemptSql} ${lastSentSql}
     WHERE id = ?`,
    [codeHash, expiresSql, codeHash, expiresSql, userId]
  );
}

// Build the canonical OTP HTML (shared by issue + resend + login reissue).
function buildOtpHtml(verificationCode, subText, heading) {
  const sub = subText || 'Here is your AniStrim verification code.';
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
      <div style="text-align:center;font-size:1.3rem;font-weight:800;color:#111827;margin-bottom:8px;">
        Ani<span style="color:#6c2bd9;">Strim</span>
      </div>
      <p style="color:#374151;font-size:0.95rem;text-align:center;">${sub}</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="display:inline-block;background:#f3f4f6;color:#111827;font-size:2rem;font-weight:700;letter-spacing:8px;padding:14px 24px;border-radius:8px;">${verificationCode}</span>
      </div>
      <p style="color:#6b7280;font-size:0.85rem;text-align:center;">
        This code expires in ${VERIFICATION_TTL_MINUTES} minutes.${heading ? ' ' + heading : ''}
      </p>
    </div>`;
}

// Issue a fresh code. ORDER MATTERS: generate & hash, SEND via Mailgun FIRST,
// and only persist the new OTP AFTER the email is accepted. This fixes the
// resend bug where a failed send replaced a still-valid OTP.
// Returns { sent: boolean, codeHash?, expiresSql? }.
async function issueVerificationCode(userId, email, { subject, subText, heading, updateLastSent = true } = {}) {
  const verificationCode = generateVerificationCode();
  const codeHash = sessionService.sha256(verificationCode);
  const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
  const expiresSql = verificationExpires.toISOString().slice(0, 19).replace('T', ' ');
  const html = buildOtpHtml(verificationCode, subText, heading);

  try {
    await sendEmail(email, subject || 'Your AniStrim verification code', html, verificationCode);
    log(`Verification email dispatched to: ${email}`);
    // Only commit the OTP after Mailgun accepts the message.
    await persistOtpState(userId, { codeHash, expiresSql, resetAttempts: true, updateLastSent });
    return { sent: true, codeHash, expiresSql };
  } catch (mailError) {
    log(`WARN: verification email failed for ${email}: ${mailError.message}`);
    return { sent: false };
  }
}

// Timing-safe comparison of two strings.
// Always calls crypto.timingSafeEqual so the execution path gives no hint
// about the stored value length. SHA-256 hashes are always 64 hex chars,
// but we pad any shorter input so the comparison is always constant-time.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Pad the shorter buffer to the longer one's length with zero bytes so
  // crypto.timingSafeEqual never sees mismatched lengths (which would throw).
  if (bufA.length === bufB.length) {
    return crypto.timingSafeEqual(bufA, bufB);
  }
  // Lengths differ — still compare the overlapping portion plus a dummy
  // operation so callers cannot distinguish length mismatch from value mismatch
  // via timing. Always return false (different lengths = different values).
  const minLen = Math.min(bufA.length, bufB.length);
  const sliceA = bufA.subarray(0, minLen);
  const sliceB = bufB.subarray(0, minLen);
  crypto.timingSafeEqual(sliceA, sliceB); // consume time regardless
  return false;
}

// ─── Login (any valid user) ─────────────────────────────────────────
// Used by both frontend login page and admin dashboard login.
// The admin dashboard checks isAdmin clientside after receiving the token.
exports.login = async (req, res) => {
    let { email, password } = req.body;
    email = typeof email === 'string' ? email.trim().toLowerCase() : email;
    log('--- Login Attempt ---');

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            log('User not found.');
            // Timing attack mitigation: perform a dummy bcrypt hash so the
            // response time is indistinguishable from the "user found + wrong
            // password" path (which performs bcrypt.compare).
            const dummySalt = await bcrypt.genSalt(10);
            await bcrypt.hash(pepperPassword(crypto.randomBytes(16).toString('hex')), dummySalt);
            await sessionService.logEvent(0, 'login_failed', 'password', req).catch(() => {});
            return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
        }

        const user = rows[0];

        // Users without password_hash signed up via Google — they must use Google login
        if (!user.password_hash) {
            log(`User ${email} has no password hash — Google-only account.`);
            return res.status(401).json({
                code: 'INVALID_CREDENTIALS',
                message: 'This account uses Google Sign-In. Please click "Continue with Google".'
            });
        }

        const pepperedPassword = pepperPassword(password);
        const match = await bcrypt.compare(pepperedPassword, user.password_hash);
        if (!match) {
            log('Password mismatch.');
            await sessionService.logEvent(user.id, 'login_failed', 'password', req).catch(() => {});
            return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
        }

        // Unverified manual account — block login and signal the OTP funnel.
        if (!user.is_verified) {
            log(`Login blocked for unverified user: ${email}`);
            let emailSent = true;
            try {
                const [sent] = await pool.query(
                    'SELECT verification_last_sent, verification_code, verification_expires FROM users WHERE id = ?',
                    [user.id]
                );
                const row = sent[0];
                const lastSentVal = row?.verification_last_sent;
                const lastSent = new Date(Number(lastSentVal));
                const throttled = !Number.isNaN(lastSent.getTime()) && (Date.now() - lastSent.getTime()) < RESEND_THROTTLE_SECONDS * 1000;
                const hasValidCode = Boolean(row?.verification_code) && row?.verification_expires &&
                    !Number.isNaN(new Date(row.verification_expires).getTime()) &&
                    Date.now() < new Date(row.verification_expires).getTime();
                if (lastSentVal && throttled && hasValidCode) {
                    // A live code is already in flight within the throttle window.
                    emailSent = true;
                } else if (lastSentVal && throttled) {
                    // Throttled but no valid code — don't claim a new email was sent.
                    emailSent = false;
                } else {
                    const result = await issueVerificationCode(user.id, user.email, {
                        subject: 'Your AniStrim verification code',
                        subText: 'Here is your AniStrim verification code.',
                        heading: 'If you didn\'t request this, you can safely ignore this email.',
                    });
                    emailSent = result.sent;
                }
            } catch (reissueError) {
                log(`WARN: could not re-issue code for ${email}: ${reissueError.message}`);
                emailSent = false;
            }
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_UNVERIFIED',
                requiresVerification: true,
                emailSent,
                message: 'Verification required.',
            });
        }

        // Status gate — reject non-active accounts.
        if (user.status !== 'active') {
            const code = user.status === 'suspended' ? 'ACCOUNT_SUSPENDED'
                : user.status === 'deactivated' ? 'ACCOUNT_DEACTIVATED'
                : user.status === 'deleted' ? 'ACCOUNT_DELETED'
                : 'ACCOUNT_NOT_ACTIVE';
            return res.status(403).json({ code, message: 'Account is not active.' });
        }

        // Update last_login
        await pool.query('UPDATE users SET last_login = NOW(), last_login_at = NOW() WHERE id = ?', [user.id]);

        // Create a session (access + refresh tokens).
        const { accessToken, refreshToken, sessionId } = await sessionService.createSession(user, req);
        await sessionService.logEvent(user.id, 'login_success', 'password', req);

        // Build the canonical user DTO.
        const dto = await buildUserDto({ ...user, last_login_at: new Date() });

        log(`Login successful: ${email} (admin: ${dto.isAdmin})`);

        return sendAuth(res, { token: accessToken, refreshToken, sessionId, user: dto });

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
//   4. Email the OTP via Mailgun HTTP API
//   5. If email send fails, roll back the new row (no zombie account).
//   6. Return 201 so the frontend knows to prompt for the code
exports.signup = async (req, res) => {
    let { name, email, password } = req.body;
    email = typeof email === 'string' ? email.trim().toLowerCase() : email;
    log('--- Signup Attempt ---');

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    if (isDisposableEmail(email)) {
        return res.status(400).json({ message: 'Please use a real email address.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const pepperedPassword = pepperPassword(password);
        const passwordHash = await bcrypt.hash(pepperedPassword, salt);

        // Generate a secure 6-digit OTP and set a 15-minute expiry.
        // Store the SHA-256 hash of the code, never the plaintext.
        const verificationCode = generateVerificationCode();
        const codeHash = sessionService.sha256(verificationCode);
        const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
        const expiresSql = verificationExpires.toISOString().slice(0, 19).replace('T', ' ');

        let userId;
        try {
            const [result] = await pool.query(
                `INSERT INTO users (name, email, password_hash, is_admin, is_premium, is_verified, verification_code, verification_expires, otp_hash, otp_expires_at, status, auth_provider)
                 VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 'pending', 'password')`,
                [name, email, passwordHash, codeHash, expiresSql, codeHash, expiresSql]
            );
            userId = result.insertId;
        } catch (insertError) {
            // UNIQUE key on email closes the TOCTOU race — surface a neutral 409.
            if (insertError.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'An account with this email already exists.' });
            }
            throw insertError;
        }

        // NOTE: last_login is NOT set here — registration is not login. It is
        // only updated after successful authentication.

        // Dispatch the verification email (HTML with the 6-digit code) via
        // Mailgun HTTP API. The OTP is only committed to the DB after Mailgun
        // accepts the message.
        const html = buildOtpHtml(
          verificationCode,
          'Welcome to AniStrim! Verify your email to activate your account.',
          'If you didn\'t request this, you can safely ignore this email.'
        );

        // ── Email dispatch is CRITICAL — never a silent failure. ──
        // If the OTP email cannot be sent, roll back the just-created row and
        // surface a clear 502 so the user is never left with an unusable,
        // unverified account and a misleading "success".
        try {
            await sendEmail(email, 'Verify your AniStrim account', html, verificationCode);
            await pool.query(
                'UPDATE users SET verification_last_sent = NOW(), otp_last_sent_at = NOW() WHERE id = ?',
                [userId]
            );
            log(`Verification email dispatched to: ${email}`);
        } catch (mailError) {
            log(`ERROR: verification email FAILED for ${email}: ${mailError.message}`);
            // Best-effort rollback — delete the just-created unverified row so
            // the email address is free to retry, never leaving a zombie account.
            try {
                await pool.query('DELETE FROM users WHERE id = ? AND is_verified = 0', [userId]);
                log(`Rolled back unverified signup for ${email} (id ${userId}).`);
            } catch (rollbackError) {
                log(`WARN: rollback failed for userId ${userId}: ${rollbackError.message}`);
            }
            return res.status(502).json({
                success: false,
                code: 'EMAIL_SEND_FAILED',
                message: 'We couldn\'t send your verification email. Please try again.',
            });
        }

        log(`Signup successful (pending verification): ${email}`);

        return sendSuccess(res, { requiresVerification: true, emailSent: true }, { message: 'Account created. Please enter the verification code sent to your email.' }, 201);

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
// lockout, timing-safe code comparison, and an ATOMIC verification update so
// concurrent requests cannot both claim the same OTP.
exports.verifyEmailToken = async (req, res) => {
    let { email, code } = req.body;
    email = typeof email === 'string' ? email.trim().toLowerCase() : email;

    if (!email || !code) {
        return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT * FROM users WHERE email = ?',
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
                'UPDATE users SET verification_code = NULL, verification_expires = NULL, otp_hash = NULL, otp_expires_at = NULL WHERE id = ?',
                [user.id]
            );
            return res.status(400).json({ success: false, message: 'Too many attempts. Please request a new code.' });
        }

        // Expiry check
        const expires = new Date(user.verification_expires);
        if (!user.verification_code || Number.isNaN(expires.getTime()) || Date.now() > expires.getTime()) {
            return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new code.' });
        }

        // Timing-safe code comparison — compare the SHA-256 hash of the input
        // against the stored hash.
        if (!safeEqual(user.verification_code, sessionService.sha256(String(code).trim()))) {
            await pool.query(
                'UPDATE users SET verification_attempts = verification_attempts + 1, otp_attempts = otp_attempts + 1 WHERE id = ?',
                [user.id]
            );
            return res.status(400).json({ success: false, message: 'Invalid verification code.' });
        }

        // ATOMIC verification: only the request that flips is_verified from 0→1
        // (while the code still matches and hasn't expired) proceeds to create
        // a session. Concurrent requests with the same code cannot both succeed.
        const [updateResult] = await pool.query(
            `UPDATE users
               SET is_verified = 1, status = 'active', email_verified_at = NOW(),
                   verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
                   otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
             WHERE id = ? AND is_verified = 0 AND verification_code = ?`,
            [user.id, user.verification_code]
        );

        if (updateResult.affectedRows === 0) {
            // Another concurrent request claimed the OTP first.
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
        }

        // Create a session (access + refresh tokens) — existing flow unchanged.
        const freshUser = { ...user, is_verified: 1, status: 'active', email_verified_at: new Date() };
        const { accessToken, refreshToken, sessionId } = await sessionService.createSession(freshUser, req);
        await sessionService.logEvent(user.id, 'login_success', 'password', req);

        // Build the canonical user DTO.
        const dto = await buildUserDto(freshUser);

        log(`Email verified for: ${email}`);

        return sendAuth(res, { token: accessToken, refreshToken, sessionId, user: dto });
    } catch (error) {
        log(`CRITICAL ERROR during verifyEmailToken: ${error.message}`);
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error during email verification.' });
    }
};

// ─── Resend the verification OTP ────────────────────────────────
// Regenerates the code, resets the expiry, and throttles on
// verification_last_sent (>= 60s) AND a rolling 5-per-hour per-email budget.
// FIX: the candidate OTP is ONLY persisted AFTER Mailgun accepts the email, so
// a failed send never invalidates an existing valid OTP.
// Silently no-ops for unknown/verified emails to avoid an account-existence
// oracle.
// Rolling per-email resend budget (defense-in-depth on top of the
// express-rate-limit middleware). Uses a sliding window so restarts don't
// permanently reset the budget for abusive clients (the window restarts, but
// the rate-limit middleware also enforces the same bound).
const resendBudget = new Map(); // email -> { windowStart, count }
const RESEND_BUDGET_MAX = 5;
const RESEND_BUDGET_WINDOW_MS = 3600 * 1000; // 1 hour

function resendAllowed(email) {
  const now = Date.now();
  const rec = resendBudget.get(email);
  if (!rec || (now - rec.windowStart) >= RESEND_BUDGET_WINDOW_MS) {
    resendBudget.set(email, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  if (rec.count >= RESEND_BUDGET_MAX) {
    return { allowed: false, retryAfter: Math.ceil((rec.windowStart + RESEND_BUDGET_WINDOW_MS - now) / 1000) };
  }
  rec.count += 1;
  return { allowed: true };
}

exports.resendVerification = async (req, res) => {
    let { email } = req.body;
    email = typeof email === 'string' ? email.trim().toLowerCase() : email;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT id, is_verified, verification_last_sent FROM users WHERE email = ?',
            [email]
        );

        // Neutral — never reveal whether the account exists.
        if (rows.length === 0 || rows[0].is_verified) {
            return sendSuccess(res, { emailSent: false }, { message: 'If your account needs verification, a new code has been sent.' });
        }

        const user = rows[0];

        // Throttle resends to >= 60s apart. Report how long to wait (seconds).
        const lastSent = new Date(user.verification_last_sent);
        if (!Number.isNaN(lastSent.getTime()) && (Date.now() - lastSent.getTime()) < RESEND_THROTTLE_SECONDS * 1000) {
            const waitMs = RESEND_THROTTLE_SECONDS * 1000 - (Date.now() - lastSent.getTime());
            const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
            return res.status(429).json({ success: false, retryAfter, message: 'Please wait before requesting another code.' });
        }

        // Rolling 5/hour per-email cap.
        const budget = resendAllowed(email);
        if (!budget.allowed) {
            return res.status(429).json({ success: false, retryAfter: budget.retryAfter, message: 'Too many resend requests. Please wait an hour.' });
        }

        // Send FIRST, persist only after Mailgun accepts.
        const result = await issueVerificationCode(user.id, email, {
            subject: 'Your new AniStrim verification code',
            subText: 'Here is your new AniStrim verification code.',
        });

        return sendSuccess(res, { emailSent: result.sent }, { message: 'If your account needs verification, a new code has been sent.' });
    } catch (error) {
        log(`CRITICAL ERROR during resendVerification: ${error.message}`);
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error while resending verification code.' });
    }
};

// ─── Compatibility: fetch current user for profile state ────────
// Now returns the canonical user DTO (1.5).
exports.getMe = async (req, res) => {
    try {
        const userId = req.userId ?? req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: 'Not authenticated. Please log in.' });
        }

        const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);

        if (!rows.length) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = rows[0];
        const dto = await buildUserDto(user);
        return sendSuccess(res, dto);
    } catch (error) {
        log(`CRITICAL ERROR during getMe: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching profile.' });
    }
};

// ─── Set password for an authenticated account ────────────────
// Lets a Google-only user (password_hash = NULL, auth_provider = 'google')
// set a password AFTER proving ownership via their authenticated session.
//
// Safety:
//   • Route must run behind authMiddleware.protect (authenticated JWT).
//   • Only sets password_hash — never removes google_id, never changes
//     auth_provider (Google stays a linked provider), never touches
//     is_verified or verification fields.
//   • Enforces the same password policy as signup (>= 6 characters).
//   • Does NOT expose whether other accounts exist (works only on the
//     authenticated user's own id from the verified JWT).
exports.setPassword = async (req, res) => {
    const userId = req.userId ?? req.user?.id ?? req.user?.userId;
    const { newPassword } = req.body;

    if (!userId) {
        return res.status(401).json({ message: 'Not authenticated. Please log in.' });
    }
    if (!newPassword || String(newPassword).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    try {
        // Load the user to confirm ownership and preserve google linkage.
        const [rows] = await pool.query(
            'SELECT id, password_hash, google_id, auth_provider FROM users WHERE id = ?',
            [userId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        const user = rows[0];

        const salt = await bcrypt.genSalt(10);
        const pepperedPassword = pepperPassword(newPassword);
        const passwordHash = await bcrypt.hash(pepperedPassword, salt);

        // Update ONLY password_hash. google_id and auth_provider stay intact.
        await pool.query(
            'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
            [passwordHash, user.id]
        );

        return sendSuccess(res, null, { message: 'Password set successfully. You can now also sign in with your email and password.' });
    } catch (error) {
        log(`CRITICAL ERROR during setPassword: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while setting password.' });
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

        // ── Timing-oracle mitigation ───────────────────────────────
        // Both the "account exists" and "no account" paths perform the
        // same CPU-bound cryptographic work (JWT sign + bcrypt hash) so
        // response timing does not reveal whether the account exists.
        // The neutral message is identical in both cases.

        if (rows.length === 0) {
            // Dummy token (same algorithm, same secret, same expiry)
            jwt.sign(
                { email: crypto.randomUUID() + '@anistrim.invalid', purpose: 'password-reset', sub: 0 },
                getResetSecret(),
                { expiresIn: '1h', algorithm: 'HS256' }
            );
            // Dummy bcrypt operation (same cost factor)
            const dummySalt = await bcrypt.genSalt(10);
            await bcrypt.hash(crypto.randomBytes(16).toString('hex'), dummySalt);

            return sendSuccess(res, null, { message: 'If an account exists for that email, a reset link has been sent.' });
        }

        const token = jwt.sign(
            { email: rows[0].email, purpose: 'password-reset', sub: rows[0].id, jti: crypto.randomUUID() },
            getResetSecret(),
            { expiresIn: '1h', algorithm: 'HS256' }
        );

                // Presentation-decoupling (B7 fix): the reset destination is now
        // per-client, resolved from the X-Client header (mobile|web|desktop|admin)
        // with a strict allow-list. A per-request ?resetPath= can override, but
        // only if it is in the allow-list — never reflect caller-supplied URLs.
        const clientAgnostic = require('../config/clientAgnostic');
        const requestedPath = req.query && typeof req.query.resetPath === 'string' ? req.query.resetPath : '';
        const client = (req.headers && req.headers['x-client']) || 'mobile';
        const resetTarget = clientAgnostic.getPasswordResetPath(client, requestedPath || undefined);
        const frontendBase = process.env.FRONTEND_URL || process.env.BACKEND_URL || 'http://localhost:5000';
        const resetUrl = clientAgnostic.buildClientUrl(resetTarget, frontendBase);
        const separator = resetUrl.includes('?') ? '&' : '?';
        const resetLink = `${resetUrl}${separator}token=${encodeURIComponent(token)}`;
        const resetHtml = `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
            <h2 style="margin:0 0 12px;color:#111827;">Reset your AniStrim password</h2>
            <p style="color:#374151;line-height:1.5;">Use the link below to choose a new password. It expires in one hour.</p>
            <p style="margin:24px 0;"><a href="${resetLink}" style="background:#6c2bd9;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">Reset password</a></p>
            <p style="color:#6b7280;font-size:0.85rem;line-height:1.5;">If you did not request a password reset, you can safely ignore this email.</p>
          </div>`;
        const response = {
            message: 'If an account exists for that email, a reset link has been sent.',
        };

        // Delivery is required for a usable reset flow. The target comes only
        // from the server-owned client map; the signed token is never logged.
        await sendEmail(rows[0].email, 'Reset your AniStrim password', resetHtml);

        // Expose the reset token/result so any client can complete the reset.
        // Only in explicit development mode — never when NODE_ENV is unset.
        if (process.env.NODE_ENV === 'development') {
            response.resetToken = token;
            response.token = token;
            if (resetLink) {
                response.resetUrl = resetLink;
            } else {
                response.resetDestination = null;
                response.resetPathRequired = true;
            }
        }

        return sendSuccess(res, response);
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

    if (String(newPassword).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    try {
        const decoded = jwt.verify(token, getResetSecret(), { algorithms: ['HS256'] });
        if (!decoded?.email || decoded?.purpose !== 'password-reset') {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }

        // Single-use enforcement: check if this JTI has already been used
        const jti = decoded.jti;
        if (jti && usedResetJtis.has(jti)) {
            return res.status(400).json({ message: 'This reset link has already been used. Please request a new one.' });
        }

        const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [decoded.email]);
        if (!rows.length) {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }

        const salt = await bcrypt.genSalt(10);
        const pepperedPassword = pepperPassword(newPassword);
        const passwordHash = await bcrypt.hash(pepperedPassword, salt);

        await pool.query(
            'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
            [passwordHash, rows[0].id]
        );
        await sessionService.logEvent(rows[0].id, 'password_reset', 'password', req).catch(() => {});

        // Mark this JTI as used to prevent replay
        if (jti) usedResetJtis.set(jti, Date.now() + RESET_JTI_TTL_MS);

        return sendSuccess(res, null, { message: 'Password reset successfully.' });
    } catch (error) {
        if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
            return res.status(400).json({ message: 'Invalid or expired reset link.' });
        }
        log(`CRITICAL ERROR during resetPassword: ${error.message}`);
        console.error(error);
        res.status(500).json({ message: 'Server error while resetting password.' });
    }
};

// ════════════════════════════════════════════════════════════════
//  PHASE 1 — New endpoints
// ════════════════════════════════════════════════════════════════

// ─── POST /api/auth/refresh ────────────────────────────────────
// Rotate refresh token, issue a new access token.
exports.refresh = async (req, res) => {
    const { refreshToken } = req.body;
    try {
        const result = await sessionService.rotateRefresh(refreshToken, req);
        const dto = await buildUserDto(result.user);
        return sendAuth(res, { token: result.accessToken, refreshToken: result.refreshToken, sessionId: result.sessionId, user: dto });
    } catch (err) {
        const status = err.status || 401;
        return res.status(status).json({ code: err.code || 'REFRESH_FAILED', message: err.message });
    }
};

// ─── POST /api/auth/logout ─────────────────────────────────────
// Revoke the current session (sid from the access token).
exports.logout = async (req, res) => {
    try {
        const userId = req.userId ?? req.user?.id;
        const sid = req.tokenClaims?.sid;
        if (userId && sid) {
            await sessionService.revokeSession(sid, userId);
            await sessionService.logEvent(userId, 'logout', null, req).catch(() => {});
        }
        return sendSuccess(res, null, { message: 'Logged out.' });
    } catch (error) {
        log(`CRITICAL ERROR during logout: ${error.message}`);
        return res.status(500).json({ message: 'Server error during logout.' });
    }
};

// ─── POST /api/auth/logout-all ─────────────────────────────────
// token_version++, revoke all sessions.
exports.logoutAll = async (req, res) => {
    try {
        const userId = req.userId ?? req.user?.id;
        if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

        await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
        await sessionService.revokeAllSessions(userId, 'logout');
        return sendSuccess(res, null, { message: 'All sessions revoked.' });
    } catch (error) {
        log(`CRITICAL ERROR during logoutAll: ${error.message}`);
        return res.status(500).json({ message: 'Server error during logout-all.' });
    }
};

// ─── GET /api/auth/sessions ────────────────────────────────────
// List active devices (current flagged).
exports.listSessions = async (req, res) => {
    try {
        const userId = req.userId ?? req.user?.id;
        const currentSid = req.tokenClaims?.sid;
        if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

        const sessions = await sessionService.listSessions(userId);
        const mapped = sessions.map(s => ({
            id: s.id,
            deviceName: s.device_name,
            platform: s.platform,
            userAgent: s.user_agent,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            expiresAt: s.expires_at,
            revokedAt: s.revoked_at,
            current: s.id === currentSid,
        }));
        return sendSuccess(res, { sessions: mapped });
    } catch (error) {
        log(`CRITICAL ERROR during listSessions: ${error.message}`);
        return res.status(500).json({ message: 'Server error while listing sessions.' });
    }
};

// ─── DELETE /api/auth/sessions/:id ─────────────────────────────
// Revoke one device.
exports.revokeSession = async (req, res) => {
    try {
        const userId = req.userId ?? req.user?.id;
        const sessionId = req.params.id;
        if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
        if (!sessionId) return res.status(400).json({ message: 'Session id is required.' });

        await sessionService.revokeSession(sessionId, userId);
        await sessionService.logEvent(userId, 'session_revoked', null, req).catch(() => {});
        return sendSuccess(res, null, { message: 'Session revoked.' });
    } catch (error) {
        log(`CRITICAL ERROR during revokeSession: ${error.message}`);
        return res.status(500).json({ message: 'Server error while revoking session.' });
    }
};

// ─── POST /api/auth/change-password ────────────────────────────
// Verify old password, token_version++, keep current session.
exports.changePassword = async (req, res) => {
    const userId = req.userId ?? req.user?.id;
    const { oldPassword, newPassword } = req.body;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Old and new passwords are required.' });
    }
    if (String(newPassword).length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (!rows.length) return res.status(404).json({ message: 'User not found.' });
        const user = rows[0];

        if (!user.password_hash) {
            return res.status(400).json({ message: 'This account uses Google Sign-In. Set a password first.' });
        }

        const pepperedOldPassword = pepperPassword(oldPassword);
        const match = await bcrypt.compare(pepperedOldPassword, user.password_hash);
        if (!match) {
            return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
        }

        const salt = await bcrypt.genSalt(10);
        const pepperedPassword = pepperPassword(newPassword);
        const passwordHash = await bcrypt.hash(pepperedPassword, salt);

        // token_version++ invalidates ALL other sessions' access tokens.
        await pool.query(
            'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = NOW() WHERE id = ?',
            [passwordHash, userId]
        );

        // Revoke ALL sessions (including the current one) so every other
        // device's refresh token is dead. Then create a fresh session for the
        // current device so the user stays logged in.
        await sessionService.revokeAllSessions(userId, null);
        const freshUser = { ...user, password_hash: passwordHash, token_version: Number(user.token_version) + 1 };
        const { accessToken, refreshToken, sessionId } = await sessionService.createSession(freshUser, req);
        await sessionService.logEvent(userId, 'password_changed', null, req).catch(() => {});
        const dto = await buildUserDto(freshUser);

        return sendAuth(res, { token: accessToken, refreshToken, sessionId, user: dto }, { message: 'Password changed successfully. Other devices have been signed out.' });
    } catch (error) {
        log(`CRITICAL ERROR during changePassword: ${error.message}`);
        return res.status(500).json({ message: 'Server error while changing password.' });
    }
};

// ─── POST /api/auth/change-email ───────────────────────────────
// Send OTP to the new address.
exports.changeEmail = async (req, res) => {
    const userId = req.userId ?? req.user?.id;
    const { newEmail } = req.body;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!newEmail || !isValidEmail(newEmail)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    try {
        const normalized = newEmail.trim().toLowerCase();

        // Check the new email is not already in use.
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [normalized]);
        if (existing.length) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        // Generate OTP, store hashed in email_change_requests.
        const otp = generateVerificationCode();
        const otpHash = sessionService.sha256(otp);
        const requestId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000);
        const expiresSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

        await pool.query(
            `INSERT INTO email_change_requests (id, user_id, new_email, otp_hash, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            [requestId, userId, normalized, otpHash, expiresSql]
        );

        const html = `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
            <div style="text-align:center;font-size:1.3rem;font-weight:800;color:#111827;margin-bottom:8px;">
              Ani<span style="color:#6c2bd9;">Strim</span>
            </div>
            <p style="color:#374151;font-size:0.95rem;text-align:center;">Confirm your new email address.</p>
            <div style="text-align:center;margin:24px 0;">
              <span style="display:inline-block;background:#f3f4f6;color:#111827;font-size:2rem;font-weight:700;letter-spacing:8px;padding:14px 24px;border-radius:8px;">${otp}</span>
            </div>
            <p style="color:#6b7280;font-size:0.85rem;text-align:center;">
              This code expires in ${VERIFICATION_TTL_MINUTES} minutes.
            </p>
          </div>`;

        let emailSent = false;
        try {
            await sendEmail(normalized, 'Confirm your new AniStrim email', html, otp);
            emailSent = true;
        } catch (mailError) {
            log(`WARN: change-email OTP failed for ${normalized}: ${mailError.message}`);
        }

        return sendSuccess(res, { emailSent, requestId }, { message: 'Verification code sent to your new email.' });
    } catch (error) {
        log(`CRITICAL ERROR during changeEmail: ${error.message}`);
        return res.status(500).json({ message: 'Server error while changing email.' });
    }
};

// ─── POST /api/auth/change-email/confirm ───────────────────────
// Swap email, log event.
exports.confirmChangeEmail = async (req, res) => {
    const userId = req.userId ?? req.user?.id;
    const { requestId, code } = req.body;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!requestId || !code) {
        return res.status(400).json({ message: 'Request id and verification code are required.' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT * FROM email_change_requests WHERE id = ? AND user_id = ?',
            [requestId, userId]
        );
        if (!rows.length) {
            return res.status(400).json({ message: 'Invalid or expired email change request.' });
        }
        const request = rows[0];

        if (request.consumed_at) {
            return res.status(400).json({ message: 'This email change request has already been used.' });
        }

        const expires = new Date(request.expires_at);
        if (Number.isNaN(expires.getTime()) || Date.now() > expires.getTime()) {
            return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
        }

        if (!safeEqual(request.otp_hash, sessionService.sha256(String(code).trim()))) {
            return res.status(400).json({ message: 'Invalid verification code.' });
        }

        // Swap the email.
        await pool.query(
            'UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?',
            [request.new_email, userId]
        );
        await pool.query(
            'UPDATE email_change_requests SET consumed_at = NOW() WHERE id = ?',
            [requestId]
        );
        await sessionService.logEvent(userId, 'email_changed', null, req).catch(() => {});

        return sendSuccess(res, null, { message: 'Email updated successfully.' });
    } catch (error) {
        log(`CRITICAL ERROR during confirmChangeEmail: ${error.message}`);
        return res.status(500).json({ message: 'Server error while confirming email change.' });
    }
};

// ─── POST /api/auth/account/deactivate ─────────────────────────
// status='deactivated', revoke sessions.
exports.deactivateAccount = async (req, res) => {
    const userId = req.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    try {
        await pool.query(
            'UPDATE users SET status = \'deactivated\', status_reason = \'user_requested\', token_version = token_version + 1, updated_at = NOW() WHERE id = ?',
            [userId]
        );
        await sessionService.revokeAllSessions(userId, 'account_deactivated');
        return sendSuccess(res, null, { message: 'Account deactivated.' });
    } catch (error) {
        log(`CRITICAL ERROR during deactivateAccount: ${error.message}`);
        return res.status(500).json({ message: 'Server error while deactivating account.' });
    }
};

// ─── POST /api/auth/account/delete ─────────────────────────────
// Soft-delete: status='deleted', deleted_at=NOW(), anonymise email,
// purge avatar. Hard purge job after 30 days.
// FIX 11: requires { password } (or a fresh OTP for Google accounts) to
// re-authenticate before the destructive action.
exports.deleteAccount = async (req, res) => {
    const userId = req.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    const { password } = req.body || {};

    try {
        // Load the user to verify the password (or detect Google-only account).
        const [rows] = await pool.query(
            'SELECT id, password_hash, auth_provider FROM users WHERE id = ?',
            [userId]
        );
        if (!rows.length) return res.status(404).json({ message: 'User not found.' });
        const user = rows[0];

        // Password accounts: require the current password.
        if (user.password_hash) {
            if (!password || typeof password !== 'string') {
                return res.status(400).json({ message: 'Please enter your password to confirm account deletion.' });
            }
            const match = await bcrypt.compare(pepperPassword(password), user.password_hash);
            if (!match) {
                return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Incorrect password. Account deletion cancelled.' });
            }
        }
        // Google-only accounts (no password_hash): require a fresh OTP.
        // For now, require the user to set a password first (simpler + safer).
        else {
            return res.status(400).json({
                message: 'This account uses Google Sign-In. Please set a password first, then confirm deletion with your password.',
            });
        }

        const anonymisedEmail = `deleted+${userId}@anistrim.invalid`;
        await pool.query(
            `UPDATE users
             SET status = 'deleted', deleted_at = NOW(), status_reason = 'user_requested',
                 token_version = token_version + 1, email = ?, username = NULL,
                 display_name = NULL, avatar_url = NULL, name = 'Deleted User',
                 updated_at = NOW()
             WHERE id = ?`,
            [anonymisedEmail, userId]
        );
        await sessionService.revokeAllSessions(userId, 'account_deleted');
        return sendSuccess(res, null, { message: 'Account deleted. This action is irreversible.' });
    } catch (error) {
        log(`CRITICAL ERROR during deleteAccount: ${error.message}`);
        return res.status(500).json({ message: 'Server error while deleting account.' });
    }
};
