// utils/mailer.js — Postmark email dispatcher for AniStrim.
//
// Uses Postmark's HTTPS API (not SMTP, not Gmail SMTP). The Render backend makes
// a normal HTTPS POST to Postmark, so it works without SMTP port connectivity.
//
// Configuration (server-side only, never shipped to the frontend):
//   POSTMARK_SERVER_TOKEN    — the Postmark server API token
//   POSTMARK_FROM_EMAIL      — e.g. admin@anistrim.com
//   POSTMARK_FROM_NAME       — display name, e.g. AniStrim
//   POSTMARK_MESSAGE_STREAM  — optional message stream (default "outbound")
//   POSTMARK_TIMEOUT_MS      — optional request timeout (default 12000, clamped 10–15 s)
//
// Behavior:
//   • Production: Postmark must be configured. If it is missing, sendEmail throws
//     so OTP delivery can never be a silent failure. OTP codes and API keys are
//     NEVER logged.
//   • Development: if Postmark is not configured, fall back to logging the OTP
//     code to the console and "succeed" so the signup/verify flow still works
//     locally without a mail server.
const db = require('../config/db');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_TEST_MODE = process.env.POSTMARK_TEST_MODE === 'true';

// Postmark's official test-mode API token. When used as the server token,
// Postmark accepts all API requests and returns success responses but NEVER
// actually sends the email. Nothing counts against delivery stats or bounce
// rates. See: https://postmarkapp.com/developer/api/overview#test-mode
const POSTMARK_TEST_TOKEN = 'POSTMARK_API_TEST';

// ── Placeholder detection ────────────────────────────────────────
// Any value containing these markers (case-insensitive) is treated as a
// placeholder and therefore "not configured". This catches template values
// like your-postmark-server-token, REPLACE_WITH_..., CHANGE_ME / changeme,
// xxxx, example, etc. `change[_\s-]?me` matches both "changeme" and "CHANGE_ME".
const PLACEHOLDER_RE = /(your|xxxx|change[_\s-]?me|replace|example)/i;

function isRealValue(v) {
  return typeof v === 'string' && v.trim() !== '' && !PLACEHOLDER_RE.test(v.trim());
}

// The mailer no longer depends on SMTP. Provide smtpConfigured() as a
// thin, always-false helper so any legacy callers that still reference it
// (e.g. older health probes) don't crash — but the production email path uses
// Postmark exclusively.
function smtpConfigured() {
  // Legacy SMTP is fully removed. Postmark configuration is the source of truth.
  return false;
}

function postmarkConfigured() {
  // In test mode, Postmark's test API token (POSTMARK_API_TEST) is used.
  // It accepts requests but never sends emails — perfect for CI/test suites.
  if (IS_TEST_MODE) return true;
  return Boolean(
    isRealValue(process.env.POSTMARK_SERVER_TOKEN) &&
    isRealValue(process.env.POSTMARK_FROM_EMAIL)
  );
}

function getFrom() {
  const name = process.env.POSTMARK_FROM_NAME || 'AniStrim';
  const email = process.env.POSTMARK_FROM_EMAIL || 'admin@anistrim.com';
  return `${name} <${email}>`;
}

// Request timeout for the Postmark HTTP call. Clamped to the 10–15 s window so
// a hung Postmark request can never stall an OTP signup indefinitely.
function getTimeoutMs() {
  const raw = Number(process.env.POSTMARK_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(15000, Math.max(10000, raw));
  }
  return 12000;
}

// ── Startup configuration warnings ───────────────────────────────
// Logs (never throws, never crashes) warnings about missing/placeholder
// Postmark env vars. Never logs the actual token value.
function runStartupConfigWarnings() {
  // In test mode, Postmark test token is used — no warnings needed.
  if (IS_TEST_MODE) return;
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const fromEmail = process.env.POSTMARK_FROM_EMAIL;

  // Missing or placeholder required vars — list variable NAMES only.
  const required = {
    POSTMARK_SERVER_TOKEN: token,
    POSTMARK_FROM_EMAIL: fromEmail,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !isRealValue(v))
    .map(([name]) => name);
  if (missing.length) {
    console.warn(`[MAILER] ⚠️ Missing or placeholder Postmark env var(s): ${missing.join(', ')}. ` +
      'Email delivery will fall back to dev console logging (non-production) or fail (production).');
  }
}

/**
 * Legacy connector kept for compatibility. The production path never uses SMTP,
 * so this throws a clear error explaining the migration if any legacy code
 * tries to obtain an SMTP transporter.
 */
function getTransporter() {
  const err = new Error('SMTP has been removed. Use Postmark HTTP API instead.');
  throw err;
}

/**
 * Startup readiness check based on Postmark configuration.
 *
 * • Always runs the config sanity warnings (log-only, never crashes).
 * • exitOnFailure === true  → throws when unconfigured (loud console error).
 * • exitOnFailure === false → resolves FALSE when unconfigured (loud console
 *   error is still printed) so callers like server.js can continue booting
 *   without a try/catch. Never calls process.exit().
 */
async function verifyTransport(exitOnFailure = true) {
  runStartupConfigWarnings();

  if (postmarkConfigured()) {
    console.log('✅ Postmark API configured. Emails will deliver via HTTPS.');
    return true;
  }

  const msg = 'POSTMARK_SERVER_TOKEN / POSTMARK_FROM_EMAIL are not configured.';
  if (!IS_PRODUCTION) {
    console.warn('[MAILER] ' + msg + ' Falling back to dev console delivery.');
  } else {
    console.error('============================================================');
    console.error('❌ EMAIL DELIVERY IS BROKEN IN PRODUCTION:');
    console.error('  ' + msg);
    console.error('  Set the POSTMARK_* env vars (see Render environment).');
    console.error('============================================================');
  }

  if (exitOnFailure) {
    console.error('❌ [MAILER] Email is not configured (non-fatal at startup).');
    throw new Error(msg);
  }
  // exitOnFailure === false → resolve false instead of throwing.
  return false;
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
 * Send an HTML email via Postmark HTTP API.
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} html - HTML body
 * @param {string} [otpCode] - the OTP code, used ONLY for the dev console fallback
 * @returns {Promise<{messageId?: string}>} - resolves with the Postmark MessageID
 *                                            when Postmark accepts the message.
 */
async function sendEmail(to, subject, html, otpCode) {
  if (!postmarkConfigured()) {
    if (IS_PRODUCTION) {
      // Fail loudly — never silently swallow mail delivery in production, and
      // never print the OTP code.
      console.error(`EMAIL NOT SENT (Postmark unconfigured) to: ${to}`);
      recordEmailEvent(to, subject, 'failure', 'Postmark is not configured (production)');
      throw new Error('Postmark is not configured and we are in production. Email not sent.');
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

  // Build a plain-text part from the optional OTP code, else strip the HTML.
  let text = '';
  if (otpCode) {
    text = `Your AniStrim verification code is: ${otpCode}. This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.`;
  } else {
    text = stripHtml(html) || 'AniStrim';
  }

  const from = getFrom();
  const messageStream = process.env.POSTMARK_MESSAGE_STREAM || 'outbound';

  const postmarkToken = IS_TEST_MODE ? POSTMARK_TEST_TOKEN : process.env.POSTMARK_SERVER_TOKEN;

  console.log(`[Postmark] Email send started -> ${to} (${subject})${IS_TEST_MODE ? ' [TEST MODE]' : ''}`);

  // AbortController-based hard timeout so a hung Postmark request can never
  // stall the signup/OTP flow. On abort we record a failure event with the
  // elapsed time and rethrow.
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use the Postmark HTTP API directly with fetch() and AbortController
    // for reliable timeout support. The official SDK does not expose a
    // suitable per-request timeout mechanism.
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': postmarkToken,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text,
        MessageStream: messageStream,
      }),
      signal: controller.signal,
    });

    const responseData = await response.json();
    if (!response.ok) {
      const errMsg = responseData && responseData.Message ? responseData.Message : `HTTP ${response.status}`;
      console.error(`[Postmark] Email send failed: ${errMsg}`);

      recordEmailEvent(to, subject, 'failure', `Postmark HTTP ${response.status}: ${errMsg}`);
      const error = new Error(`Postmark send failed (${response.status})`);
      error.status = response.status;
      throw error;
    }

    const messageId = (responseData && responseData.MessageID) || null;
    if (messageId) {
      console.log(`[Postmark] Email accepted. Message ID: ${messageId}`);
    } else {
      console.log('[Postmark] Email accepted.');
    }
    recordEmailEvent(to, subject, 'success', null);
    return { messageId };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      // The AbortController fired (timeout) — record + rethrow with timing.
      const elapsed = Date.now() - startedAt;
      console.error(`[Postmark] Email send timed out after ${elapsed}ms (limit ${timeoutMs}ms) -> ${to}`);
      recordEmailEvent(to, subject, 'failure', `Timeout after ${elapsed}ms`);
      const timeoutError = new Error(`Postmark request timed out after ${elapsed}ms`);
      timeoutError.code = 'POSTMARK_TIMEOUT';
      throw timeoutError;
    }
    // If fetch itself failed (network), record + rethrow. Postmark HTTP errors
    // were already recorded and logged above (they carry error.status).
    if (!(error && error.status)) {
      console.error(`[Postmark] Email send failed (network/transport): ${error && error.message}`);
      recordEmailEvent(to, subject, 'failure', `Network/transport: ${error && error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an HTML email notifying support that a new ticket was created.
 */
function buildSupportNotificationEmail(ticket) {
  var rows = '';
  function row(label, value) {
    return '<tr><td style="padding:4px 0;font-size:14px;color:#a7a3bf">' + label + '</td><td style="padding:4px 0 4px 16px;font-size:14px;color:#ebe8f0">' + value + '</td></tr>';
  }
  rows += row('Ticket', escHtml(ticket.ticket_number));
  rows += row('Name', escHtml(ticket.user_name));
  rows += row('Email', escHtml(ticket.user_email));
  rows += row('Category', escHtml(ticket.category_label));
  rows += row('Subject', escHtml(ticket.subject));
  rows += row('Message', '<pre style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:14px;color:#ebe8f0">' + escHtml(ticket.message) + '</pre>');
  if (ticket.anime_title) rows += row('Anime', escHtml(ticket.anime_title));
  if (ticket.episode_title) rows += row('Episode', escHtml(ticket.episode_title));
  rows += row('Submitted', escHtml(ticket.submitted_at));

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#08080e;font-family:Inter,system-ui,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#08080e"><tr><td align="center" style="padding:24px">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#13131e;border-radius:12px;border:1px solid #1e1e32">' +
    '<tr><td style="padding:24px 24px 0"><h1 style="margin:0;font-size:20px;font-weight:700;color:#8b5cf6">New AniStrim Support Request</h1></td></tr>' +
    '<tr><td style="padding:16px 24px 24px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows +
    '</table></td></tr>' +
    '</table></td></tr></table></body></html>';
}

/**
 * Build an HTML confirmation email to the user after ticket creation.
 */
function buildSupportConfirmationEmail(ticket) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#08080e;font-family:Inter,system-ui,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#08080e"><tr><td align="center" style="padding:24px">' +
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#13131e;border-radius:12px;border:1px solid #1e1e32">' +
    '<tr><td style="padding:24px 24px 0"><h1 style="margin:0;font-size:20px;font-weight:700;color:#8b5cf6">AniStrim Support Request</h1></td></tr>' +
    '<tr><td style="padding:16px 24px 24px">' +
    '<p style="margin:0 0 12px;font-size:14px;color:#ebe8f0">Hello ' + escHtml(ticket.user_name) + ',</p>' +
    '<p style="margin:0 0 12px;font-size:14px;color:#ebe8f0">We&#39;ve received your support request and our team will review it shortly.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;border-radius:8px;padding:16px">' +
    '<tr><td style="padding:12px">' +
    '<p style="margin:0 0 8px;font-size:14px;color:#a7a3bf">Ticket: <strong style="color:#8b5cf6">' + escHtml(ticket.ticket_number) + '</strong></p>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#a7a3bf">Category: ' + escHtml(ticket.category_label) + '</p>' +
    '<p style="margin:0;font-size:14px;color:#a7a3bf">Subject: ' + escHtml(ticket.subject) + '</p>' +
    '</td></tr></table>' +
    '<p style="margin:16px 0 0;font-size:14px;color:#a7a3bf">Thank you,<br>AniStrim Support</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { sendEmail, getTransporter, smtpConfigured, postmarkConfigured, verifyTransport, buildSupportNotificationEmail, buildSupportConfirmationEmail };