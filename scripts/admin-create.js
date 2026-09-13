// scripts/admin-create.js - explicit, one-time administrator creation.
//
//   npm run admin:create
//
// Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME env vars, or
// are prompted interactively. It NEVER uses a hardcoded/default password, applies
// PASSWORD_PEPPER via utils/password.js (same policy as every auth path), refuses
// unsafe production defaults, and grants the authoritative user_roles 'admin'
// role. It never runs automatically.
const readline = require('readline');
require('dotenv').config();
const pool = require('../config/db');
// Single source of truth for the password policy (pepper + bcrypt).
const { pepperPassword, hashPassword } = require('../utils/password');
// Admin authorization is FAIL-CLOSED and granted from user_roles; this command
// (and migrations_v27_user_roles.sql) populate that table so legacy is_admin-only
// admins retain access until backfilled.
const { grantRole } = require('../utils/hasRole');

const KNOWN_WEAK = new Set([
  'admin123', 'password', 'password1', 'admin', 'newadmin123', '123456',
  'changeme', 'admin1234', 'password123', 'anistrim', 'anistrim123',
  'administrator', 'letmein', 'qwerty',
]);

function validateCredentials({ email, password }) {
  const errors = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('A valid admin email is required.');
  }
  if (!password) {
    errors.push('A password is required.');
  } else {
    if (password.length < 12) errors.push('Password must be at least 12 characters.');
    if (process.env.NODE_ENV === 'production' && password.length < 16) {
      errors.push('Production requires a password of at least 16 characters.');
    }
    if (KNOWN_WEAK.has(String(password).toLowerCase())) {
      errors.push('That password is a known weak/default value. Choose a strong random password.');
    }
    if (email && String(password).toLowerCase().includes(String(email).split('@')[0].toLowerCase())) {
      errors.push('Password must not contain the admin email local-part.');
    }
  }
  return errors;
}

async function createAdmin({ email, password, name }) {
  const errors = validateCredentials({ email, password });
  if (errors.length) {
    throw new Error('Refusing to create admin:\n  - ' + errors.join('\n  - '));
  }
  const hash = await hashPassword(password);
  const displayName = name || 'Admin';
  const conn = await pool.getConnection();
  try {
    await conn.query(
      `INSERT INTO users (name, email, password_hash, is_admin, is_premium, is_verified, status, auth_provider)
       VALUES (?, ?, ?, 1, 1, 1, 'active', 'password')
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         is_admin = 1,
         is_premium = 1,
         is_verified = 1,
         status = 'active',
         auth_provider = 'password'`,
      [displayName, email, hash]
    );
    // Grant the authoritative admin role in user_roles (the fail-closed source
    // for adminOnly). Legacy users.is_admin is retained for display/compat only.
    const [rows] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (!rows.length) throw new Error('Could not resolve admin user id.');
    await conn.query('INSERT IGNORE INTO user_roles (user_id, role) VALUES (?, ?)', [rows[0].id, 'admin']);
    return { email, name: displayName, id: rows[0].id };
  } finally {
    conn.release();
  }
}

function prompt(question, hide = false) {
  return new Promise((resolve) => {
    if (!hide) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (ans) => { rl.close(); resolve(ans); });
      return;
    }
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const finish = () => {
      stdin.removeListener('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      chunk = String(chunk);
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') { finish(); return; }
        value += ch;
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  let email = process.env.ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD;
  let name = process.env.ADMIN_NAME;
  if (!email) email = await prompt('Admin email: ');
  if (!password) password = await prompt('Admin password (min 12 chars): ', true);
  if (!name) name = (await prompt('Admin display name [Admin]: ')) || 'Admin';
  try {
    const result = await createAdmin({ email, password, name });
    console.log(`Admin '${result.email}' created/updated (is_admin=1, role granted).`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    pool.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { createAdmin, validateCredentials, pepperPassword };
