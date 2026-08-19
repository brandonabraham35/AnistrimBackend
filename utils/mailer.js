// utils/mailer.js — Mailgun HTTP API email dispatcher for AniStrim.
//
// Uses Mailgun's HTTPS API (not SMTP, not Gmail SMTP). The Render backend makes
// a normal HTTPS POST to Mailgun, so it works without SMTP port connectivity.
//
// Configuration (server-side only, never shipped to the frontend):
//   MAILGUN_API_KEY        — the Mailgun sending/domain API key
//   MAILGUN_DOMAIN         — e.g. mg.anistrim.com
//   MAILGUN_API_BASE_URL   — https://api.eu.mailgun.net (EU) or https://api.mailgun.net (US)
//   MAILGUN_FROM_EMAIL     — e.g. verification@mg.anistrim.com
//   MAILGUN_FROM_NAME      — display name, e.g. AniStrim
//
// Behavior:
//   • Production: Mailgun must be configured. If it is missing, sendEmail throws
//     so OTP delivery can never be a silent failure. OTP codes are NEVER logged.
//   • Development: if Mailgun is not configured, fall back to logging the OTP
//     code to the console and "succeed" so the signup/verify flow still works
//     locally without a mail server.
const db = require('../config/db');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// The mailer no longer depends on SMTP. provide smtpConfigured() as a
// thin, always-false helper so any legacy callers that still reference it
// (e.g. older health probes) don't crash — but the production email path uses
// Mailgun exclusively.
function smtpConfigured() {
  // Legacy SMTP is fully removed. Mailgun configuration is the source of truth.
  return false;
}

function mailgunConfigured() {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const base = process.env.MAILGUN_API_BASE_URL;
  const fromEmail = process.env.MAILGUN_FROM_EMAIL;
  // Placeholder / empty values are treated as unconfigured.
  const clean = (v) => typeof v === 'string' && v.trim() !== '' &&
    !/^(your_|REPLACE_|change_|key-XXXX)/i.test(v.trim());
  return Boolean(clean(key) && clean(domain) && clean(base) && clean(fromEmail));
}

function getBaseUrl() {
  return (process.env.MAILGUN_API_BASE_URL || 'https://api.eu.mailgun.net').replace(/\/+$/, '');
}

function getDomain() {
  return process.env.MAILGUN_DOMAIN || 'mg.anistrim.com';
}

function getFrom() {
  const name = process.env.MAILGUN_FROM_NAME || 'AniStrim';
  const email = process.env.MAILGUN_FROM_EMAIL || 'verification@mg.anistrim.com';
  return `${name} <${email}>`;
}

/**
 * Legacy connector kept for compatibility. The production path never uses SMTP,
 * so this throws a clear error explaining the migration if any legacy code
 * tries to obtain an SMTP transporter.
 */
function getTransporter() {
  const err = new Error('SMTP has been removed. Use Mailgun HTTP API instead.');
  throw err;
}

/**
 * Legacy verification kept so old callers don't crash. Now a no-op that reports
 * readiness based on Mailgun configuration, and never exits the process.
 */
async function verifyTransport(exitOnFailure = true) {
  if (mailgunConfigured()) {
    console.log('✅ Mailgun HTTP API configured. Emails will deliver via HTTPS.');
    return true;
  }
  const msg = 'MAILGUN_API_KEY / MAILGUN_DOMAIN / MAILGUN_API_BASE_URL / MAILGUN_FROM_EMAIL are not configured.';
  if (!IS_PRODUCTION) {
    console.warn('[MAILER] ' + msg + ' Falling back to dev console delivery.');
  } else {
    console.error('============================================================');
    console.error('❌ EMAIL DELIVERY IS BROKEN IN PRODUCTION:');
    console.error('  ' + msg);
    console.error('  Set the MAILGUN_* env vars (see Render environment).');
    console.error('============================================================');
  }
  // Never process.exit(1) — the server must start even if email is misconfigured.
  if (exitOnFailure) {
    console.error('❌ [MAILER] Email is not configured (non-fatal at startup).');
  }
  throw new Error(msg);
}

/**
 * Record a send outcome to email_events (best-effort — a failed event-log write
 * must never break the email call itself).
 */
function recordEmailEvent(to, subject, status, errorMessage) {
  db.query(
    'INSERT INTO email_events (to_email, subject, status, error) VALUES (?, ?, ?, ?)',
    [to ? String(to).slice(0, 191) : null, subject ? String(subject).slice(0, 255) : null, status, errorMessage ? String(errorMessage).slice(0, 500) : null]
  ).catch(err => {
    // Never surface email-event logging failures to the caller.
    if (!IS_PRODUCTION) console.warn('[Mailer] email_events write failed (non-fatal):', err && err.message);
  });
}

// Strip HTML tags to produce a reasonable plain-text fallback.
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/gi, '&')
    .replace(/</gi, '<')
    .replace(/>/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Send an HTML email via Mailgun HTTP API.
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} html - HTML body
 * @param {string} [otpCode] - the OTP code, used ONLY for the dev console fallback
 * @returns {Promise<{messageId?: string}>} - resolves with the Mailgun message id
 *                                            when Mailgun accepts the message.
 */
async function sendEmail(to, subject, html, otpCode) {
  if (!mailgunConfigured()) {
    if (IS_PRODUCTION) {
      // Fail loudly — never silently swallow mail delivery in production, and
      // never print the OTP code.
      console.error(`EMAIL NOT SENT (Mailgun unconfigured) to: ${to}`);
      recordEmailEvent(to, subject, 'failure', 'Mailgun is not configured (production)');
      throw new Error('Mailgun is not configured and we are in production. Email not sent.');
    }
    // Development fallback: print the code so local testing still works.
    if (otpCode) {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} | Code: ${otpCode}`);
    } else {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} (no code supplied)`);
    }
    // Dev console-delivery counts as success (it delivered to the dev console).
    recordEmailEvent(to, subject, 'success', null);
    return { messageId: 'dev-console' };
  }

  // Mailgun HTTP Basic Auth: username = api, password = MAILGUN_API_KEY.
  const token = `Basic ${Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64')}`;
  const endpoint = `${getBaseUrl()}/v3/${getDomain()}/messages`;

  // Build a plain-text part from the optional OTP code, else strip the HTML.
  let text = '';
  if (otpCode) {
    text = `Your AniStrim verification code is: ${otpCode}. This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.`;
  } else {
    text = stripHtml(html) || 'AniStrim';
  }

  const body = new URLSearchParams();
  body.append('from', getFrom());
  body.append('to', to);
  body.append('subject', subject);
  body.append('text', text);
  body.append('html', html);

  console.log(`[Mailgun] Email send started -> ${to} (${subject})`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const responseText = await response.text();
    if (!response.ok) {
      let parsed = null;
      try { parsed = JSON.parse(responseText); } catch (e) { /* ignore */ }
      const errMsg = parsed && parsed.message ? parsed.message : `HTTP ${response.status}`;
      const detail = (parsed && parsed.error) ? ` ${String(parsed.error).slice(0, 200)}` : '';
      console.error(`[Mailgun] Email send failed: ${errMsg}${detail}`);
      recordEmailEvent(to, subject, 'failure', `Mailgun HTTP ${response.status}: ${errMsg}`);
      const error = new Error(`Mailgun send failed (${response.status})`);
      error.status = response.status;
      throw error;
    }

    let data = null;
    try { data = JSON.parse(responseText); } catch (e) { /* ignore */ }
    const messageId = (data && data.id) || null;
    if (messageId) {
      console.log(`[Mailgun] Email accepted. Message ID: ${messageId}`);
    } else {
      console.log('[Mailgun] Email accepted.');
    }
    recordEmailEvent(to, subject, 'success', null);
    return { messageId };
  } catch (error) {
    // If fetch itself failed (network / timeout), record + rethrow.
    if (error && error.status) {
      // Already recorded + logged above.
    } else {
      console.error(`[Mailgun] Email send failed (network/transport): ${error && error.message}`);
      recordEmailEvent(to, subject, 'failure', `Network/transport: ${error && error.message}`);
    }
    throw error;
  }
}

module.exports = { sendEmail, getTransporter, smtpConfigured, mailgunConfigured, verifyTransport };