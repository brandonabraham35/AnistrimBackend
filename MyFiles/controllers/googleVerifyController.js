// controllers/googleVerifyController.js
// Verifies Google ID token sent directly from frontend (GIS approach)
// No browser redirects needed — works directly in Capacitor WebView

const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const db  = require('../config/db');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, isAdmin: !!user.is_admin, isPremium: !!user.is_premium },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/google/verify
// Frontend sends Google ID token, we verify it and return our JWT
exports.verifyGoogleToken = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ message: 'Google ID token is required.' });
  }

  try {
    // Verify the token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken:  idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload.email_verified) {
      return res.status(400).json({ message: 'Google email is not verified.' });
    }

    const googleEmail  = payload.email;
    const googleName   = payload.name;
    const googleAvatar = payload.picture;
    const googleId     = payload.sub;

    // Find or create user
    const [existing] = await db.query(
      'SELECT * FROM users WHERE email = ?', [googleEmail]
    );

    let user;
    if (existing.length > 0) {
      user = existing[0];
      // Update google_id and avatar if missing
      if (!user.google_id) {
        await db.query(
          'UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
          [googleId, googleAvatar, user.id]
        );
        user.google_id  = googleId;
        user.avatar_url = user.avatar_url || googleAvatar;
      }
    } else {
      // Create new user
      const [result] = await db.query(
        `INSERT INTO users (name, email, password_hash, avatar_url, google_id, is_admin, is_premium)
         VALUES (?, ?, NULL, ?, ?, 0, 0)`,
        [googleName, googleEmail, googleAvatar, googleId]
      );
      const [newRows] = await db.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      user = newRows[0];
    }

    const token   = signToken(user);
    const userObj = {
      id:        user.id,
      name:      user.name,
      email:     user.email,
      isPremium: !!user.is_premium,
      isAdmin:   !!user.is_admin,
      avatar:    user.avatar_url,
    };

    console.log(`✅ Google login: ${googleEmail}`);
    res.json({ token, user: userObj, message: 'Welcome!' });

  } catch (err) {
    console.error('Google verify error:', err.message);
    res.status(401).json({ message: 'Google verification failed. Please try again.' });
  }
};
