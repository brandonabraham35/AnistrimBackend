const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authController = require('../controllers/authController');
const googleVerifyController = require('../controllers/googleVerifyController');
const googleAuthController = require('../controllers/googleAuthController');
const authMiddleware = require('../middleware/auth');
const { handleImageUpload } = require('../utils/bunnyUpload');

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
// @desc    Fetch the current authenticated user profile
// @access  Private
router.get('/me', authMiddleware.protect, authController.getMe);

// @route   POST /api/auth/forgot-password
// @desc    Request a password reset token for a user email
// @access  Public
router.post('/forgot-password', authController.forgotPassword);

// @route   POST /api/auth/reset-password
// @desc    Reset a user password using the reset token
// @access  Public
router.post('/reset-password', authController.resetPassword);

// @route   POST /api/auth/google/verify
// @desc    Verify Google ID Token from GIS popup (no redirect)
// @access  Public
router.post('/google/verify', googleVerifyController.verifyGoogleToken);

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
// These routes power the `anistrim://auth` deep-link handoff used by the
// native app. They were previously unmounted, leaving the mobile flow broken.

// @route   GET /api/auth/google/start
// @desc    Begin the Google OAuth redirect flow (mobile)
// @access  Public
router.get('/google/start', googleAuthController.googleRedirect);

// @route   GET /api/auth/google/callback
// @desc    Google redirect_uri — exchanges the OAuth code, creates a short-lived
//          login code, then deep-links back into the app.
// @access  Public
router.get('/google/callback', googleAuthController.googleCallback);

// @route   GET /api/auth/google/token
// @desc    Exchange the short-lived login code for a JWT + user. This is the
//          endpoint the mobile frontend (google-auth-handler.js) calls after
//          receiving anistrim://auth?code=...
// @access  Public
router.get('/google/token', googleAuthController.exchangeLoginCode);

// @route   POST /api/auth/avatar
// @desc    Upload user profile avatar
// @access  Private
router.post('/avatar', authMiddleware.protect, async (req, res) => {
    // The 'avatars' argument specifies the Cloudinary folder.
    // onUploaded persists the returned avatar URL to users.avatar_url so the
    // profile survives a refresh (getMe reads avatar_url from the DB).
    await handleImageUpload(req, res, 'avatars', async (result) => {
        const avatarUrl = result?.secure_url || result?.url || result?.image_url || null;
        if (avatarUrl && req.user?.id) {
            await db.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.id]);
        }
    });
});

module.exports = router;
