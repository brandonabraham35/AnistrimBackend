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
//   MAILGUN_TIMEOUT_MS     — optional request timeout (default 12000, clamped 10–15 s)
//
// Behavior:
//   • Production: Mailgun must be configured. If it is missing, sendEmail throws
//     so OTP delivery can never be a silent failure. OTP codes and API keys are
//     NEVER logged.
//   • Development: if Mailgun is not configured, fall back to logging the OTP
//     code to the console and "succeed" so the signup/verify flow still works
//     locally without a mail server.
const db = require('../config/db');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Placeholder detection ────────────────────────────────────────
// Any value containing these markers (case-insensitive) is treated as a
// placeholder and therefore "not configured". This catches template values
// like key-your-mailgun-sending-key, REPLACE_WITH_..., CHANGE_ME / changeme,
// xxxx, example, etc. `change[_\s-]?me` matches both "changeme" and "CHANGE_ME".
const PLACEHOLDER_RE = /(your|xxxx|change[_\s-]?me|replace|example)/i;

function isRealValue(v) {
  return typeof v === 'string' && v.trim() !== '' && !PLACEHOLDER_RE.test(v.trim());
}

// The mailer no longer depends on SMTP. provide smtpConfigured() as a
// thin, always-false helper so any legacy callers that still reference it
// (e.g. older health probes) don't crash — but the production email path uses
// Mailgun exclusively.
function smtpConfigured() {
  // Legacy SMTP is fully removed. Mailgun configuration is the source of truth.
  return false;
}

function mailgunConfigured() {
  return Boolean(
    isRealValue(process.env.MAILGUN_API_KEY) &&
    isRealValue(process.env.MAILGUN_DOMAIN) &&
    isRealValue(process.env.MAILGUN_API_BASE_URL) &&
    isRealValue(process.env.MAILGUN_FROM_EMAIL)
  );
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

// Request timeout for the Mailgun HTTP call. Clamped to the 10–15 s window so
// a hung Mailgun request can never stall an OTP signup indefinitely.
function getTimeoutMs() {
  const raw = Number(process.env.MAILGUN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(15000, Math.max(10000, raw));
  }
  return 12000;
}

// ── Region heuristics (startup warnings only) ────────────────────
// Best-effort guess of the region a Mailgun API key belongs to. New-style
// Mailgun sending keys are JWT-like; if the payload decodes and mentions a
// region we use that. Otherwise we look for explicit eu/us markers. Returns
// null when there is no usable signal (most common — no warning is emitted).
function guessKeyRegion(key) {
  const k = String(key || '').trim();
  if (!k) return null;

  // JWT-style key: try to decode the payload and look for a region claim.
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payloadStr = Buffer.from(b64, 'base64').toString('utf8').toLowerCase();
      if (/(^|[^a-z])eu([^a-z]|$)|\.eu\.|eu[_-]?region|region[_-]?eu/.test(payloadStr)) return 'EU';
      if (/(^|[^a-z])us([^a-z]|$)|\.us\.|us[_-]?region|region[_-]?us/.test(payloadStr)) return 'US';
    } catch (e) { /* not a decodable JWT — fall through to marker check */ }
  }

  const lower = k.toLowerCase();
  if (/(^|[._-])eu([._-]|$)/.test(lower)) return 'EU';
  if (/(^|[._-])us([._-]|$)/.test(lower)) return 'US';
  return null;
}

function getBaseUrlRegion(base) {
  const b = String(base || '').toLowerCase();
  if (/api\.eu\.mailgun\.net/.test(b)) return 'EU';
  if (/api\.mailgun\.net/.test(b)) return 'US';
  return null;
}

// ── Startup configuration warnings ───────────────────────────────
// Logs (never throws, never crashes) three explicit sanity warnings:
//   (a) MAILGUN_FROM_EMAIL domain does not end in MAILGUN_DOMAIN
//   (b) key looks US-region while base URL is EU (or vice-versa)
//   (c) any required var missing/placeholder — names only, NEVER the key value
function runStartupConfigWarnings() {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const base = process.env.MAILGUN_API_BASE_URL;
  const fromEmail = process.env.MAILGUN_FROM_EMAIL;

  // (c) Missing or placeholder required vars — list variable NAMES only.
  const required = {
    MAILGUN_API_KEY: key,
    MAILGUN_DOMAIN: domain,
    MAILGUN_API_BASE_URL: base,
    MAILGUN_FROM_EMAIL: fromEmail,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !isRealValue(v))
    .map(([name]) => name);
  if (missing.length) {
    console.warn(`[MAILER] ⚠️ Missing or placeholder Mailgun env var(s): ${missing.join(', ')}. ` +
      'Email delivery will fall back to dev console logging (non-production) or fail (production).');
  }

  // (a) FROM address must live on the sending domain.
  if (isRealValue(fromEmail) && isRealValue(domain)) {
    const fromDomain = String(fromEmail).split('@')[1]?.toLowerCase() || '';
    const mgDomain = String(domain).trim().toLowerCase();
    const onDomain = fromDomain === mgDomain || fromDomain.endsWith('.' + mgDomain);
    if (fromDomain && !onDomain) {
      console.warn(`[MAILER] ⚠️ MAILGUN_FROM_EMAIL domain "${fromDomain}" does not end in MAILGUN_DOMAIN "${mgDomain}". ` +
        'Mailgun will reject sends unless the FROM address is on the verified sending domain.');
    }
  }

  // (b) Region mismatch between the key (best-effort guess) and the base URL.
  if (isRealValue(key) && isRealValue(base)) {
    const keyRegion = guessKeyRegion(key);
    const baseRegion = getBaseUrlRegion(base);
    if (keyRegion && baseRegion && keyRegion !== baseRegion) {
      console.warn(`[MAILER] ⚠️ MAILGUN_API_KEY looks ${keyRegion}-region but MAILGUN_API_BASE_URL points to the ${baseRegion} endpoint (${base}). ` +
        `Expected base URL: ${keyRegion === 'EU' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'}. ` +
        'A region mismatch causes 401/403 auth failures.');
    }
  }
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
 * Startup readiness check based on Mailgun configuration.
 *
 * • Always runs the three config sanity warnings (log-only, never crashes).
 * • exitOnFailure === true  → throws when unconfigured (loud console error).
 * • exitOnFailure === false → resolves FALSE when unconfigured (loud console
 *   error is still printed) so callers like server.js can continue booting
 *   without a try/catch. Never calls process.exit().
 */
async function verifyTransport(exitOnFailure = true) {
  runStartupConfigWarnings();

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

  // AbortController-based hard timeout so a hung Mailgun request can never
  // stall the signup/OTP flow. On abort we record a failure event with the
  // elapsed time and rethrow.
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      let parsed = null;
      try { parsed = JSON.parse(responseText); } catch (e) { /* ignore */ }
      const errMsg = parsed && parsed.message ? parsed.message : `HTTP ${response.status}`;
      const detail = (parsed && parsed.error) ? ` ${String(parsed.error).slice(0, 200)}` : '';
      console.error(`[Mailgun] Email send failed: ${errMsg}${detail}`);

      // 401/403 → remediation hint. NEVER log the API key or the OTP.
      if (response.status === 401 || response.status === 403) {
        console.error(
          '[Mailgun] Authorization failure (HTTP ' + response.status + '). Remediation checklist: ' +
          '(1) MAILGUN_API_BASE_URL must match the domain region — EU domains use https://api.eu.mailgun.net, US domains use https://api.mailgun.net; ' +
          '(2) MAILGUN_API_KEY must be a Domain Sending key for MAILGUN_DOMAIN (not a key from another domain/account, and not the private account key); ' +
          '(3) MAILGUN_FROM_EMAIL must be an address on the MAILGUN_DOMAIN sending domain. ' +
          'The key value is intentionally NOT logged.'
        );
      }

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
    if (error && error.name === 'AbortError') {
      // The AbortController fired (timeout) — record + rethrow with timing.
      const elapsed = Date.now() - startedAt;
      console.error(`[Mailgun] Email send timed out after ${elapsed}ms (limit ${timeoutMs}ms) -> ${to}`);
      recordEmailEvent(to, subject, 'failure', `Timeout after ${elapsed}ms`);
      const timeoutError = new Error(`Mailgun request timed out after ${elapsed}ms`);
      timeoutError.code = 'MAILGUN_TIMEOUT';
      throw timeoutError;
    }
    // If fetch itself failed (network), record + rethrow. Mailgun HTTP errors
    // were already recorded and logged above (they carry error.status).
    if (!(error && error.status)) {
      console.error(`[Mailgun] Email send failed (network/transport): ${error && error.message}`);
      recordEmailEvent(to, subject, 'failure', `Network/transport: ${error && error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendEmail, getTransporter, smtpConfigured, mailgunConfigured, verifyTransport };