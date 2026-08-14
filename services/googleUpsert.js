// services/googleUpsert.js — shared Google identity helpers.
//
// This module provides the LOW-LEVEL building blocks for Google auth. It does
// NOT decide whether to create an account — that is a business decision made
// by the controllers:
//
//   LOGIN  = existing account only (never create, never silently link)
//   SIGNUP = existing account rejected / new account allowed
//
// Exposed helpers:
//   verifyGoogleIdToken(idToken)          — server-side ID token verification
//   findGoogleUser(googleId)              — lookup by google_id
//   findUserByEmail(email)                — lookup by email
//   createGoogleUser(profile)             — INSERT a new verified Google user
//   authenticateExistingGoogleUser(user, profile) — refresh avatar/name + last_login
//   linkGoogleAccount(user, profile)      — explicit local→Google linking (opt-in)
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and return its payload, or throw.
 * Validates signature, audience, issuer, email, and email_verified.
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Google ID token is required.');
    err.code = 'GOOGLE_TOKEN_REQUIRED';
    err.status = 400;
    throw err;
  }
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!payload || !payload.email) {
    const err = new Error('Could not retrieve email from Google.');
    err.code = 'GOOGLE_EMAIL_MISSING';
    err.status = 400;
    throw err;
  }
  if (payload.email_verified !== true) {
    const err = new Error('Google email is not verified.');
    err.code = 'GOOGLE_EMAIL_NOT_VERIFIED';
    err.status = 400;
    throw err;
  }
  return payload;
}

/** Look up a user by Google subject id. */
async function findGoogleUser(googleId) {
  const [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [googleId]);
  return rows[0] || null;
}

/** Look up a user by email. */
async function findUserByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

/**
 * Create a new verified Google user (SIGNUP path only).
 * password_hash stays NULL; auth_provider='google'; is_verified=1.
 */
async function createGoogleUser(profile) {
  const googleEmail = profile.email;
  const googleName = profile.name || googleEmail.split('@')[0];
  const googleAvatar = profile.picture || null;
  const googleId = profile.sub;

  const [result] = await pool.query(
    `INSERT INTO users (name, email, password_hash, avatar_url, google_id, is_admin, is_premium, is_verified, auth_provider, status, email_verified_at)
     VALUES (?, ?, NULL, ?, ?, 0, 0, 1, 'google', 'active', NOW())`,
    [googleName, googleEmail, googleAvatar, googleId]
  );
  const [newRows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  return newRows[0];
}

/**
 * Authenticate an existing Google-linked user (LOGIN path).
 * Refreshes avatar/name from Google and updates last_login. Does NOT touch
 * password_hash or auth_provider.
 */
async function authenticateExistingGoogleUser(user, profile) {
  const googleAvatar = profile.picture || null;
  const googleName = profile.name || null;

  const updates = ['last_login = NOW()', 'last_login_at = NOW()', 'updated_at = NOW()'];
  const params = [];
  if (googleAvatar && googleAvatar !== user.avatar_url) {
    updates.push('avatar_url = ?');
    params.push(googleAvatar);
  }
  if (googleName && googleName !== user.name) {
    updates.push('name = ?');
    params.push(googleName);
  }
  params.push(user.id);
  await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

  if (googleAvatar) user.avatar_url = googleAvatar;
  if (googleName) user.name = googleName;
  return user;
}

/**
 * Explicitly link a local account to Google (opt-in only — NOT called by the
 * default login/signup flows). Marks the account verified and sets
 * auth_provider='google'. Use only when the product flow explicitly requires it.
 */
async function linkGoogleAccount(user, profile) {
  const googleId = profile.sub;
  const googleAvatar = profile.picture || null;
  await pool.query(
    `UPDATE users SET google_id = ?, is_verified = 1, auth_provider = 'google',
       status = 'active', email_verified_at = COALESCE(email_verified_at, NOW()),
       avatar_url = COALESCE(?, avatar_url),
       verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
       last_login = NOW(), last_login_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [googleId, googleAvatar, user.id]
  );
  user.google_id = googleId;
  user.is_verified = 1;
  user.auth_provider = 'google';
  if (googleAvatar) user.avatar_url = googleAvatar;
  return user;
}

module.exports = {
  verifyGoogleIdToken,
  findGoogleUser,
  findUserByEmail,
  createGoogleUser,
  authenticateExistingGoogleUser,
  linkGoogleAccount,
};