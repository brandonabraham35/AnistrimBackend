// controllers/paymentController.js
const axios = require('axios');
const db = require('../config/db');
require('dotenv').config();

const PESAPAL_BASE = 'https://pay.pesapal.com/v3';
const BACKEND_URL = process.env.BACKEND_URL || 'https://anistrimbackend.onrender.com';

// ── CORRECTED PLANS (monthly = 180000 per spec) ──────────────
const PLANS = {
  monthly: { amount: 15000, label: 'AniStrim Premium Monthly' },
  yearly: { amount: 180000, label: 'AniStrim Premium Yearly' },
};

async function getPesapalToken() {
  try {
    const response = await axios.post(
      `${PESAPAL_BASE}/api/Auth/RequestToken`,
      {
        consumer_key: process.env.PESAPAL_CONSUMER_KEY,
        consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
      },
      { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );
    if (!response.data.token) {
      throw new Error('Pesapal did not return a token. Check PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET.');
    }
    console.log('✅ Pesapal token obtained');
    return response.data.token;
  } catch (err) {
    console.error('❌ Pesapal token error:', err.response?.data || err.message);
    throw err;
  }
}

async function getOrRegisterIPN(token) {
  if (process.env.PESAPAL_IPN_ID) {
    console.log('✅ Using existing IPN ID:', process.env.PESAPAL_IPN_ID);
    return process.env.PESAPAL_IPN_ID;
  }
  try {
    const response = await axios.post(
      `${PESAPAL_BASE}/api/URLSetup/RegisterIPN`,
      { url: `${BACKEND_URL}/api/payments/webhook`, ipn_notification_type: 'POST' },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );
    console.log('✅ IPN registered:', response.data.ipn_id);
    return response.data.ipn_id;
  } catch (err) {
    console.error('❌ IPN registration error:', err.response?.data || err.message);
    throw err;
  }
}

// POST /api/payments/initiate
exports.initiatePayment = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user.id;

  console.log(`📦 Payment initiation: plan=${plan}, userId=${userId}`);

  // Validate plan explicitly
  if (!plan || !PLANS[plan]) {
    console.error(`❌ Invalid plan received: "${plan}"`);
    return res.status(400).json({ message: `Invalid plan "${plan}". Must be "monthly" or "yearly".` });
  }

  const { amount, label } = PLANS[plan];
  console.log(`💰 Plan: ${plan}, Amount: ${amount}, Label: ${label}`);

  try {
    const [rows] = await db.query('SELECT id, name, email FROM users WHERE id = ?', [userId]);
    if (!rows.length) return res.status(404).json({ message: 'User not found.' });
    const user = rows[0];

    const txRef = `ANISTRIM-${userId}-${Date.now()}`;

    await db.query(
      `INSERT INTO payments (user_id, flw_tx_ref, amount, currency, status, plan) VALUES (?, ?, ?, 'UGX', 'pending', ?)`,
      [userId, txRef, amount, plan]
    );
    console.log(`✅ Payment record created: txRef=${txRef}`);

    const token = await getPesapalToken();
    const ipnId = await getOrRegisterIPN(token);
    const callbackUrl = `${BACKEND_URL}/api/payments/callback?tx_ref=${txRef}`;

    console.log(`📤 Submitting to Pesapal: amount=${amount}, plan=${plan}, txRef=${txRef}`);

    const orderResponse = await axios.post(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      {
        id: txRef,
        currency: 'UGX',
        amount: amount,
        description: label,
        callback_url: callbackUrl,
        notification_id: ipnId,
        billing_address: {
          email_address: user.email,
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ')[1] || '',
        }
      },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );

    if (!orderResponse.data.redirect_url) {
      console.error('❌ Pesapal no redirect_url:', JSON.stringify(orderResponse.data));
      return res.status(502).json({ message: 'Payment provider error. Try again.' });
    }

    console.log(`✅ Pesapal redirect URL obtained for ${plan}`);
    res.json({
      message: 'Payment link created.',
      payment_link: orderResponse.data.redirect_url,
      tx_ref: txRef,
      order_tracking_id: orderResponse.data.order_tracking_id,
    });

  } catch (err) {
    console.error('❌ Payment initiation error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Could not initiate payment. Please try again.' });
  }
};

// GET /api/payments/callback
exports.paymentCallback = async (req, res) => {
  const { tx_ref, OrderTrackingId } = req.query;
  const txRef = tx_ref || req.query.OrderMerchantReference;
  if (!txRef) return res.send(buildBridgePage('error', null, 'Missing transaction reference.'));

  try {
    const [rows] = await db.query(`SELECT p.status, p.plan, p.amount FROM payments WHERE flw_tx_ref = ?`, [txRef]);
    const status = rows[0]?.status || 'pending';
    if (OrderTrackingId && rows.length) {
      await db.query(`UPDATE payments SET flw_tx_id = ? WHERE flw_tx_ref = ?`, [OrderTrackingId, txRef]);
    }
    return res.send(buildBridgePage(status, txRef, null));
  } catch (err) {
    console.error('Payment callback error:', err.message);
    return res.send(buildBridgePage('error', txRef, 'Verification error.'));
  }
};

// POST /api/payments/webhook
exports.webhook = async (req, res) => {
  const { orderTrackingId, orderMerchantReference } = req.body;
  if (!orderTrackingId || !orderMerchantReference) return res.status(400).json({ message: 'Invalid webhook data.' });

  try {
    const token = await getPesapalToken();
    const verify = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
    );

    const txRef = orderMerchantReference;
    const [payments] = await db.query(`SELECT * FROM payments WHERE flw_tx_ref = ? AND status = 'pending'`, [txRef]);
    if (!payments.length) return res.status(200).json({ received: true });

    const payment = payments[0];

    if (verify.data.payment_status_description !== 'Completed') {
      await db.query(`UPDATE payments SET status = 'failed', flw_tx_id = ? WHERE flw_tx_ref = ?`, [orderTrackingId, txRef]);
      return res.status(200).json({ received: true });
    }

    const expiresAt = new Date();
    payment.plan === 'yearly' ? expiresAt.setFullYear(expiresAt.getFullYear() + 1) : expiresAt.setMonth(expiresAt.getMonth() + 1);

    await db.query(`UPDATE payments SET status = 'successful', flw_tx_id = ?, paid_at = NOW() WHERE flw_tx_ref = ?`, [orderTrackingId, txRef]);
    await db.query(`UPDATE users SET is_premium = 1, premium_expires_at = ? WHERE id = ?`, [expiresAt, payment.user_id]);
    console.log(`✅ Premium granted to user ${payment.user_id} until ${expiresAt}`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ message: 'Webhook processing error.' });
  }
};

// GET /api/payments/verify
exports.verifyPayment = async (req, res) => {
  const { tx_ref } = req.query;
  if (!tx_ref) return res.status(400).json({ message: 'tx_ref required.' });
  try {
    const [rows] = await db.query(
      `SELECT p.status, p.plan, p.amount, u.is_premium, u.name FROM payments p JOIN users u ON p.user_id = u.id WHERE p.flw_tx_ref = ?`,
      [tx_ref]
    );
    if (!rows.length) return res.status(404).json({ message: 'Transaction not found.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: 'Verification error.' }); }
};

// GET /api/payments/revenue
exports.getRevenueStats = async (req, res) => {
  try {
    const [stats] = await db.query(`
      SELECT COUNT(*) AS total_transactions,
        SUM(CASE WHEN status='successful' THEN amount ELSE 0 END) AS total_revenue,
        SUM(CASE WHEN status='successful' AND plan='monthly' THEN 1 ELSE 0 END) AS monthly_subs,
        SUM(CASE WHEN status='successful' AND plan='yearly'  THEN 1 ELSE 0 END) AS yearly_subs,
        SUM(CASE WHEN status='successful' AND DATE(paid_at)=CURDATE() THEN amount ELSE 0 END) AS revenue_today
      FROM payments`);
    const [recent] = await db.query(`
      SELECT p.id, u.name, u.email, p.amount, p.currency, p.status, p.plan, p.paid_at
      FROM payments p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 20`);
    res.json({ stats: stats[0], recent });
  } catch (err) { res.status(500).json({ message: 'Could not fetch revenue stats.' }); }
};

function buildBridgePage(status, txRef, errorMsg) {
  const appLink = `anistrim://payment-result?tx_ref=${txRef || ''}&status=${status}`;
  if (status === 'successful') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${appLink}"><title>Payment Successful</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #22c55e;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#22c55e;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">🎉</div><h2>Payment Successful!</h2><p>Welcome to AniStrim Premium! Tap below to start watching.</p><a href="${appLink}" id="btn">🎬 Open AniStrim</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
  }
  if (status === 'pending') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${appLink}"><title>Payment Pending</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #f97316;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#f97316;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">⏳</div><h2>Payment Processing</h2><p>Your payment is being confirmed.</p><a href="${appLink}" id="btn">← Back to AniStrim</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
  }
  const upgradeLink = 'anistrim://upgrade';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Failed</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif}.box{background:#1a1a2e;border:1px solid #ef4444;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%}h2{color:#ef4444;margin-bottom:10px}p{color:#aaa;font-size:.85rem;margin-bottom:24px;line-height:1.6}a{display:block;background:#6c2bd9;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600;margin-bottom:8px}</style></head><body><div class="box"><div style="font-size:3rem;margin-bottom:16px">❌</div><h2>Payment Failed</h2><p>${errorMsg || 'Your payment was not completed. You have not been charged.'}</p><a href="${upgradeLink}" id="btn">Try Again</a></div><script>setTimeout(function(){document.getElementById('btn').click()},150);</script></body></html>`;
}
