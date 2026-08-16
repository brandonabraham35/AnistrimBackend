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
//  LEGACY: Webhook — Pesapal calls this directly.
//  Kept for backward compatibility, but now optionally protected by a shared
//  secret (PAYMENT_WEBHOOK_SECRET) when configured. Without a secret set, it
//  falls back to the previous behaviour (re-verifying the order status against
//  Pesapal before granting premium) so existing integrations keep working.
// ──────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString());
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (secret) {
    const supplied = req.get('x-webhook-signature') || req.query.signature || '';
    if (supplied !== secret) {
      return res.status(401).json({ message: 'Invalid webhook signature.' });
    }
  }
  next();
}, payments.webhook);

// ──────────────────────────────────────────────────────────────
//  LEGACY: Callback — Pesapal redirects user here after payment
//  Kept for backward compatibility.
// ──────────────────────────────────────────────────────────────
router.get('/callback', payments.paymentCallback);

// ──────────────────────────────────────────────────────────────
//  NEW: Verify subscription payment (public — used for polling)
// ──────────────────────────────────────────────────────────────
router.get('/verify-subscription', payments.verifySubscriptionPayment);

// ──────────────────────────────────────────────────────────────
//  NEW: Subscription revenue stats (admin only)
// ──────────────────────────────────────────────────────────────
router.get('/subscription-revenue', protect, adminOnly, payments.getSubscriptionRevenueStats);

// ──────────────────────────────────────────────────────────────
//  Authenticated routes (legacy)
// ──────────────────────────────────────────────────────────────
router.post('/initiate', protect, payments.initiatePayment);
router.get('/verify',    payments.verifyPayment);
router.get('/revenue',   protect, adminOnly, payments.getRevenueStats);

module.exports = router;
