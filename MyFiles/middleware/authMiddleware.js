// middleware/authMiddleware.js
// Strict verification-aware authentication middleware for AniStrim.
//
// verifyTokenAndStatus:
//   • Extracts the Bearer JWT from the Authorization header
//   • Decodes it with process.env.JWT_SECRET (HS256 only)
//   • Rejects non-session tokens (e.g. password-reset tokens that carry a
//     `purpose` claim) — they are signed with the same secret and must not
//     be accepted as Bearer session tokens.
//   • If the decoded token does NOT carry isVerified === true, halts with
//     HTTP 403 and { success: false, requiresVerification: true, message: "Verification required." }
//   • Otherwise attaches the decoded payload to req.user and calls next()
//
// This is intended to guard the streaming resolution engine so unverified
// manual registrations cannot stream content until they verify their email.

const jwt = require('jsonwebtoken');

// Fail fast at boot if JWT_SECRET is missing — an undefined secret would
// otherwise throw per-request and silently break every protected route.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Refusing to start with an insecure auth configuration.');
}

/**
 * Verify the Bearer token and enforce email-verification status.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function verifyTokenAndStatus(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated. Please log in.',
    });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Token expired or invalid. Please log in again.',
    });
  }

  // Reject non-session tokens (password-reset tokens carry `purpose`).
  if (decoded.purpose) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token type.',
    });
  }

  // Strict allow-list: only tokens that explicitly carry isVerified === true pass.
  if (decoded.isVerified !== true) {
    return res.status(403).json({
      success: false,
      requiresVerification: true,
      message: 'Verification required.',
    });
  }

  req.user = decoded;
  return next();
}

module.exports = { verifyTokenAndStatus };