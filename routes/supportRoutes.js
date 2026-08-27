// routes/supportRoutes.js — User support ticket endpoints.
// All routes require authentication. The backend determines user identity
// from the JWT/session — never trusts frontend-supplied user_id or email.
//
// POST   /api/support             — Submit a support request (rate-limited)
// GET    /api/support             — List authenticated user's tickets
// GET    /api/support/:ticket_number — View a single ticket

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { supportLimiter } = require('../middleware/rateLimit');
const supportController = require('../controllers/supportController');

// All support routes require authentication.
router.use(authMiddleware.protect);

// @route   POST /api/support
// @desc    Submit a new support request (rate-limited: 5/hr per user)
// @access  Private
router.post('/', supportLimiter, supportController.createTicket);

// @route   GET /api/support
// @desc    List authenticated user's support tickets
// @access  Private
router.get('/', supportController.listTickets);

// @route   GET /api/support/:ticket_number
// @desc    View a single support ticket (must belong to authenticated user)
// @access  Private
router.get('/:ticket_number', supportController.getTicket);

module.exports = router;
