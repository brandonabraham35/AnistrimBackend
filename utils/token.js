// utils/token.js — centralized JWT signing for AniStrim sessions.
//
// Phase 1 (Identity & Account Lifecycle) introduced a NEW access-token contract
// in services/sessionService.js:
//   Claims: { uid, sid, tv (token_version), roles[], iat, exp }
//   TTL: 15 minutes. No isPremium in the token — entitlement is looked up per
//   request (it goes stale, which is exactly the bug class in item 23).
//
// This file retains the LEGACY signAuthToken for backward compatibility with
// consumers that still read the old claim shape (id, userId, isAdmin, isPremium,
// isVerified). New code should use sessionService.signAccessToken instead.
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