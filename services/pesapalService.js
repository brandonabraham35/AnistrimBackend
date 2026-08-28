// ============================================================
//  services/pesapalService.js — Pesapal API 3.0 Integration
//  Handles OAuth2 authentication, IPN registration,
//  order submission, and transaction status verification.
// ============================================================
const axios = require('axios');
require('dotenv').config();

// ── Environment-aware base URL ──────────────────────────────
// Set PESAPAL_ENV=sandbox to use test endpoints (cybqa)
// Defaults to live (production) if not set.
const PESAPAL_BASE = process.env.PESAPAL_ENV === 'sandbox'
  ? 'https://cybqa.pesapal.com/pesapalv3'
  : 'https://pay.pesapal.com/v3';

// Environment configuration survives restarts. These process-local values
// prevent repeated registration before configuration is persisted and collapse
// simultaneous checkouts into one registration request.
let cachedIpnId = null;
let ipnRegistrationPromise = null;

function configuredIpnId() {
  return String(process.env.PESAPAL_IPN_ID || '').trim() || null;
}

function isIpnConflict(error) {
  const body = error?.response?.data;
  const detail = typeof body === 'string'
    ? body
    : JSON.stringify(body || error?.message || '');
  return error?.response?.status === 409 || /conflict|already\s+(exists|registered)|duplicate/i.test(detail);
}

// ── OAuth 2.0: Get Bearer Token ─────────────────────────────
// POST /api/Auth/RequestToken
async function getToken() {
  try {
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY;
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      throw new Error('PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET must be set in .env');
    }

    const response = await axios.post(
      `${PESAPAL_BASE}/api/Auth/RequestToken`,
      {
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.data || !response.data.token) {
      console.error('❌ Pesapal token response invalid: no token field present');
      throw new Error('Pesapal did not return a token. Check your API credentials.');
    }

    console.log('✅ Pesapal OAuth token obtained successfully');
    return response.data.token;
  } catch (err) {
    console.error(
      '❌ Pesapal getToken error:',
      err.response?.data || err.message
    );
    throw err;
  }
}

// ── Register IPN (Instant Payment Notification) URL ─────────
// POST /api/URLSetup/RegisterIPN
// Registers your server's webhook endpoint with Pesapal so it
// can send payment notifications.
async function registerIPN(token, ipnUrl) {
  const configured = configuredIpnId();
  if (configured) {
    console.log('Using existing Pesapal IPN ID from environment');
    return configured;
  }
  if (cachedIpnId) {
    console.log('Using process-cached Pesapal IPN ID');
    return cachedIpnId;
  }
  if (ipnRegistrationPromise) {
    console.log('Waiting for in-flight Pesapal IPN registration');
    return ipnRegistrationPromise;
  }
  if (!ipnUrl) {
    throw new Error('IPN URL is required to register with Pesapal');
  }

  ipnRegistrationPromise = registerNewIPN(token, ipnUrl)
    .then(ipnId => {
      cachedIpnId = ipnId;
      console.log('Pesapal IPN registered and cached for this process');
      return ipnId;
    })
    .catch(error => {
      // A conflict is safe only if a configured or cached ID is available.
      // Never guess an ID: surface the required configuration instead.
      const knownId = configuredIpnId() || cachedIpnId;
      if (knownId) return knownId;
      if (isIpnConflict(error)) {
        const conflictError = new Error(
          'Pesapal reports this IPN URL is already registered. Configure PESAPAL_IPN_ID with the existing IPN ID.'
        );
        conflictError.code = 'PESAPAL_IPN_CONFLICT';
        throw conflictError;
      }
      throw error;
    })
    .finally(() => {
      ipnRegistrationPromise = null;
    });

  return ipnRegistrationPromise;
}

async function registerNewIPN(token, ipnUrl) {
  // If we already have an IPN ID saved, reuse it
  if (process.env.PESAPAL_IPN_ID) {
    console.log('✅ Using existing IPN ID from env:', process.env.PESAPAL_IPN_ID);
    return process.env.PESAPAL_IPN_ID;
  }

  try {
    if (!ipnUrl) {
      throw new Error('IPN URL is required to register with Pesapal');
    }

    const response = await axios.post(
      `${PESAPAL_BASE}/api/URLSetup/RegisterIPN`,
      {
        url: ipnUrl,
        ipn_notification_type: 'POST',
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.data || !response.data.ipn_id) {
      throw new Error('Pesapal did not return an IPN ID.');
    }

    console.log('✅ IPN registered successfully, ID:', response.data.ipn_id);

    // Optionally cache it for future use (the env var can be set after first registration)
    return response.data.ipn_id;
  } catch (err) {
    console.error(
      '❌ Pesapal registerIPN error:',
      err.response?.data || err.message
    );
    throw err;
  }
}

// ── Submit Order (Initiate Payment) ─────────────────────────
// POST /api/Transactions/SubmitOrderRequest
// Returns the redirect_url where the user completes payment
// and the order_tracking_id for status verification.
async function submitOrder(token, orderData) {
  try {
    const requiredFields = ['id', 'currency', 'amount', 'description', 'callback_url', 'notification_id'];
    for (const field of requiredFields) {
      if (!orderData[field]) {
        throw new Error(`Missing required order field: ${field}`);
      }
    }

    const payload = {
      id: orderData.id,                     // Merchant reference (unique)
      currency: orderData.currency,         // e.g. 'UGX'
      amount: orderData.amount,             // e.g. 15000
      description: orderData.description,   // e.g. 'AniStrim Premium Monthly'
      callback_url: orderData.callback_url, // Where user is redirected after payment
      notification_id: orderData.notification_id, // IPN ID from registerIPN()
      billing_address: {
        email_address: orderData.email || '',
        first_name: orderData.firstName || '',
        last_name: orderData.lastName || '',
        ...(orderData.billing_address || {}),
      },
    };

    const response = await axios.post(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.data || !response.data.redirect_url) {
      console.error('❌ Pesapal submitOrder invalid response: no redirect_url field');
      throw new Error('Pesapal did not return a redirect URL');
    }

    console.log('✅ Pesapal order submitted, tracking ID:', response.data.order_tracking_id);

    return {
      redirect_url: response.data.redirect_url,
      order_tracking_id: response.data.order_tracking_id,
      merchant_reference: orderData.id,
    };
  } catch (err) {
    console.error(
      '❌ Pesapal submitOrder error:',
      err.response?.data || err.message
    );
    throw err;
  }
}

// ── Get Transaction Status ──────────────────────────────────
// GET /api/Transactions/GetTransactionStatus?orderTrackingId={id}
// Returns the current status of a transaction.
async function getTransactionStatus(token, orderTrackingId) {
  try {
    if (!orderTrackingId) {
      throw new Error('orderTrackingId is required');
    }

    const response = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus`,
      {
        params: { orderTrackingId },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.data) {
      throw new Error('Pesapal returned empty transaction status');
    }

    console.log(
      '✅ Pesapal transaction status:',
      response.data.payment_status_description,
      '(code:', response.data.status_code || 'N/A', ')'
    );

    return {
      status: response.data.payment_status_description, // 'COMPLETED', 'FAILED', 'PENDING', etc.
      status_code: response.data.status_code,
      amount: response.data.amount,
      currency: response.data.currency,
      payment_method: response.data.payment_method,
      paid_at: response.data.payment_date,
      order_tracking_id: orderTrackingId,
      merchant_reference: response.data.merchant_reference,
      raw: response.data,
    };
  } catch (err) {
    console.error(
      '❌ Pesapal getTransactionStatus error:',
      err.response?.data || err.message
    );
    throw err;
  }
}

// ── Determine if status means payment completed ────────────
function isPaymentCompleted(statusDescription) {
  if (!statusDescription) return false;
  const completed = statusDescription.toUpperCase();
  return completed === 'COMPLETED' || completed === 'SUCCESS';
}

module.exports = {
  getToken,
  registerIPN,
  submitOrder,
  getTransactionStatus,
  isPaymentCompleted,
};

