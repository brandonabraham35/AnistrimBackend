// services/googleUpsert.js — shared Google auto-provisioning logic.
//
// Used by both the GIS flow (googleVerifyController) and the OAuth redirect
// flow (googleAuthController) so a Google login always:
//   1. Verifies the ID token server-side (rejecting unverified Google emails).
//   2. Looks up by google_id, then by email.
//   3. Creates a new verified user (auth_provider='google', is_verified=1) or
//      links an existing account to Google (promoting it to verified).
//   4. Persists is_verified=1 BEFORE any token is signed.
//   5. Handles the duplicate-key race with a re-select on ER_DUP_ENTRY.
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and return its payload, or throw.
 * Rejects tokens with an unverified Google email.
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Google ID token is required.');
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
    err.status = 400;
    throw err;
  }
  if (payload.email_verified !== true) {
    const err = new Error('Google email is not verified.');
    err.status = 400;
    throw err;
  }
  return payload;
}

/**
 * Upsert a user from a verified Google profile payload.
 * @returns {Promise<object>} the user row (with is_verified=1 and auth_provider set)
 */
async function upsertGoogleUser(profile) {
  const googleEmail = profile.email;
  const googleName = profile.name || googleEmail.split('@')[0];
  const googleAvatar = profile.picture || null;
  const googleId = profile.sub;

  // Use a dedicated connection so the lookup + insert/update is atomic.
  const conn = await pool.getConnection();
  try {
    // 1. Lookup by google_id (fast path for returning users)
    let [byGoogle] = await conn.query('SELECT * FROM users WHERE google_id = ?', [googleId]);

    if (byGoogle.length > 0) {
      // Returning Google user — refresh avatar/time, ensure verified.
      const user = byGoogle[0];
      await conn.query(
        `UPDATE users SET is_verified = 1, last_login = NOW(), updated_at = NOW(),
           avatar_url = COALESCE(?, avatar_url)
         WHERE id = ?`,
        [googleAvatar, user.id]
      );
      user.is_verified = 1;
      user.auth_provider = 'google';
      if (googleAvatar) user.avatar_url = googleAvatar;
      return user;
    }

    // 2. Lookup by email (existing email/password user linking Google)
    let [byEmail] = await conn.query('SELECT * FROM users WHERE email = ?', [googleEmail]);

    if (byEmail.length > 0) {
      // Link the Google identity, promote to verified, clear any stale OTP.
      const user = byEmail[0];
      await conn.query(
        `UPDATE users SET google_id = ?, is_verified = 1, auth_provider = 'google',
           avatar_url = COALESCE(?, avatar_url),
           verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
           last_login = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [googleId, googleAvatar, user.id]
      );
      user.google_id = googleId;
      user.is_verified = 1;
      user.auth_provider = 'google';
      if (googleAvatar) user.avatar_url = googleAvatar;
      return user;
    }

    // 3. No user — create a new verified Google account (no OTP email).
    try {
      const [result] = await conn.query(
        `INSERT INTO users (name, email, password_hash, avatar_url, google_id, is_admin, is_premium, is_verified, auth_provider)
         VALUES (?, ?, NULL, ?, ?, 0, 0, 1, 'google')`,
        [googleName, googleEmail, googleAvatar, googleId]
      );
      const [newRows] = await conn.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      return newRows[0];
    } catch (insertError) {
      // Race: another request (or a manual signup) took this email/google_id.
      if (insertError.code !== 'ER_DUP_ENTRY') throw insertError;
      const [dupeRows] = await conn.query('SELECT * FROM users WHERE email = ?', [googleEmail]);
      if (dupeRows.length > 0) {
        const user = dupeRows[0];
        await conn.query(
          `UPDATE users SET google_id = ?, is_verified = 1, auth_provider = 'google',
             avatar_url = COALESCE(?, avatar_url),
             verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
             last_login = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [googleId, googleAvatar, user.id]
        );
        user.google_id = googleId;
        user.is_verified = 1;
        user.auth_provider = 'google';
        if (googleAvatar) user.avatar_url = googleAvatar;
        return user;
      }
      throw insertError;
    }
  } finally {
    conn.release();
  }
}

module.exports = { verifyGoogleIdToken, upsertGoogleUser };