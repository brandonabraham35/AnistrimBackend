// routes/authRoutes.js
const express = require('express');
const router  = express.Router();
const auth    = require('../controllers/authController');
const google  = require('../controllers/googleAuthController');   // old redirect flow (keep for fallback)
const gVerify = require('../controllers/googleVerifyController'); // new GIS flow
const { protect } = require('../middleware/auth');

// ── Email/password routes ──────────────────────────────────
router.post('/signup',          auth.register);
router.post('/login',           auth.login);
router.get('/me',               protect, auth.getMe);
router.post('/forgot-password', auth.forgotPassword);
router.post('/reset-password',  auth.resetPassword);

// ── Google OAuth — redirect flow (old, keep as fallback) ───
router.get('/google',          google.googleRedirect);
router.get('/google/callback', google.googleCallback);
router.get('/google/token',    google.exchangeLoginCode);

// ── Google GIS — direct token verification (NEW, preferred) ─
router.post('/google/verify',  gVerify.verifyGoogleToken);

module.exports = router;
