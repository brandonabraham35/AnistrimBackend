// routes/profileRoutes.js — Phase 2 profile routes.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const profileController = require('../controllers/profileController');

// @route   GET /api/auth/username-available
// @desc    Live uniqueness check for onboarding username
// @access  Private (authenticated user checking their own availability)
router.get('/username-available', authMiddleware.protect, profileController.checkUsername);

// @route   POST /api/auth/set-username
// @desc    Set/update the user's username (standalone)
// @access  Private
router.post('/set-username', authMiddleware.protect, profileController.setUsername);

// @route   POST /api/profile/onboarding
// @desc    Complete onboarding: display name, username, avatar (optional), genres
// @access  Private
router.post('/onboarding', authMiddleware.protect, profileController.onboard);

// @route   GET /api/profile/preferences
// @desc    Read current preferences
// @access  Private
router.get('/preferences', authMiddleware.protect, profileController.getPreferences);

// @route   PUT /api/profile/preferences
// @desc    Update preferences
// @access  Private
router.put('/preferences', authMiddleware.protect, profileController.updatePreferences);

// @route   DELETE /api/profile/history
// @desc    Clear watch history
// @access  Private
router.delete('/history', authMiddleware.protect, profileController.clearHistory);

module.exports = router;