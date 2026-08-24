// controllers/paymentController.js
const axios = require('axios');
const db = require('../config/db');
const pesapal = require('../services/pesapalService');
const { sendSuccess } = require('../utils/response');
const clientAgnostic = require('../config/clientAgnostic');
require('dotenv').config();

const BACKEND_URL = process.env.BACKEND_URL || 'https://anistrimbackend.onrender.com';

// ── Prompt 3: Plan lookup from the `plans` table (single source of truth) ──
// The code-side PLANS/PREMIUM_DURATION_DAYS constants are removed. All plan
// metadata (tier, period, amount, trial_days) comes from the seeded `plans`
// rows. The frontend still sends "monthly"/"yearly" — we map those to the
// seeded plan codes.
const PLAN_CODE_BY_KEY = {
  monthly: 'premium-monthly',
  yearly:  'premium-annual',
};

/**
 * Resolve a plan row from the `plans` table by the frontend plan key.
 * @param {string} planKey - 'monthly' | 'yearly'
 * @returns {Promise<object|null>} plan row or null
 */
async function resolvePlan(planKey) {
  const code = PLAN_CODE_BY_KEY[planKey];
  if (!code) return null;
  const [rows] = await db.query(
    'SELECT id, code, name, tier, period, amount, currency, trial_days FROM plans WHERE code = ? AND is_active = 1 LIMIT 1',
    [code]
  );
  return rows[0] || null;
}

/**
 * Compute the subscription end date from a plan's period.
 * @param {object} plan - plan row (has period: 'monthly'|'annual')
 * @returns {Date}
 */
function planEndsAt(plan) {
  const now = new Date();
  if (plan.period === 'annual') {
    now.setFullYear(now.getFullYear() + 1);
  } else {
    now.setMonth(now.getMonth() + 1);
  }
  return now;
}

/**
 * Write a payment_events row (v35 table — currently never written).
 */
async function logPaymentEvent(subscriptionId, reference, event, payload = {}) {
  try {
    await db.query(
      `INSERT INTO payment_events (subscription_id, reference, event, payload)
       VALUES (?, ?, ?, ?)`,
      [subscriptionId || null, reference || null, event, JSON.stringify(payload)]
    );
  } catch (e) {
    console.warn('[PaymentEvents] Could not write payment event:', e.message);
  }
}

/**
 * Refresh the derived users.is_premium / premium_expires_at cache.
 * This is a derived cache ONLY — never read for authorization.
 */
async function refreshUserPremiumCache(userId) {
  await db.query(
    `UPDATE users u
     SET u.is_premium = IF(
         EXISTS (SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.state IN ('trialing','active','grace')
                   AND (s.ends_at IS NULL OR s.ends_at > NOW())),
         1, 0),
         u.premium_expires_at = (
           SELECT MAX(s.ends_at) FROM subscriptions s
           WHERE s.user_id = u.id AND s.state IN ('trialing','active','grace')
             AND (s.ends_at IS NULL OR s.ends_at > NOW())
         )
     WHERE u.id = ?`,
    [userId]
  );
}

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/checkout
//  Authenticates with Pesapal, registers IPN, submits order,
//  saves a PENDING subscription record with state='pending',
//  plan_id, starts_at, source='payment'. Returns redirect URL.
// ──────────────────────────────────────────────────────────────
exports.initializeCheckout = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user.id;
  const client = ['web', 'mobile', 'desktop', 'admin'].includes(req.headers['x-client']) ? req.headers['x-client'] : 'mobile';

  console.log(`🛒 Checkout: plan=${plan}, userId=${userId}`);

  // Validate plan against the plans table.
  const planRow = await resolvePlan(plan);
  if (!planRow) {
    return res.status(400).json({
      message: `Invalid plan "${plan}". Must be "monthly" or "yearly".`,
    });
  }

  const { amount, name: label } = planRow;

  try {
    // Fetch user details
    const [rows] = await db.query(
      'SELECT id, name, email FROM users WHERE id = ?',
      [userId]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }
    const user = rows[0];

    // Generate a unique merchant reference
    const reference = `ANISTRIM-${userId}-${Date.now()}`;

    // 1. Get Pesapal OAuth token
    const token = await pesapal.getToken();

    // 2. Register / retrieve IPN ID
    const ipnUrl = `${BACKEND_URL}/api/payments/ipn-listener`;
    const ipnId = await pesapal.registerIPN(token, ipnUrl);

    // 3. Build callback URL (user lands here after payment)
    const callbackUrl = `${BACKEND_URL}/api/payments/callback?tx_ref=${encodeURIComponent(reference)}&client=${encodeURIComponent(client)}`;

    // 4. Persist the pending row before the external side effect. If Pesapal
    // accepts the order but the tracking-ID update is interrupted, IPN can
    // still find this row by its merchant reference and reconcile it.
    const [insertResult] = await db.query(
      `INSERT INTO subscriptions
        (user_id, reference, amount, currency, status, plan, order_tracking_id,
         plan_id, starts_at, state, source)
       VALUES (?, ?, ?, 'UGX', 'PENDING', ?, NULL, ?, NOW(), 'pending', 'payment')`,
      [userId, reference, amount, plan, planRow.id]
    );

    // 5. Submit the external order only after the local pending record exists.
    let orderResult;
    try {
      orderResult = await pesapal.submitOrder(token, {
        id: reference,
        currency: 'UGX',
        amount: amount,
        description: label,
        callback_url: callbackUrl,
        notification_id: ipnId,
        email: user.email,
        firstName: user.name.split(' ')[0] || user.name,
        lastName: user.name.split(' ').slice(1).join(' ') || '',
      });
    } catch (submitError) {
      // The reference was never presented to the customer, but retaining a
      // failed audit row prevents a retry from being mistaken for a completed
      // payment and does not create a second charge.
      await db.query(
        `UPDATE subscriptions SET status = 'FAILED', state = 'expired' WHERE id = ?`,
        [insertResult.insertId]
      );
      throw submitError;
    }

    try {
      await db.query(
        `UPDATE subscriptions SET order_tracking_id = ? WHERE id = ?`,
        [orderResult.order_tracking_id, insertResult.insertId]
      );
    } catch (trackingError) {
      // Do not ask the customer to retry a submitted order: the pending row is
      // already durable by reference, and the callback/IPN path can attach the
      // tracking ID later without creating another charge.
      console.error('[Payments] Pending tracking-ID update failed:', trackingError.message);
    }

    await logPaymentEvent(insertResult.insertId, reference, 'pending', {
      plan: plan,
      plan_id: planRow.id,
      amount,
      orderTrackingId: orderResult.order_tracking_id,
      order_tracking_id: orderResult.order_tracking_id,
    });

    console.log(
      `✅ Checkout complete: ref=${reference}, trackingId=${orderResult.order_tracking_id}`
    );

    return sendSuccess(res, {
      paymentLink: orderResult.redirect_url,
      payment_link: orderResult.redirect_url,
      txRef: reference,
      tx_ref: reference,
      orderTrackingId: orderResult.order_tracking_id,
      order_tracking_id: orderResult.order_tracking_id,
    }, { message: 'Payment link created.' });
  } catch (err) {
    console.error('❌ initializeCheckout error:', err.response?.data || err.message);
    if (err.code === 'PESAPAL_IPN_CONFLICT') {
      return res.status(503).json({
        message: 'Payments are temporarily unavailable because the IPN configuration needs attention.',
      });
    }
    res.status(500).json({
      message: 'Could not initiate payment. Please try again.',
    });
  }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/payments/ipn-listener
//  Public webhook called by Pesapal servers.
//  Pesapal sends query params: OrderTrackingId, OrderMerchantReference
//
//  SECURITY:
//  • Pesapal does NOT provide an HMAC/webhook signature.
//  • Primary verification is via Pesapal's getTransactionStatus API
//    (server-side, not client-trusted).
//  • Amount and currency are verified against the plan.
//  • Merchant reference is verified against the subscription.
//  • Completed payments are never downgraded.
//  • Idempotent — replayed IPNs are safe.
//  • Rate-limited (see ipnLimiter in middleware/rateLimit.js).
// ──────────────────────────────────────────────────────────────
exports.handlePesapalIPN = async (req, res) => {
  const { OrderTrackingId, OrderMerchantReference } = req.query;

  // Always return 200 to acknowledge receipt to Pesapal.
  const ack = () => sendSuccess(res, { status: 200 });

  if (!OrderTrackingId || !OrderMerchantReference) {
    console.warn('[IPN] Missing required params');
    return ack();
  }

  try {
    // 1. Get Pesapal OAuth token
    const token = await pesapal.getToken();

    // 2. Query transaction status from Pesapal (authoritative source)
    const txnStatus = await pesapal.getTransactionStatus(token, OrderTrackingId);

    // 3. Verify the transaction exists in Pesapal's system
    if (!txnStatus || !txnStatus.status) {
      console.warn(`[IPN] Invalid transaction status from Pesapal for trackingId=${OrderTrackingId}`);
      return ack();
    }

    // 4. Verify merchant_reference matches what we expect
    if (txnStatus.merchant_reference && txnStatus.merchant_reference !== OrderMerchantReference) {
      console.warn(
        `[IPN] Merchant reference mismatch: expected=${OrderMerchantReference}, ` +
        `got=${txnStatus.merchant_reference}`
      );
      return ack();
    }

    // 5. Find the subscription by reference
    const [subs] = await db.query(
      `SELECT * FROM subscriptions WHERE reference = ?`,
      [OrderMerchantReference]
    );

    if (!subs.length) {
      console.warn(`[IPN] No subscription found for ref=${OrderMerchantReference}`);
      return ack();
    }

    const subscription = subs[0];

    // 6. Verify amount if available from Pesapal
    if (txnStatus.amount !== undefined && txnStatus.amount !== null) {
      const txnAmount = Number(txnStatus.amount);
      const subAmount = Number(subscription.amount);
      if (subAmount > 0 && Math.abs(txnAmount - subAmount) > 1) {
        // Allow 1-unit tolerance for currency rounding
        console.warn(
          `[IPN] Amount mismatch: expected=${subAmount}, got=${txnAmount} ` +
          `for ref=${OrderMerchantReference}`
        );
        return ack();
      }
    }

    // 7. Verify currency if available from Pesapal
    if (txnStatus.currency && subscription.currency) {
      const txnCurrency = String(txnStatus.currency).toUpperCase();
      const subCurrency = String(subscription.currency).toUpperCase();
      if (txnCurrency !== subCurrency) {
        console.warn(
          `[IPN] Currency mismatch: expected=${subCurrency}, got=${txnCurrency} ` +
          `for ref=${OrderMerchantReference}`
        );
        return ack();
      }
    }

    // 8. Check if payment is completed
    if (!pesapal.isPaymentCompleted(txnStatus.status)) {
      console.log(`[IPN] Payment not completed (status: ${txnStatus.status}).`);

      // Only update to FAILED if the subscription is still PENDING.
      // Never downgrade an already completed payment.
      if (subscription.status === 'PENDING' || subscription.status === 'pending') {
        await db.query(
          `UPDATE subscriptions
           SET status = 'FAILED', state = 'expired', payment_method = ?, order_tracking_id = ?
           WHERE id = ? AND status = 'PENDING'`,
          [txnStatus.payment_method || null, OrderTrackingId, subscription.id]
        );
        await logPaymentEvent(subscription.id, OrderMerchantReference, 'failed', {
          status: txnStatus.status,
          order_tracking_id: OrderTrackingId,
        });
      } else {
        console.log(`[IPN] Skipping FAILED update — subscription in state: ${subscription.status}`);
      }
      return ack();
    }

    // 9. Payment is COMPLETED — resolve plan + compute expiry.
    //    Never downgrade an already completed payment.
    if (subscription.status === 'COMPLETED') {
      console.log(`[IPN] Duplicate IPN — payment already completed for ref=${OrderMerchantReference}`);
      return ack();
    }

    const planRow = await resolvePlan(subscription.plan);
    if (!planRow) {
      console.error(`[IPN] Plan not found for key "${subscription.plan}"`);
      return ack();
    }
    const startsAt = new Date();
    const endsAt = planEndsAt(planRow);

    console.log(`[IPN] Payment COMPLETED for user ${subscription.user_id}. Premium until ${endsAt}`);

    // 10. Atomic update with idempotency guard
    //     Only update if status is not already COMPLETED.
    const [updateResult] = await db.query(
      `UPDATE subscriptions
       SET status = 'COMPLETED',
           state = 'active',
           payment_method = ?,
           order_tracking_id = ?,
           paid_at = NOW(),
           starts_at = ?,
           ends_at = ?,
           plan_id = ?
       WHERE id = ? AND status != 'COMPLETED'`,
      [
        txnStatus.payment_method || null,
        OrderTrackingId,
        startsAt,
        endsAt,
        planRow.id,
        subscription.id,
      ]
    );

    if (updateResult.affectedRows === 0) {
      console.log(`[IPN] Concurrent/duplicate — subscription already completed for ref=${OrderMerchantReference}`);
      return ack();
    }

    // 11. Refresh the derived users.is_premium / premium_expires_at cache.
    await refreshUserPremiumCache(subscription.user_id);

    await logPaymentEvent(subscription.id, OrderMerchantReference, 'success', {
      plan: subscription.plan,
      plan_id: planRow.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      order_tracking_id: OrderTrackingId,
    });

    console.log(`[IPN] Premium granted to user ${subscription.user_id} until ${endsAt}`);

    return ack();
  } catch (err) {
    console.error('[IPN] Processing error:', err.message);
    // Always return 200 so Pesapal knows we received it
    return ack();
  }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/refund
//  Admin — moves a subscription to state='refunded' and revokes premium.
// ──────────────────────────────────────────────────────────────
exports.refundSubscription = async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ message: 'reference is required.' });

  try {
    const [subs] = await db.query(
      'SELECT id, user_id FROM subscriptions WHERE reference = ? LIMIT 1',
      [reference]
    );
    if (!subs.length) return res.status(404).json({ message: 'Subscription not found.' });

    const sub = subs[0];
    await db.query(
      `UPDATE subscriptions SET state = 'refunded', status = 'REFUNDED' WHERE id = ?`,
      [sub.id]
    );
    await refreshUserPremiumCache(sub.user_id);
    await logPaymentEvent(sub.id, reference, 'refunded', { by: req.user?.id || null });

    return sendSuccess(res, null, { message: 'Subscription refunded.' });
  } catch (err) {
    console.error('❌ Refund error:', err.message);
    res.status(500).json({ message: 'Refund failed.' });
  }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/payments/cancel
//  Admin — moves a subscription to state='cancelled' and revokes premium.
// ──────────────────────────────────────────────────────────────
exports.cancelSubscription = async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ message: 'reference is required.' });

  try {
    const [subs] = await db.query(
      'SELECT id, user_id FROM subscriptions WHERE reference = ? LIMIT 1',
      [reference]
    );
    if (!subs.length) return res.status(404).json({ message: 'Subscription not found.' });

    const sub = subs[0];
    await db.query(
      `UPDATE subscriptions SET state = 'cancelled', status = 'CANCELLED' WHERE id = ?`,
      [sub.id]
    );
    await refreshUserPremiumCache(sub.user_id);
    await logPaymentEvent(sub.id, reference, 'cancelled', { by: req.user?.id || null });

    return sendSuccess(res, null, { message: 'Subscription cancelled.' });
  } catch (err) {
    console.error('❌ Cancel error:', err.message);
    res.status(500).json({ message: 'Cancel failed.' });
  }
};

// GET /api/payments/callback
// Client-agnostic callback. Returns a structured JSON payload describing the
// payment outcome so the consuming client (web, mobile, desktop, admin) can
// decide what to render. No HTML/application UI is generated here, and no
// payment secrets are exposed. Backward-compatible bridge HTML is provided
// only via an explicit `?render=html` flag (used by the legacy web bridge page
// /payment-callback.html).
exports.paymentCallback = async (req, res) => {
  const { tx_ref, OrderTrackingId, render } = req.query;
  const txRef = tx_ref || req.query.OrderMerchantReference;
  const client = ['web', 'mobile', 'desktop', 'admin'].includes(req.query.client) ? req.query.client : '';
  if (!txRef) {
    if (render === 'html') return res.send(buildBridgePage('error', null, 'Missing transaction reference.'));
    return res.status(400).json({
      success: false,
      code: 'MISSING_REFERENCE',
      status: 'error',
      message: 'Missing transaction reference.',
    });
  }

  try {
    const [rows] = await db.query(`SELECT status, state FROM subscriptions WHERE reference = ?`, [txRef]);
    const status = rows[0]?.status || 'pending';
    const state = rows[0]?.state || 'pending';
    if (OrderTrackingId && rows.length) {
      await db.query(`UPDATE subscriptions SET order_tracking_id = ? WHERE reference = ?`, [OrderTrackingId, txRef]);
    }

    // Never expose payment secrets. Only structured, client-actionable status.
    const payload = {
      success: status === 'COMPLETED',
      status: lowercaseStatus(status),
      state,
      txRef,
      message: toCallbackMessage(status),
    };

    // A provider's browser return is not proof of payment. Redirect only to a
    // configured client target; that UI verifies/polls this reference and then
    // refreshes the canonical entitlement DTO.
    if (client) {
      const target = clientAgnostic.getPaymentReturnTarget(client);
      const targetUrl = clientAgnostic.buildClientUrl(target, process.env.FRONTEND_URL || BACKEND_URL);
      const separator = targetUrl.includes('?') ? '&' : '?';
      return res.redirect(`${targetUrl}${separator}reference=${encodeURIComponent(txRef)}&status=${encodeURIComponent(payload.status)}`);
    }

    // Web bridge page is served ONLY when the client explicitly opts in.
    if (render === 'html') return res.send(buildBridgePage(status, txRef, null));

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Payment callback error:', err.message);
    if (render === 'html') return res.send(buildBridgePage('error', txRef, 'Verification error.'));
    return res.status(500).json({ success: false, status: 'error', txRef, message: 'Verification error.' });
  }
};

// GET /api/payments/verify-subscription
// Requires authentication (protect middleware in route).
// Verifies the subscription reference belongs to the authenticated user.
exports.verifySubscriptionPayment = async (req, res) => {
  const { reference } = req.query;
  const userId = req.userId ?? req.user?.id;

  if (!reference) {
    return res.status(400).json({ message: 'Transaction reference (reference) is required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT status, state, plan, amount, currency, ends_at, paid_at
       FROM subscriptions
       WHERE reference = ? AND user_id = ?`,
      [reference, userId]
    );

    if (!rows.length) {
      // Neutral — never reveal whether the reference exists or belongs to another user.
      return res.status(404).json({ message: 'Subscription not found.' });
    }

    const sub = rows[0];
    return sendSuccess(res, {
      status: sub.status,
      state: sub.state,
      plan: sub.plan,
      amount: sub.amount,
      currency: sub.currency,
      endsAt: sub.ends_at,
      ends_at: sub.ends_at,
      paidAt: sub.paid_at,
      paid_at: sub.paid_at,
    });
  } catch (err) {
    console.error('❌ verifySubscriptionPayment error:', err.message);
    res.status(500).json({ message: 'Verification error.' });
  }
};

// GET /api/payments/subscription-revenue
exports.getSubscriptionRevenueStats = async (req, res) => {
  try {
    const [stats] = await db.query(`
      SELECT
        COUNT(*) AS total_transactions,
        SUM(CASE WHEN status = 'COMPLETED' THEN amount ELSE 0 END) AS total_revenue,
        SUM(CASE WHEN status = 'COMPLETED' AND plan = 'monthly' THEN 1 ELSE 0 END) AS monthly_subs,
        SUM(CASE WHEN status = 'COMPLETED' AND plan = 'yearly' THEN 1 ELSE 0 END) AS yearly_subs,
        SUM(CASE WHEN status = 'COMPLETED' AND DATE(paid_at) = CURDATE() THEN amount ELSE 0 END) AS revenue_today,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count
      FROM subscriptions`);

    const [recent] = await db.query(`
      SELECT s.id, u.name, u.email, s.amount, s.currency, s.status, s.state, s.plan, s.paid_at, s.created_at, s.reference
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at DESC
      LIMIT 20`);

    return sendSuccess(res, { stats: stats[0], recent });
  } catch (err) {
    console.error('❌ getSubscriptionRevenueStats error:', err.message);
    res.status(500).json({ message: 'Could not fetch subscription revenue stats.' });
  }
};

// Map status string to a stable lowercase machine-readable value.
function lowercaseStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'COMPLETED') return 'completed';
  if (s === 'PENDING') return 'pending';
  if (s === 'FAILED') return 'failed';
  if (s === 'REFUNDED') return 'refunded';
  if (s === 'CANCELLED') return 'cancelled';
  return 'unknown';
}

// Human-readable message derived from status (no secrets).
function toCallbackMessage(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'COMPLETED') return 'Payment completed successfully.';
  if (s === 'PENDING') return 'Payment is being confirmed.';
  if (s === 'FAILED') return 'Payment was not completed.';
  if (s === 'REFUNDED') return 'Payment was refunded.';
  if (s === 'CANCELLED') return 'Payment was cancelled.';
  return 'Payment status unknown.';
}

function buildBridgePage(status, txRef, errorMsg) {
  const appLink = `anistrim://payment-result?tx_ref=${txRef || ''}&status=${status}`;
  if (status === 'successful' || status === 'COMPLETED') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${appLink}"><title>Payment Successful</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #22c55e;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#22c55e;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">🎉</div><h2>Payment Successful!</h2><p>Welcome to AniStrim Premium! Tap below to start watching.</p><a href="${appLink}" id="btn">🎬 Open AniStrim</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
  }
  if (status === 'pending' || status === 'PENDING') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${appLink}"><title>Payment Pending</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #f97316;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#f97316;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">⏳</div><h2>Payment Processing</h2><p>Your payment is being confirmed.</p><a href="${appLink}" id="btn">← Back to AniStrim</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
  }
  const upgradeLink = 'anistrim://upgrade';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Failed</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #ef4444;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#ef4444;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600;margin-bottom:8px}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">❌</div><h2>Payment Failed</h2><p>${errorMsg || 'Your payment was not completed. You have not been charged.'}</p><a href="${upgradeLink}" id="btn">Try Again</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
}
