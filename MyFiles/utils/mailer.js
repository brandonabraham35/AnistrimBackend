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

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
  });
  return transporter;
}

const FROM = process.env.MAIL_FROM || process.env.FROM_EMAIL || 'AniStrim <no-reply@anistrim.com>';

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
      throw new Error('SMTP is not configured and we are in production. Email not sent.');
    }
    // Development fallback: print the code so local testing still works.
    if (otpCode) {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} | Code: ${otpCode}`);
    } else {
      console.log(`[DEV MAIL] To: ${to} | Subject: ${subject} (no code supplied)`);
    }
    return;
  }

  const t = getTransporter();
  const from = process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.SMTP_USER;
  await t.sendMail({ from, to, subject, html });
}

module.exports = { sendEmail, getTransporter, smtpConfigured };