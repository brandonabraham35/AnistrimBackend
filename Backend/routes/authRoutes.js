const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const { handleImageUpload } = require('../utils/bunnyUpload');

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', authController.login);

// @route   POST /api/auth/avatar
// @desc    Upload user profile avatar
// @access  Private
router.post('/avatar', authMiddleware.protect, (req, res) => {
    // The 'avatars' argument specifies the Cloudinary folder
    handleImageUpload(req, res, 'avatars');
});

module.exports = router;