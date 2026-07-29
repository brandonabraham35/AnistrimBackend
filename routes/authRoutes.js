const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const googleVerifyController = require('../controllers/googleVerifyController');
const authMiddleware = require('../middleware/auth');
const { handleImageUpload } = require('../utils/bunnyUpload');

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', authController.login);

// @route   POST /api/auth/signup
// @desc    Register a new user account
// @access  Public
router.post('/signup', authController.signup);

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

// @route   POST /api/auth/avatar
// @desc    Upload user profile avatar
// @access  Private
router.post('/avatar', authMiddleware.protect, (req, res) => {
    // The 'avatars' argument specifies the Cloudinary folder
    handleImageUpload(req, res, 'avatars');
});

module.exports = router;
