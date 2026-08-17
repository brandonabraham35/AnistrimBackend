// middleware/rateLimit.js — rate limiters for auth endpoints.
// Uses express-rate-limit with in-memory store (single-instance deployment).
// For multi-instance, swap in rate-limit-redis.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Standard 429 response shape: { code: 'RATE_LIMITED', retryAfter }
function handler(req, res) {
  const retryAfter = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000) || 60;
  return res.status(429).json({
    code: 'RATE_LIMITED',
    retryAfter,
    message: 'Too many requests. Please try again later.',
  });
}

// Build a per-IP+email key. The official ipKeyGenerator helper normalizes the
// request IP (applying the IPv6 subnet so users cannot bypass limits by cycling
// addresses within their /56), satisfying express-rate-limit's ERR_ERL_KEY_GEN_IPV6
// validation while keeping the composite key: <normalized-ip>:<email>.
function ipEmailKeyGenerator(extraField) {
  return (req) => {
    const value = (req.body && req.body[extraField]) ? String(req.body[extraField]).toLowerCase() : 'unknown';
    return ipKeyGenerator(req.ip) + ':' + value;
  };
}

// Login: 10 attempts / 15 min per IP+email
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipEmailKeyGenerator('email'),
  handler,
});

// OTP verify/resend: 5 attempts / 10 min per IP+email
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipEmailKeyGenerator('email'),
  handler,
});

// Signup: 5 / hour per IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Refresh: 30 / 15 min per IP
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Sensitive ops (change-email, change-password, forgot-password, reset-password):
// 5 / hour per IP
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Google flows: 10 / 15 min per IP
const googleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

module.exports = {
  loginLimiter,
  otpLimiter,
  signupLimiter,
  refreshLimiter,
  sensitiveLimiter,
  googleLimiter,
};