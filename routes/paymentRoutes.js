// routes/paymentRoutes.js
const express  = require('express');
const router   = express.Router();
const payments = require('../controllers/paymentController');
const { protect, adminOnly } = require('../middleware/auth');

// ──────────────────────────────────────────────────────────────
//  NEW: POST /api/payments/checkout
//  Authenticated — initiates Pesapal checkout flow, saves
//  a PENDING subscription record, returns redirect URL.
// ──────────────────────────────────────────────────────────────
router.post('/checkout', protect, payments.initializeCheckout);

// ──────────────────────────────────────────────────────────────
//  NEW: GET /api/payments/ipn-listener
//  Public — called by Pesapal's servers with query params
//  OrderTrackingId & OrderMerchantReference.
//  No auth required. Returns 200 to confirm receipt.
// ──────────────────────────────────────────────────────────────
router.get('/ipn-listener', payments.handlePesapalIPN);

// ──────────────────────────────────────────────────────────────
//  LEGACY: Webhook — no auth, Pesapal calls this directly
//  Kept for backward compatibility with existing frontend.
// ──────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString());
  next();
}, payments.webhook);

// ──────────────────────────────────────────────────────────────
//  LEGACY: Callback — Pesapal redirects user here after payment
//  Kept for backward compatibility.
// ──────────────────────────────────────────────────────────────
router.get('/callback', payments.paymentCallback);

// ──────────────────────────────────────────────────────────────
//  Authenticated routes (legacy)
// ──────────────────────────────────────────────────────────────
router.post('/initiate', protect, payments.initiatePayment);
router.get('/verify',    payments.verifyPayment);
router.get('/revenue',   protect, adminOnly, payments.getRevenueStats);

module.exports = router;
