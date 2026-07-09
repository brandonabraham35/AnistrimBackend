// File Path: Backend/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

// Helper to defensively force true boolean types (handles BIT, TINYINT, strings, Buffers)
const toBool = v => v === true || v === 1 || v === '1' || (Buffer.isBuffer(v) && v[0] === 1);

// Helper — create a signed JWT
function signToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email, 
      isAdmin: toBool(user.is_admin), 
      isPremium: toBool(user.is_premium) 
    },
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
    res.status(201).json({ 
      message: 'Account created!', 
      token, 
      user: { 
        id: result.insertId, 
        name, 
        email, 
        isPremium: false, 
        isAdmin: false 
      } 
    });
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
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        isPremium: toBool(user.is_premium), 
        isAdmin: toBool(user.is_admin), 
        avatar: user.avatar_url 
      }
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
    
    const dbUser = rows[0];
    res.json({
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      avatar_url: dbUser.avatar_url,
      isPremium: toBool(dbUser.is_premium),
      isAdmin: toBool(dbUser.is_admin),
      premium_expires_at: dbUser.premium_expires_at,
      created_at: dbUser.created_at
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
};

// Forgot password
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email required.' });
  try {
    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token   = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.query(
      'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?',
      [token, expires, email]
    );

    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password.html?token=${token}`;
    console.log(`🔑 Password reset link for ${email}: ${resetLink}`);

    res.json({
      message: 'Password reset link generated.',
      dev_link: resetLink
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
};

// Reset password with token
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