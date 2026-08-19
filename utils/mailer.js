// utils/mailer.js — SMTP email dispatcher for AniStrim.
// Uses nodemailer with the env keys: SMTP_HOST, SMTP_PORT, SMTP_SECURE,
// SMTP_USER, SMTP_PASS, and optionally MAIL_FROM / FROM_EMAIL.
//
// Behavior:
//   • Production: SMTP must be configured. If it is missing, fail LOUDLY with
//     a clear startup error and throw on send (so OTP delivery can never be a
//     silent failure). OTP codes are NEVER logged in production.
//   • Development: if SMTP is not configured, fall back to logging the OTP
//     code to the console and "succeed" so the signup/verify flow still works
//     locally without a mail server.
const nodemailer = require('nodemailer');
const db = require('../config/db');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_HOST !== 'REPLACE_WITH_GMAIL' &&
    process.env.SMTP_USER !== 'REPLACE_WITH_GMAIL' &&
    process.env.SMTP_PASS !== 'REPLACE_WITH_APP_PASSWORD'
  );
}

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (!smtpConfigured()) {
    const err = new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS.');
    if (IS_PRODUCTION) {
      console.error('============================================================');
      console.error('EMAIL DELIVERY IS BROKEN IN PRODUCTION:');
      console.error('  SMTP is not configured. Verification/reset emails will not send.');
      console.error('  Set SMTP_HOST, SMTP_USER, SMTP_PASS (and SMTP_PORT/SMTP_SECURE).');
      console.error('============================================================');
    }
    throw err;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Gmail requires TLS (STARTTLS) on port 587; nodemailer defaults to
    // opportunistic TLS which works, but explicitly require it so a
    // misconfigured server fails loudly instead of silently downgrading.
    requireTLS: process.env.SMTP_HOST === 'smtp.gmail.com' ? true : undefined,
  });
  return transporter;
}

/**
 * Verify the SMTP transport (transporter.verify()). Runs once at server boot
 * so misconfiguration (bad credentials/host) is visible at startup rather than
 * at first signup. Throws on failure — caller decides whether to exit or warn.
 * @param {boolean} [exitOnFailure=true] - if true, process.exit(1) on bad creds
 */
async function verifyTransport(exitOnFailure = true) {
  if (!smtpConfigured()) {
    const msg = 'SMTP is not configured or contains placeholder values. ' +
      'Set REAL SMTP_HOST, SMTP_USER, SMTP_PASS in .env. ' +
      'Gmail: smtp.gmail.com / 587 / false + a Google App Password (16 chars).';
    if (IS_PRODUCTION) {
      console.error('============================================================');
      console.error('❌ EMAIL DELIVERY IS BROKEN:');
      console.error('  ' + msg);
      console.error('  A normal Gmail password will be REJECTED — use an App Password.');
      console.error('============================================================');
    }
    if (exitOnFailure) {
      console.error('❌ [SMTP] Refusing to start: email verification will not work.');
      process.exit(1);
    }
    throw new Error(msg);
  }

  try {
    const t = getTransporter();
    await t.verify();
    console.log('✅ SMTP transport verified (' + process.env.SMTP_HOST + ':' + process.env.SMTP_PORT + '). Emails will deliver.');
    return true;
  } catch (error) {
    const msg = 'SMTP credential/transport verification FAILED: ' + (error && error.message || String(error));
    console.error('============================================================');
    console.error('❌ EMAIL DELIVERY IS BROKEN:');
    console.error('  ' + msg);
    console.error('  Check SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS.');
    console.error('  Gmail requires: 2-Step Verification enabled + a 16-char App Password.');
    console.error('============================================================');
    if (exitOnFailure) {
      console.error('❌ [SMTP] Refusing to start: email verification will not work.');
      process.exit(1);
    }
    throw error;
  }
}

const FROM = process.env.MAIL_FROM || process.env.FROM_EMAIL || 'AniStrim <no-reply@anistrim.com>';

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

/**
 * Send an HTML email.
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} html - HTML body
 * @param {string} [otpCode] - the OTP code, used ONLY for the dev console fallback
 */
async function sendEmail(to, subject, html, otpCode) {
  if (!smtpConfigured()) {
    if (IS_PRODUCTION) {
      // Fail loudly — never silently swallow mail delivery in production, and
      // never print the OTP code.
      console.error(`EMAIL NOT SENT (SMTP unconfigured) to: ${to}`);
      recordEmailEvent(to, subject, 'failure', 'SMTP is not configured (production)');
      throw new Error('SMTP is not configured and we are in production. Email not sent.');
    }
    // Development fallback: print the code so local testing still works.
    if (otpCode) {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} | Code: ${otpCode}`);
    } else {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} (no code supplied)`);
    }
    // Dev console-delivery counts as success (it delivered to the dev console).
    recordEmailEvent(to, subject, 'success', null);
    return;
  }

  const t = getTransporter();
  const from = process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.SMTP_USER;
  try {
    await t.sendMail({ from, to, subject, html });
    recordEmailEvent(to, subject, 'success', null);
  } catch (error) {
    recordEmailEvent(to, subject, 'failure', error && (error.message || String(error)));
    throw error;
  }
}

module.exports = { sendEmail, getTransporter, smtpConfigured, verifyTransport };
