const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authController = require('../controllers/authController');
const googleVerifyController = require('../controllers/googleVerifyController');
const googleAuthController = require('../controllers/googleAuthController');
const authMiddleware = require('../middleware/auth');

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', authController.login);

// @route   POST /api/auth/signup
// @desc    Register a new user account (requires email verification)
// @access  Public
router.post('/signup', authController.signup);

// @route   POST /api/auth/verify-email
// @desc    Verify a manual registration using the emailed 6-digit OTP
// @access  Public
router.post('/verify-email', authController.verifyEmailToken);

// @route   POST /api/auth/verify-otp
// @desc    Alias for /verify-email (spec-canonical route name)
// @access  Public
router.post('/verify-otp', authController.verifyEmailToken);

// @route   POST /api/auth/resend-otp
// @desc    Resend a new 6-digit verification code (throttled)
// @access  Public
router.post('/resend-otp', authController.resendVerification);

// @route   GET /api/auth/me
// @desc    Fetch the current authenticated user profile (canonical DTO)
// @access  Private
router.get('/me', authMiddleware.protect, authController.getMe);

// @route   POST /api/auth/forgot-password
// @desc    Request a password reset token for a user email
// @access  Public
router.post('/forgot-password', authController.forgotPassword);

// @route   POST /api/auth/set-password
// @desc    Set a password for the AUTHENTICATED account (e.g. Google-only
//          users). Requires a valid session JWT — proves ownership.
// @access  Private
router.post('/set-password', authMiddleware.protect, authController.setPassword);

// @route   POST /api/auth/reset-password
// @desc    Reset a user password using the reset token
// @access  Public
router.post('/reset-password', authController.resetPassword);

// ── Phase 1 — Session lifecycle ──────────────────────────────

// @route   POST /api/auth/refresh
// @desc    Rotate refresh token, issue a new access token
// @access  Public (refresh token in body)
router.post('/refresh', authController.refresh);

// @route   POST /api/auth/logout
// @desc    Revoke the current session
// @access  Private
router.post('/logout', authMiddleware.protect, authController.logout);

// @route   POST /api/auth/logout-all
// @desc    token_version++, revoke all sessions
// @access  Private
router.post('/logout-all', authMiddleware.protect, authController.logoutAll);

// @route   GET /api/auth/sessions
// @desc    List active devices (current flagged)
// @access  Private
router.get('/sessions', authMiddleware.protect, authController.listSessions);

// @route   DELETE /api/auth/sessions/:id
// @desc    Revoke one device
// @access  Private
router.delete('/sessions/:id', authMiddleware.protect, authController.revokeSession);

// ── Phase 1 — Account management ─────────────────────────────

// @route   POST /api/auth/change-password
// @desc    Verify old password, token_version++, keep current session
// @access  Private
router.post('/change-password', authMiddleware.protect, authController.changePassword);

// @route   POST /api/auth/change-email
// @desc    Send OTP to the new address
// @access  Private
router.post('/change-email', authMiddleware.protect, authController.changeEmail);

// @route   POST /api/auth/change-email/confirm
// @desc    Swap email, log event
// @access  Private
router.post('/change-email/confirm', authMiddleware.protect, authController.confirmChangeEmail);

// @route   POST /api/auth/account/deactivate
// @desc    status='deactivated', revoke sessions
// @access  Private
router.post('/account/deactivate', authMiddleware.protect, authController.deactivateAccount);

// @route   POST /api/auth/account/delete
// @desc    Soft-delete: status='deleted', deleted_at=NOW(), anonymise email
// @access  Private
router.post('/account/delete', authMiddleware.protect, authController.deleteAccount);

// ── Google flows ─────────────────────────────────────────────

// @route   POST /api/auth/google/verify
// @desc    Google LOGIN only — verifies the ID token and authenticates an
//          EXISTING AniStrim account. Never creates or silently links.
// @access  Public
router.post('/google/verify', googleVerifyController.verifyGoogleToken);

// @route   POST /api/auth/google/signup
// @desc    Google SIGNUP only — verifies the ID token and creates a NEW AniStrim
//          account. Rejects if the email or google_id already exists.
// @access  Public
router.post('/google/signup', googleVerifyController.googleSignup);

// @route   GET /api/auth/google/client-id
// @desc    Expose Google Client ID to frontend for GIS initialization
// @access  Public
router.get('/google/client-id', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(404).json({ message: 'Google Client ID not configured.' });
  }
  res.json({ clientId });
});

// ── Google OAuth redirect flow (Capacitor / mobile deep-link) ──

// @route   GET /api/auth/google/start
// @desc    Begin the Google OAuth redirect flow (mobile). ?intent=login|signup
// @access  Public
router.get('/google/start', googleAuthController.googleRedirect);

// @route   GET /api/auth/google/callback
// @desc    Google redirect_uri — applies the login/signup intent, then deep-links
//          back into the app with a short-lived login code.
// @access  Public
router.get('/google/callback', googleAuthController.googleCallback);

// @route   GET /api/auth/google/token
// @desc    Exchange the short-lived login code for a JWT + user + intent.
// @access  Public
router.get('/google/token', googleAuthController.exchangeLoginCode);

// Note: POST /api/auth/avatar is now handled by routes/avatarRoutes.js
// (secure magic-byte sniffing + 512×512 webp re-encode), mounted at /api/auth
// in server.js. The route is intentionally not redefined here.

module.exports = router;
