// utils/token.js — centralized JWT signing for AniStrim sessions.
//
// Every auth path (manual login, signup/verify-otp, Google verify, Google
// OAuth redirect) mints an IDENTICAL claim shape via signAuthToken, so no
// session can diverge from another or from the database.
//
// Claim shape: { userId, email, name, isVerified, authProvider }
//   (plus iat/exp, and id/isAdmin/isPremium kept for backward compatibility
//   with consumers that read them from the token).
//
// isVerified is ALWAYS derived from the DB row (user.is_verified) — never
// hardcoded — so the JWT and the database stay in agreement, which is what
// middleware/authMiddleware.verifyTokenAndStatus relies on.
const jwt = require('jsonwebtoken');

function signAuthToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      isVerified: !!user.is_verified,
      authProvider: user.auth_provider || 'local',
      // Backward compatibility for existing consumers (getMe, watch, admin):
      id: user.id,
      isAdmin: !!user.is_admin,
      isPremium: !!user.is_premium,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' }
  );
}

// Backward-compatible alias used by any code that still references signUserToken.
const signUserToken = signAuthToken;

module.exports = { signAuthToken, signUserToken };