// middleware/authMiddleware.js
// Strict verification-aware authentication middleware for AniStrim.
//
// verifyTokenAndStatus:
//   • Extracts the Bearer JWT from the Authorization header
//   • Decodes it with process.env.JWT_SECRET
//   • If the decoded token carries isVerified: false, halts with HTTP 403
//     and { success: false, requiresVerification: true, message: "Verification required." }
//   • Otherwise attaches the decoded payload to req.user and calls next()
//
// This is intended to guard the streaming resolution engine so unverified
// manual registrations cannot stream content until they verify their email.

const jwt = require('jsonwebtoken');

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
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Token expired or invalid. Please log in again.',
    });
  }

  // Strict gate: unverified users are blocked from the protected engine.
  if (decoded.isVerified === false) {
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