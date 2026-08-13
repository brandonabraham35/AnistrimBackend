// middleware/auth.js — JWT verification middleware
const jwt = require('jsonwebtoken');
const { hasRole } = require('../utils/hasRole');

// Attach user to request if token is valid
exports.protect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authenticated. Please log in.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, isAdmin, isPremium }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token expired or invalid. Please log in again.' });
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
    const ok = await hasRole(req.user.userId ?? req.user.id, 'admin');
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
