// services/sessionService.js — shared session + refresh-token lifecycle.
//
// Every auth path (manual login, signup/verify-otp, Google verify, Google
// OAuth redirect) creates a session through this module so the refresh-token
// rotation, reuse detection, and session-revocation rules are identical.
//
// Access JWT: 15 min. Claims: { uid, sid, tv (token_version), roles[], iat, exp }.
//   No isPremium in the token — entitlement is looked up per request.
// Refresh token: 30 days, opaque random 32 bytes, stored hashed (sha256) in
//   user_sessions.refresh_hash, rotated on every use. Reuse detection revokes
//   the whole family and logs session_revoked.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { rolesOf } = require('../utils/hasRole');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

// ── Helpers ─────────────────────────────────────────────────
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function ipHash(ip) {
  if (!ip) return null;
  return sha256(String(ip));
}

function detectPlatform(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'ios';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'web';
  return 'unknown';
}

function deviceName(userAgent) {
  const ua = String(userAgent || '');
  const match = ua.match(/\(([^)]+)\)/);
  return match ? match[1].slice(0, 120) : 'Unknown device';
}

// ── Session creation ────────────────────────────────────────
// Creates a user_sessions row, returns { accessToken, refreshToken, sessionId }.
async function createSession(user, req) {
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const refreshHash = sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const expiresSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

  const ua = req?.headers?.['user-agent'] || '';
  const platform = detectPlatform(ua);
  const ip = req?.ip || req?.socket?.remoteAddress || null;

  await pool.query(
    `INSERT INTO user_sessions (id, user_id, refresh_hash, device_name, platform, user_agent, ip_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, user.id, refreshHash, deviceName(ua), platform, ua.slice(0, 255), ipHash(ip), expiresSql]
  );

  // Record the issued refresh token in the rotation-tracking table.
  await pool.query(
    `INSERT INTO session_refresh_tokens (session_id, refresh_hash)
     VALUES (?, ?)`,
    [sessionId, refreshHash]
  );

  const accessToken = await signAccessToken(user, sessionId);
  return { accessToken, refreshToken, sessionId };
}

// ── Access token signing ────────────────────────────────────
// Claims: { uid, sid, tv, roles[], iat, exp }. No isPremium.
async function signAccessToken(user, sessionId) {
  const roles = await rolesOf(user.id);
  return jwt.sign(
    {
      uid: user.id,
      sid: sessionId,
      tv: Number(user.token_version) || 0,
      roles,
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' }
  );
}

// ── Refresh rotation ────────────────────────────────────────
// Verifies the presented refresh token, rotates it, and issues a new access
// token. If the presented token was already rotated (reuse), revokes the whole
// family and logs session_revoked.
async function rotateRefresh(refreshToken, req) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    const err = new Error('Refresh token is required.');
    err.code = 'REFRESH_TOKEN_REQUIRED';
    err.status = 400;
    throw err;
  }

  const presentedHash = sha256(refreshToken);

  // Look up the presented hash in the rotation-tracking table FIRST.
  // This is the authoritative source for reuse detection.
  const [tokenRows] = await pool.query(
    'SELECT * FROM session_refresh_tokens WHERE refresh_hash = ?',
    [presentedHash]
  );

  if (tokenRows.length === 0) {
    const err = new Error('Invalid refresh token.');
    err.code = 'INVALID_REFRESH_TOKEN';
    err.status = 401;
    throw err;
  }

  const tokenRow = tokenRows[0];

  // REUSE DETECTION: if this hash was already used (rotated), the token was
  // replayed → revoke the whole session family and log session_revoked.
  if (tokenRow.used_at) {
    const [sessRows] = await pool.query(
      'SELECT user_id FROM user_sessions WHERE id = ?',
      [tokenRow.session_id]
    );
    if (sessRows.length > 0) {
      await revokeAllSessions(sessRows[0].user_id, 'session_revoked');
    }
    const err = new Error('Refresh token reuse detected. All sessions revoked.');
    err.code = 'REFRESH_REUSE_DETECTED';
    err.status = 401;
    throw err;
  }

  // Load the session row.
  const [rows] = await pool.query(
    'SELECT * FROM user_sessions WHERE id = ?',
    [tokenRow.session_id]
  );

  if (rows.length === 0) {
    const err = new Error('Invalid refresh token.');
    err.code = 'INVALID_REFRESH_TOKEN';
    err.status = 401;
    throw err;
  }

  const session = rows[0];

  // A revoked session means the token was presented after explicit revocation.
  if (session.revoked_at) {
    await revokeAllSessions(session.user_id, 'session_revoked');
    const err = new Error('Refresh token reuse detected. All sessions revoked.');
    err.code = 'REFRESH_REUSE_DETECTED';
    err.status = 401;
    throw err;
  }

  // Expiry check
  const expires = new Date(session.expires_at);
  if (Number.isNaN(expires.getTime()) || Date.now() > expires.getTime()) {
    await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = ?', [session.id]);
    const err = new Error('Refresh token expired. Please log in again.');
    err.code = 'REFRESH_EXPIRED';
    err.status = 401;
    throw err;
  }

  // Load the user to confirm status + token_version.
  const [userRows] = await pool.query(
    'SELECT * FROM users WHERE id = ?',
    [session.user_id]
  );
  if (userRows.length === 0) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 401;
    throw err;
  }
  const user = userRows[0];

  if (user.status !== 'active') {
    const err = new Error('Account is not active.');
    err.code = user.status === 'suspended' ? 'ACCOUNT_SUSPENDED'
      : user.status === 'deactivated' ? 'ACCOUNT_DEACTIVATED'
      : user.status === 'deleted' ? 'ACCOUNT_DELETED'
      : 'ACCOUNT_NOT_ACTIVE';
    err.status = 403;
    throw err;
  }

  // Rotate: mark the presented token as used, insert the new one.
  const newRefreshToken = crypto.randomBytes(32).toString('hex');
  const newRefreshHash = sha256(newRefreshToken);
  const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const newExpiresSql = newExpiresAt.toISOString().slice(0, 19).replace('T', ' ');

  // Mark the presented token as used (this is what enables reuse detection).
  await pool.query(
    'UPDATE session_refresh_tokens SET used_at = NOW() WHERE id = ?',
    [tokenRow.id]
  );

  // Update the session's current hash + expiry.
  await pool.query(
    `UPDATE user_sessions
     SET refresh_hash = ?, expires_at = ?, last_seen_at = NOW()
     WHERE id = ?`,
    [newRefreshHash, newExpiresSql, session.id]
  );

  // Record the new token in the rotation-tracking table.
  await pool.query(
    `INSERT INTO session_refresh_tokens (session_id, refresh_hash)
     VALUES (?, ?)`,
    [session.id, newRefreshHash]
  );

  const accessToken = await signAccessToken(user, session.id);
  return { accessToken, refreshToken: newRefreshToken, sessionId: session.id, user };
}

// ── Revocation ──────────────────────────────────────────────
async function revokeSession(sessionId, userId) {
  await pool.query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ?',
    [sessionId, userId]
  );
  // FIX 5: kill any in-flight stream tokens minted for this session.
  try {
    const streamToken = require('../utils/streamToken');
    streamToken.revokeSid(sessionId);
  } catch (_) {}
}

async function revokeAllSessions(userId, event = 'logout') {
  await pool.query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
    [userId]
  );
  // FIX 5: kill ALL in-flight stream tokens for this user immediately.
  try {
    const streamToken = require('../utils/streamToken');
    streamToken.revokeAllForUser(userId);
  } catch (_) {}
  if (event) {
    await logEvent(userId, event);
  }
}

// ── Login history ───────────────────────────────────────────
async function logEvent(userId, event, provider = null, req = null) {
  // Skip the insert for unknown emails (userId 0/null) — the FK would orphan.
  if (!userId) return;
  const ua = req?.headers?.['user-agent'] || null;
  const ip = req?.ip || req?.socket?.remoteAddress || null;
  await pool.query(
    `INSERT INTO login_history (user_id, event, provider, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, event, provider, ipHash(ip), ua ? ua.slice(0, 255) : null]
  );
}

// ── Session listing ─────────────────────────────────────────
async function listSessions(userId) {
  const [rows] = await pool.query(
    `SELECT id, device_name, platform, user_agent, created_at, last_seen_at, expires_at, revoked_at
     FROM user_sessions
     WHERE user_id = ?
     ORDER BY last_seen_at DESC`,
    [userId]
  );
  return rows;
}

module.exports = {
  createSession,
  signAccessToken,
  rotateRefresh,
  revokeSession,
  revokeAllSessions,
  logEvent,
  listSessions,
  sha256,
  ipHash,
  detectPlatform,
  deviceName,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
};