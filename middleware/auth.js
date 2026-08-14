// middleware/auth.js — JWT verification middleware
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { hasRole } = require('../utils/hasRole');

// Attach user to request if token is valid.
// New access-token contract (Phase 1):
//   Claims: { uid, sid, tv (token_version), roles[], iat, exp }
//   • Loads the user fresh from the DB (authoritative for status, token_version).
//   • Rejects if status !== 'active' (suspended/deactivated/deleted/pending).
//   • Rejects if payload.tv !== user.token_version (logout-all / password change).
//   • Rejects if the session (sid) is revoked.
//   • Touches last_seen_at on the session.
exports.protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authenticated. Please log in.' });
  }
  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ message: 'Token expired or invalid. Please log in again.' });
  }

  // Reject non-session tokens (password-reset tokens carry `purpose`).
  if (decoded.purpose) {
    return res.status(401).json({ message: 'Invalid token type.' });
  }

  // Backward compatibility: legacy tokens carry { userId, id } but no uid/sid/tv.
  // Phase-1 tokens carry { uid, sid, tv }. Accept both, but the new checks
  // (status, token_version, session) only apply to Phase-1 tokens.
  const userId = decoded.uid ?? decoded.userId ?? decoded.id;
  if (!userId) {
    return res.status(401).json({ message: 'Invalid token payload.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'User not found.' });
    }
    const user = rows[0];

    // Status gate — reject anything that is not 'active'.
    if (user.status !== 'active') {
      const code = user.status === 'suspended' ? 'ACCOUNT_SUSPENDED'
        : user.status === 'deactivated' ? 'ACCOUNT_DEACTIVATED'
        : user.status === 'deleted' ? 'ACCOUNT_DELETED'
        : 'ACCOUNT_NOT_ACTIVE';
      return res.status(403).json({ code, message: 'Account is not active.' });
    }

    // Phase-1 token: enforce token_version + session revocation.
    if (decoded.uid !== undefined) {
      // token_version mismatch → token was issued before a logout-all / password change.
      if (Number(decoded.tv) !== Number(user.token_version)) {
        return res.status(401).json({ code: 'TOKEN_VERSION_MISMATCH', message: 'Session invalidated. Please log in again.' });
      }

      // Session revocation check.
      const sid = decoded.sid;
      if (sid) {
        const [sessRows] = await pool.query(
          'SELECT id, revoked_at FROM user_sessions WHERE id = ? AND user_id = ?',
          [sid, userId]
        );
        if (sessRows.length === 0 || sessRows[0].revoked_at) {
          return res.status(401).json({ code: 'SESSION_REVOKED', message: 'Session revoked. Please log in again.' });
        }
        // Touch last_seen_at (best-effort, non-blocking).
        pool.query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = ?', [sid]).catch(() => {});
      }
    }

    // Attach the full user row + decoded claims to req.
    req.user = user;
    req.userId = userId;
    req.tokenClaims = decoded;
    next();
  } catch (err) {
    console.error('[AUTH] protect error:', err.message);
    return res.status(500).json({ message: 'Server error during authentication.' });
  }
};

// Must be used AFTER protect.
// P1 (Defect 6): role is authoritative from the `user_roles` table, checked fresh
// on every request — a stale JWT `isAdmin` claim can no longer grant admin. The
// JWT claim is only a fast-path fallback if the role lookup fails (DB hiccup), so
// a temporary DB issue can't lock an admin out, while a demoted admin is rejected
// immediately.
exports.adminOnly = async (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  try {
    const ok = await hasRole(req.userId ?? req.user.id, 'admin');
    if (!ok) return res.status(403).json({ message: 'Admin access required.' });
    req.user.isAdmin = true;
    return next();
  } catch (e) {
    // Role DB unavailable — fall back to the JWT claim (better to trust a
    // server-signed claim than to hard-fail during a DB outage).
    if (req.user.isAdmin) { req.user.isAdmin = true; return next(); }
    return res.status(503).json({ message: 'Unable to verify admin role.' });
  }
};

// Must be used AFTER protect
exports.premiumOnly = (req, res, next) => {
  if (!req.user || (!req.user.isPremium && !req.user.isAdmin)) {
    return res.status(403).json({ message: 'Premium subscription required.' });
  }
  next();
};