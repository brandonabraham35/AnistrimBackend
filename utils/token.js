// utils/token.js — shared JWT signing for AniStrim sessions.
//
// Single source of truth for session tokens so every auth path (manual login,
// Google verify, Google OAuth redirect) mints identical JWT claims.
//
// The payload ALWAYS carries the user's CURRENT isVerified status from the DB
// row — never a hardcoded value. This keeps the token claim and the database
// in agreement, which is what middleware/authMiddleware.verifyTokenAndStatus
// relies on ("only verified users stream").
//
// Emits BOTH `id` and `userId` so every consumer (getMe, watch, download)
// works during the migration window. The `user` object must include id, name,
// email, is_admin, is_premium, is_verified.
const jwt = require('jsonwebtoken');

function signUserToken(user) {
  return jwt.sign(
    {
      id: user.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      isAdmin: !!user.is_admin,
      isPremium: !!user.is_premium,
      isVerified: !!user.is_verified,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' }
  );
}

module.exports = { signUserToken };