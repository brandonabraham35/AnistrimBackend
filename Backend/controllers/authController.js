// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

// Helper — create a signed JWT
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, isAdmin: !!user.is_admin, isPremium: !!user.is_premium },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/signup
exports.register = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: 'Name, email and password are required.' });
  if (password.length < 6)
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0)
      return res.status(409).json({ message: 'Email already registered.' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    );

    const token = signToken({ id: result.insertId, email, is_admin: 0, is_premium: 0 });
    res.status(201).json({ message: 'Account created!', token, user: { id: result.insertId, name, email, isPremium: false, isAdmin: false } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error during registration.' });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email and password required.' });

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const user = rows[0];

console.log("========== LOGIN DEBUG ==========");
console.log("User object:", user);
console.log("password_hash:", user.password_hash);
console.log("typeof password_hash:", typeof user.password_hash);
console.log("================================");

if (!user.password_hash) {
    return res.status(401).json({
        message: 'This account uses Google Sign-In. Please sign in with Google or set a password first.'
    });
}

const match = await bcrypt.compare(password, user.password_hash);

    if (!match)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const token = signToken(user);
    res.status(200).json({
      message: 'Welcome back!',
      token,
      user: { id: user.id, name: user.name, email: user.email, isPremium: !!user.is_premium, isAdmin: !!user.is_admin, avatar: user.avatar_url }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login.' });
  }
};

// GET /api/auth/me  (requires token)
exports.getMe = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, avatar_url, is_premium, is_admin, premium_expires_at, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
};

// FIX 5: Forgot password — generates a reset token stored in DB
// For now stores token in users table (no email sending — add nodemailer later)
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email required.' });
  try {
    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    // Always return same message for security (don't reveal if email exists)
    if (!rows.length) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token   = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.query(
      'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?',
      [token, expires, email]
    );

    // In production: send email with link
    // For now: return token directly (dev mode)
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password.html?token=${token}`;
    console.log(`🔑 Password reset link for ${email}: ${resetLink}`);

    res.json({
      message: 'Password reset link generated.',
      // Remove dev_link in production!
      dev_link: resetLink
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
};

// FIX 5: Reset password with token
exports.resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password required.' });
  if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  try {
    const [rows] = await db.query(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ message: 'Reset link is invalid or expired.' });

    const hash = await require('bcryptjs').hash(newPassword, 10);
    await db.query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
      [hash, rows[0].id]
    );
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
};
