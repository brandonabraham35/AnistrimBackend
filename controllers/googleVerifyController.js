// controllers/googleVerifyController.js
// Verifies Google ID token sent directly from frontend (GIS approach)
// No browser redirects needed — works directly in Capacitor WebView
//
// THIS IS THE PRIMARY Google authentication flow for the web application.
// Legacy OAuth redirect flow (googleAuthController.js) is kept exclusively
// for Capacitor/mobile deep-link support and is NOT used by the web app.

const { OAuth2Client } = require('google-auth-library');
const db  = require('../config/db');
const { signUserToken } = require('../utils/token');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/google/verify
// Frontend sends Google ID token, we verify it and return our JWT
// Wrapped for Express 5 async safety — does NOT rely on Express catching rejected promises
exports.verifyGoogleToken = function (req, res) {
  // Manual async wrapper for Express 5 compatibility
  // Express 5 does NOT automatically catch async errors in route handlers
  (async () => {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: 'Google ID token is required.' });
    }
                                                                                                  
    if (typeof idToken !== 'string' || idToken.length < 20) {
      return res.status(400).json({ message: 'Invalid Google ID token format.' });
    }

    try {
      // Verify the token with Google
      const ticket = await googleClient.verifyIdToken({
        idToken:  idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();

      // Validate issuer
      const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
      if (!validIssuers.includes(payload.iss)) {
        return res.status(400).json({ message: 'Invalid token issuer.' });
      }

      // Validate audience
      if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
        return res.status(400).json({ message: 'Token audience mismatch.' });
      }

      if (!payload.email_verified) {
        return res.status(400).json({ message: 'Google email is not verified.' });
      }

      if (!payload.email) {
        return res.status(400).json({ message: 'Could not retrieve email from Google.' });
      }

      const googleEmail  = payload.email;
      const googleName   = payload.name || googleEmail.split('@')[0];
      const googleAvatar = payload.picture || null;
      const googleId     = payload.sub;

      // ── Find or create user ─────────────────────────────
      // Step 1: Look up by google_id first (fastest for returning users)
      let [rowsById] = await db.query(
        'SELECT * FROM users WHERE google_id = ?', [googleId]
      );

      let user;
      if (rowsById.length > 0) {
        // Existing Google user — update avatar, login timestamp, and ensure the
        // row is verified (Google already vouched for this email).
        user = rowsById[0];
        const updates = ['is_verified = 1', 'last_login = NOW()', 'updated_at = NOW()'];
        const params = [];

        if (googleAvatar && googleAvatar !== user.avatar_url) {
          updates.push('avatar_url = ?');
          params.push(googleAvatar);
        }

        params.push(user.id);
        await db.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
        user.avatar_url = googleAvatar || user.avatar_url;
        user.is_verified = 1;
      } else {
        // Step 2: Look up by email (existing email/password user linking Google)
        const [rowsByEmail] = await db.query(
          'SELECT * FROM users WHERE email = ?', [googleEmail]
        );

        if (rowsByEmail.length > 0) {
          // Existing email user — link Google account. Google vouching for the
          // mailbox promotes even a stuck unverified manual account to verified,
          // and clears any stale OTP state.
          user = rowsByEmail[0];
          await db.query(
            `UPDATE users SET google_id = ?, is_verified = 1,
               avatar_url = COALESCE(?, avatar_url),
               verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
               last_login = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [googleId, googleAvatar, user.id]
          );
          user.google_id  = googleId;
          user.is_verified = 1;
          user.avatar_url = googleAvatar || user.avatar_url;
        } else {
          // Step 3: Create new user — verified from the start (is_verified = 1).
          try {
            const [result] = await db.query(
              `INSERT INTO users (name, email, password_hash, avatar_url, google_id, is_admin, is_premium, is_verified)
               VALUES (?, ?, NULL, ?, ?, 0, 0, 1)`,
              [googleName, googleEmail, googleAvatar, googleId]
            );
            const [newRows] = await db.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
            user = newRows[0];
          } catch (insertError) {
            // Race guard: another request created this row between our SELECTs
            // (or a manual signup took this email). Re-select by email and treat
            // it as the account-linking case so the user is never left locked out.
            if (insertError.code !== 'ER_DUP_ENTRY') throw insertError;
            const [dupeRows] = await db.query('SELECT * FROM users WHERE email = ?', [googleEmail]);
            if (!dupeRows.length) throw insertError;
            user = dupeRows[0];
            await db.query(
              `UPDATE users SET google_id = ?, is_verified = 1,
                 avatar_url = COALESCE(?, avatar_url),
                 verification_code = NULL, verification_expires = NULL, verification_attempts = 0,
                 last_login = NOW(), updated_at = NOW()
               WHERE id = ?`,
              [googleId, googleAvatar, user.id]
            );
            user.google_id  = googleId;
            user.is_verified = 1;
            user.avatar_url = googleAvatar || user.avatar_url;
          }
        }
      }

      const token   = signUserToken(user);
      const userObj = {
        id:        user.id,
        name:      user.name,
        email:     user.email,
        isPremium: !!user.is_premium,
        isAdmin:   !!user.is_admin,
        isVerified: !!user.is_verified,
        avatar:    user.avatar_url,
      };

      console.log(`✅ Google login: ${googleEmail} (${rowsById.length > 0 ? 'existing' : 'new'})`);
      return res.json({ token, user: userObj, message: 'Welcome!' });

    } catch (err) {
      console.error('Google verify error:', err.message);

      // Differentiate between error types
      if (err.message && err.message.includes('Token used too late')) {
        return res.status(401).json({ message: 'Google token has expired. Please try again.' });
      }
      if (err.message && err.message.includes('Invalid token')) {
        return res.status(401).json({ message: 'Invalid Google token. Please try again.' });
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({ message: 'Unable to verify Google token. Network error.' });
      }

      return res.status(401).json({ message: 'Google verification failed. Please try again.' });
    }
  })();
};