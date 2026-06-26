// controllers/googleAuthController.js
// Google OAuth redirect flow for Capacitor mobile app using deep-link handoff.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const db  = require('../config/db');

const BACKEND_URL = process.env.BACKEND_URL || 'https://anistrimbackend.onrender.com';
const APP_SCHEME = process.env.APP_SCHEME || 'anistrim';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.anistrim.app';
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

// In production, Redis/DB is better. This works on one Railway instance.
const loginCodeStore = new Map();

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BACKEND_URL}/api/auth/google/callback`
);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, isAdmin: !!user.is_admin, isPremium: !!user.is_premium },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function makeUserObj(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isPremium: !!user.is_premium,
    isAdmin: !!user.is_admin,
    avatar: user.avatar_url,
  };
}

function createLoginCode(token, user) {
  const code = crypto.randomUUID();
  loginCodeStore.set(code, {
    token,
    user,
    expiresAt: Date.now() + LOGIN_CODE_TTL_MS,
  });
  return code;
}

function consumeLoginCode(code) {
  const record = loginCodeStore.get(code);
  loginCodeStore.delete(code);

  if (!record) return null;
  if (Date.now() > record.expiresAt) return null;

  return record;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, record] of loginCodeStore.entries()) {
    if (now > record.expiresAt) loginCodeStore.delete(code);
  }
}, 60 * 1000).unref?.();

exports.googleRedirect = (req, res) => {
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.redirect(url);
};

exports.googleCallback = async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(errorPage('Sign-in cancelled.'));

  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
  headers: {
    Authorization: `Bearer ${tokens.access_token}`,
  },
});

if (!userInfoResponse.ok) {
  const text = await userInfoResponse.text();
  throw new Error(`Failed to fetch Google user info: ${text}`);
}

const payload = await userInfoResponse.json();

const payload = ticket.getPayload();

    if (!payload?.email) return res.send(errorPage('Could not get your email.'));
    if (payload.email_verified === false) return res.send(errorPage('Google email is not verified.'));

    const googleEmail  = payload.email;
    const googleName   = payload.name || googleEmail.split('@')[0];
    const googleAvatar = payload.picture || null;
    const googleId     = payload.sub;

    const [existing] = await db.query('SELECT * FROM users WHERE email = ?', [googleEmail]);
    let user;

    if (existing.length > 0) {
      user = existing[0];
      if (!user.google_id) {
        await db.query(
          'UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
          [googleId, googleAvatar, user.id]
        );
        const [updatedRows] = await db.query('SELECT * FROM users WHERE id = ?', [user.id]);
        user = updatedRows[0];
      }
    } else {
      const [result] = await db.query(
        'INSERT INTO users (name, email, password_hash, avatar_url, google_id, is_admin, is_premium) VALUES (?, ?, NULL, ?, ?, 0, 0)',
        [googleName, googleEmail, googleAvatar, googleId]
      );
      const [newRows] = await db.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      user = newRows[0];
    }

    const token = signToken(user);
    const userObj = makeUserObj(user);
    const loginCode = createLoginCode(token, userObj);

    return res.send(successPage(loginCode));
  } catch (err) {
    console.error('Google callback error:', err.message);
    return res.send(errorPage('Google sign-in failed. Please try again.'));
  }
};

exports.exchangeLoginCode = (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ message: 'Missing login code.' });

  const record = consumeLoginCode(code);
  if (!record) {
    return res.status(400).json({ message: 'Login code is invalid or expired. Please try Google sign-in again.' });
  }

  return res.json({ token: record.token, user: record.user });
};

function successPage(code) {
  const encodedCode = encodeURIComponent(code);
  const deepLink = `${APP_SCHEME}://auth?code=${encodedCode}`;
  const androidIntent = `intent://auth?code=${encodedCode}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};end`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Returning to AniStrim...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0f;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:sans-serif;padding:20px;}
    .spinner{width:52px;height:52px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:spin 0.8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{color:#aaa;font-size:0.9rem;text-align:center;line-height:1.5;}
    .logo{font-size:1.3rem;font-weight:800;color:#fff;}.logo span{color:#6c2bd9;}
    .btn{margin-top:16px;background:#6c2bd9;color:white;border:none;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:1rem;font-weight:700;display:inline-block;}
  </style>
</head>
<body>
  <div class="logo">Ani<span>Strim</span></div>
  <div class="spinner" id="spin"></div>
  <p id="msg">Signed in successfully. Returning to AniStrim...</p>
  <a class="btn" id="btn" href="${androidIntent}">Open AniStrim →</a>
  <script>
    const androidIntent = ${JSON.stringify(androidIntent)};
    const deepLink = ${JSON.stringify(deepLink)};

    function openApp() {
      window.location.href = androidIntent;
      setTimeout(function () {
        window.location.href = deepLink;
      }, 1200);
    }

    setTimeout(openApp, 300);
    setTimeout(function () {
      document.getElementById('spin').style.display = 'none';
      document.getElementById('msg').textContent = 'Tap Open AniStrim if you are not returned automatically.';
    }, 2000);
  </script>
</body>
</html>`;
}

function errorPage(message) {
  const safeMessage = String(message).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif;}
    .box{background:#1a1a2e;border:1px solid #6c2bd9;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%;}
    h2{color:#ef4444;margin-bottom:10px;}p{color:#aaa;font-size:0.85rem;margin-bottom:24px;line-height:1.6;}
    a{display:block;width:100%;background:#6c2bd9;color:#fff;text-decoration:none;border:none;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:600;}
  </style>
</head>
<body>
  <div class="box">
    <div style="font-size:3rem;margin-bottom:16px">❌</div>
    <h2>Sign-in Failed</h2>
    <p>${safeMessage}</p>
    <a href="${APP_SCHEME}://auth-error">← Back to Login</a>
  </div>
</body>
</html>`;
}
