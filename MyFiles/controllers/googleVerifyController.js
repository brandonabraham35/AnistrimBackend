// controllers/googleVerifyController.js
// Google Identity Services (GIS) flows:
//   POST /api/auth/google/verify  -> LOGIN only (never creates an account)
//   POST /api/auth/google/signup  -> SIGNUP only (may create an account)
//
// Both verify the ID token server-side, but the business decision (login vs
// signup) is made in the SHARED resolveGoogleIdentity(idToken, intent) helper
// (services/googleIdentityService.js) so the web GIS and native Capacitor
// flows apply the IDENTICAL intent rule.
const { resolveGoogleIdentity } = require('../services/googleIdentityService');
const sessionService = require('../services/sessionService');
const { buildUserDto } = require('../services/userDtoService');

// ── Google LOGIN (existing account only) ───────────────────
exports.verifyGoogleToken = function (req, res) {
  // Manual async wrapper for Express 5 (it does not auto-catch).
  (async () => {
    try {
      const { idToken } = req.body;
      const { user } = await resolveGoogleIdentity(idToken, 'login');

      // Create a session (access + refresh tokens).
      const { accessToken, refreshToken, sessionId } = await sessionService.createSession(user, req);
      await sessionService.logEvent(user.id, 'google_login', 'google', req);

      // Build the canonical user DTO.
      const dto = await buildUserDto(user);

      return res.json({
        token: accessToken,
        refreshToken,
        sessionId,
        user: dto,
        message: 'Welcome back!',
      });
    } catch (err) {
      console.error('Google login (verify) error:', err.message);
      if (err.status === 400) {
        return res.status(400).json({ success: false, code: err.code || 'GOOGLE_INVALID_REQUEST', message: err.message });
      }
      if (err.status === 404) {
        return res.status(404).json({ success: false, code: err.code || 'GOOGLE_NO_ACCOUNT', message: err.message });
      }
      if (err.status === 403) {
        return res.status(403).json({ success: false, code: err.code || 'GOOGLE_ACCOUNT_NOT_LINKED', message: err.message });
      }
      if (err.message && err.message.includes('Token used too late')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_TOKEN_EXPIRED', message: 'Google token has expired. Please try again.' });
      }
      if (err.message && err.message.includes('Invalid token')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_INVALID_TOKEN', message: 'Invalid Google token. Please try again.' });
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({ success: false, code: 'GOOGLE_NETWORK_ERROR', message: 'Unable to verify Google token. Network error.' });
      }
      return res.status(401).json({ success: false, code: 'GOOGLE_VERIFY_FAILED', message: 'Google verification failed. Please try again.' });
    }
  })();
};

// ── Google SIGNUP (may create an account) ──────────────────
exports.googleSignup = function (req, res) {
  (async () => {
    try {
      const { idToken } = req.body;
      const { user } = await resolveGoogleIdentity(idToken, 'signup');

      // Create a session (access + refresh tokens).
      const { accessToken, refreshToken, sessionId } = await sessionService.createSession(user, req);
      await sessionService.logEvent(user.id, 'google_login', 'google', req);

      // Build the canonical user DTO.
      const dto = await buildUserDto(user);

      return res.status(201).json({
        token: accessToken,
        refreshToken,
        sessionId,
        user: dto,
        message: 'Account created. Welcome!',
      });
    } catch (err) {
      console.error('Google signup error:', err.message);
      if (err.status === 400) {
        return res.status(400).json({ success: false, code: err.code || 'GOOGLE_INVALID_REQUEST', message: err.message });
      }
      if (err.status === 409) {
        return res.status(409).json({ success: false, code: err.code || 'ACCOUNT_ALREADY_EXISTS', message: err.message });
      }
      if (err.message && err.message.includes('Token used too late')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_TOKEN_EXPIRED', message: 'Google token has expired. Please try again.' });
      }
      if (err.message && err.message.includes('Invalid token')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_INVALID_TOKEN', message: 'Invalid Google token. Please try again.' });
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({ success: false, code: 'GOOGLE_NETWORK_ERROR', message: 'Unable to verify Google token. Network error.' });
      }
      return res.status(401).json({ success: false, code: 'GOOGLE_VERIFY_FAILED', message: 'Google verification failed. Please try again.' });
    }
  })();
};