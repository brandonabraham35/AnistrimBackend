// utils/password.js — single source of truth for the password processing policy.
//
// Every password-writing path (signup, login, set-password, change-password,
// reset-password, admin creation) MUST use these helpers so the pepper + bcrypt
// policy is identical everywhere. Do NOT duplicate pepper logic in controllers.
//
// Transition note: the algorithm is unchanged from the historical inline
// implementation, so existing hashes remain valid. If PASSWORD_PEPPER is added,
// removed, or changed AFTER accounts were created, existing hashes will no
// longer verify — treat that as a deliberate migration (re-issue passwords).
const crypto = require('crypto');

function pepperPassword(password) {
  const pepper = process.env.PASSWORD_PEPPER;
  if (pepper && typeof pepper === 'string' && pepper.trim() !== '') {
    return crypto.createHmac('sha256', pepper.trim()).update(String(password)).digest('hex');
  }
  if (process.env.NODE_ENV === 'production' && (!pepper || pepper.trim() === '')) {
    console.warn('[PASSWORD] WARNING: PASSWORD_PEPPER is not set in production. ' +
      'Password hashes are vulnerable to offline cracking if the database is breached.');
  }
  return String(password);
}

async function hashPassword(password) {
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pepperPassword(password), salt);
}

async function verifyPassword(password, hash) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(pepperPassword(password), hash);
}

module.exports = { pepperPassword, hashPassword, verifyPassword };
