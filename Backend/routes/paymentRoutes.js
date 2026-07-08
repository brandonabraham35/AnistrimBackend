// routes/paymentRoutes.js
const express  = require('express');
const router   = express.Router();
const payments = require('../controllers/paymentController');
const { protect, adminOnly } = require('../middleware/auth');

// Webhook — no auth, Pesapal calls this directly
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString());
  next();
}, payments.webhook);

// Callback — Pesapal redirects user here after payment (no auth needed)
router.get('/callback', payments.paymentCallback);

// Authenticated routes
router.post('/initiate', protect, payments.initiatePayment);
router.get('/verify',    payments.verifyPayment);
router.get('/revenue',   protect, adminOnly, payments.getRevenueStats);

module.exports = router;
