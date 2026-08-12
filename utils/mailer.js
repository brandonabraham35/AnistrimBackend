// utils/mailer.js — SMTP email dispatcher for AniStrim
// Uses nodemailer with the exact env keys: SMTP_HOST, SMTP_USER, SMTP_PASS, FROM_EMAIL.
const nodemailer = require('nodemailer');

// Create a shared transporter (lazy — only resolves when SMTP env is present)
let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS.');
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

/**
 * Send an HTML email.
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} html - HTML body
 */
async function sendEmail(to, subject, html) {
  const t = getTransporter();
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;
  await t.sendMail({ from, to, subject, html });
}

module.exports = { sendEmail, getTransporter };