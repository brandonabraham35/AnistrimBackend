// controllers/googleVerifyController.js
// Verifies a Google ID token sent directly from the frontend (GIS approach).
// No browser redirects — works directly in the Capacitor WebView.
//
// THIS IS THE PRIMARY Google auth flow for the web application. The legacy
// OAuth redirect flow (googleAuthController.js) is kept exclusively for
// Capacitor/mobile deep-link support.
const { signAuthToken } = require('../utils/token');
const { verifyGoogleIdToken, upsertGoogleUser } = require('../services/googleUpsert');

// POST /api/auth/google/verify
exports.verifyGoogleToken = function (req, res) {
  // Manual async wrapper for Express 5 compatibility (it does not auto-catch).
  (async () => {
    try {
      const { idToken } = req.body;

      // Server-side verification + email_verified check (rejects if not verified).
      const payload = await verifyGoogleIdToken(idToken);

      // Find-or-create / link the user (transactional, is_verified=1, google provider).
      const user = await upsertGoogleUser(payload);

      const token = signAuthToken(user);
      const userObj = {
        id: user.id,
        name: user.name,
        email: user.email,
        isPremium: !!user.is_premium,
        isAdmin: !!user.is_admin,
        isVerified: !!user.is_verified,
        avatar: user.avatar_url,
      };

      console.log(`✅ Google login (verify): ${user.email}`);
      return res.json({ token, user: userObj, message: 'Welcome!' });
    } catch (err) {
      console.error('Google verify error:', err.message);

      if (err.status === 400) {
        return res.status(400).json({ message: err.message });
      }
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