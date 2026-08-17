// routes/paymentRoutes.js
const express  = require('express');
const router   = express.Router();
const payments = require('../controllers/paymentController');
const { protect, adminOnly } = require('../middleware/auth');

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/checkout
//  Authenticated — initiates Pesapal checkout flow, saves
//  a PENDING subscription record, returns redirect URL.
// ──────────────────────────────────────────────────────────────
router.post('/checkout', protect, payments.initializeCheckout);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/ipn-listener
//  Public — called by Pesapal's servers with query params
//  OrderTrackingId & OrderMerchantReference.
//  No auth required. Returns 200 to confirm receipt.
// ──────────────────────────────────────────────────────────────
router.get('/ipn-listener', payments.handlePesapalIPN);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/callback
//  Pesapal redirects user here after payment.
// ──────────────────────────────────────────────────────────────
router.get('/callback', payments.paymentCallback);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/verify-subscription
//  Public — used for polling subscription status.
// ──────────────────────────────────────────────────────────────
router.get('/verify-subscription', payments.verifySubscriptionPayment);

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/refund
//  Admin — moves a subscription to state='refunded'.
// ──────────────────────────────────────────────────────────────
router.post('/refund', protect, adminOnly, payments.refundSubscription);

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/cancel
//  Admin — moves a subscription to state='cancelled'.
// ──────────────────────────────────────────────────────────────
router.post('/cancel', protect, adminOnly, payments.cancelSubscription);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/subscription-revenue
//  Admin — subscription revenue stats.
// ──────────────────────────────────────────────────────────────
router.get('/subscription-revenue', protect, adminOnly, payments.getSubscriptionRevenueStats);

module.exports = router;