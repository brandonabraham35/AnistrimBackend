// controllers/googleVerifyController.js
// Google Identity Services (GIS) flows:
//   POST /api/auth/google/verify  -> LOGIN only (never creates an account)
//   POST /api/auth/google/signup  -> SIGNUP only (may create an account)
//
// Both verify the ID token server-side, but the business decision (login vs
// signup) is made HERE, not in the shared helper.
const { signAuthToken } = require('../utils/token');
const {
  verifyGoogleIdToken,
  findGoogleUser,
  findUserByEmail,
  createGoogleUser,
  authenticateExistingGoogleUser,
} = require('../services/googleUpsert');

function userObj(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isPremium: !!user.is_premium,
    isAdmin: !!user.is_admin,
    isVerified: !!user.is_verified,
    authProvider: user.auth_provider || 'local',
    avatar: user.avatar_url,
  };
}

// ── Google LOGIN (existing account only) ───────────────────
exports.verifyGoogleToken = function (req, res) {
  // Manual async wrapper for Express 5 (it does not auto-catch).
  (async () => {
    try {
      const { idToken } = req.body;
      const profile = await verifyGoogleIdToken(idToken);

      // 1. Look up by google_id (fastest for returning Google users)
      let user = await findGoogleUser(profile.sub);

      // 2. If no google_id match, look up by the verified email
      if (!user) {
        user = await findUserByEmail(profile.email);
      }

      // 3. No account exists → DO NOT create/upsert/link. Return a clear error.
      if (!user) {
        return res.status(404).json({
          success: false,
          code: 'GOOGLE_ACCOUNT_NOT_FOUND',
          message: 'No AniStrim account exists for this Google account. Please create an account first.',
        });
      }

      // 4. Existing LOCAL (email/password) account → do NOT silently link.
      if (user.auth_provider !== 'google' && !user.google_id) {
        return res.status(403).json({
          success: false,
          code: 'GOOGLE_ACCOUNT_NOT_LINKED',
          message: 'An AniStrim account already exists with this email. Please log in using your email and password.',
        });
      }

      // 5. Existing Google-linked account → authenticate normally.
      user = await authenticateExistingGoogleUser(user, profile);
      const token = signAuthToken(user);
      return res.json({ token, user: userObj(user), message: 'Welcome back!' });
    } catch (err) {
      console.error('Google login (verify) error:', err.message);
      if (err.status === 400) {
        return res.status(400).json({ success: false, code: err.code || 'GOOGLE_INVALID_REQUEST', message: err.message });
      }
      if (err.message && err.message.includes('Token used too late')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_TOKEN_EXPIRED', message: 'Google token has expired. Please try again.' });
      }
      if (err.message && err.message.includes('Invalid token')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_INVALID_TOKEN', message: 'Invalid Google token. Please try again.' });
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({ success: false, code: 'GOOGLE_NETWORK_ERROR', message: 'Unable to verify Google token. Network error.' });
      }
      return res.status(401).json({ success: false, code: 'GOOGLE_VERIFY_FAILED', message: 'Google verification failed. Please try again.' });
    }
  })();
};

// ── Google SIGNUP (may create an account) ──────────────────
exports.googleSignup = function (req, res) {
  (async () => {
    try {
      const { idToken } = req.body;
      const profile = await verifyGoogleIdToken(idToken);

      // 1. If a Google user already exists by google_id → already have account.
      let user = await findGoogleUser(profile.sub);
      if (user) {
        return res.status(409).json({
          success: false,
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: 'An AniStrim account already exists for this Google account. Please log in instead.',
        });
      }

      // 2. If a user with this email already exists (local or other) → do NOT
      //    link or duplicate; tell them to log in.
      user = await findUserByEmail(profile.email);
      if (user) {
        return res.status(409).json({
          success: false,
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: 'An AniStrim account already exists with this email. Please log in instead.',
        });
      }

      // 3. No account exists → create a new verified Google user.
      user = await createGoogleUser(profile);
      const token = signAuthToken(user);
      return res.status(201).json({ token, user: userObj(user), message: 'Account created. Welcome!' });
    } catch (err) {
      console.error('Google signup error:', err.message);
      if (err.status === 400) {
        return res.status(400).json({ success: false, code: err.code || 'GOOGLE_INVALID_REQUEST', message: err.message });
      }
      if (err.message && err.message.includes('Token used too late')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_TOKEN_EXPIRED', message: 'Google token has expired. Please try again.' });
      }
      if (err.message && err.message.includes('Invalid token')) {
        return res.status(401).json({ success: false, code: 'GOOGLE_INVALID_TOKEN', message: 'Invalid Google token. Please try again.' });
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return res.status(503).json({ success: false, code: 'GOOGLE_NETWORK_ERROR', message: 'Unable to verify Google token. Network error.' });
      }
      return res.status(401).json({ success: false, code: 'GOOGLE_VERIFY_FAILED', message: 'Google verification failed. Please try again.' });
    }
  })();
};