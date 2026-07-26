const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth'); // Assuming you have this middleware

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', authController.login);

// NOTE: Other routes like /signup and /me would also be defined here.
// router.post('/signup', authController.signup);
// router.get('/me', authMiddleware.protect, authController.getMe);

module.exports = router;