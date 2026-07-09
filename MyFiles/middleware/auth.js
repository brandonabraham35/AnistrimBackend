// middleware/auth.js — JWT verification middleware
const jwt = require('jsonwebtoken');

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

// Must be used AFTER protect
exports.adminOnly = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
};

// Must be used AFTER protect
exports.premiumOnly = (req, res, next) => {
  if (!req.user || (!req.user.isPremium && !req.user.isAdmin)) {
    return res.status(403).json({ message: 'Premium subscription required.' });
  }
  next();
};
