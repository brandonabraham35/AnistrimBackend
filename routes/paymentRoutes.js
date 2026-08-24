// routes/paymentRoutes.js
const express  = require('express');
const router   = express.Router();
const payments = require('../controllers/paymentController');
const { protect, adminOnly } = require('../middleware/auth');
const { ipnLimiter, paymentVerifyLimiter, adminLimiter } = require('../middleware/rateLimit');

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
//  Rate-limited to tolerate legitimate provider retries but
//  prevent abuse. Primary security is server-side verification
//  via Pesapal's getTransactionStatus API.
// ──────────────────────────────────────────────────────────────
router.get('/ipn-listener', ipnLimiter, payments.handlePesapalIPN);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/callback
//  Pesapal redirects user here after payment.
// ──────────────────────────────────────────────────────────────
router.get('/callback', payments.paymentCallback);

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/verify-subscription
//  Authenticated — requires valid JWT. Looks up the subscription
//  by reference, verifies it belongs to the authenticated user,
//  and returns the subscription status. Never exposes another
//  user's subscription data.
// ──────────────────────────────────────────────────────────────
router.get('/verify-subscription', protect, paymentVerifyLimiter, payments.verifySubscriptionPayment);

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