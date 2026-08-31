// services/userDtoService.js — the single authoritative user DTO builder.
//
// Every endpoint that returns a user (login, signup, verify-otp, Google,
// GET /api/auth/me) builds the response through this module so the shape is
// identical everywhere. Entitlement (isPremium) is looked up per request —
// never read from a stale JWT claim.
const pool = require('../config/db');
const { rolesOf } = require('../utils/hasRole');
const { getPreferences } = require('./preferencesService');

/**
 * Build the canonical user DTO for a user row.
 * @param {object} user - a full users row (SELECT * FROM users WHERE id = ?)
 * @returns {Promise<object>} the canonical DTO
 */
async function buildUserDto(user) {
  if (!user) return null;

  const roles = await rolesOf(user.id);
  const isAdmin = roles.includes('admin');

  // Entitlement is looked up per request (never from a stale JWT claim).
  const entitlement = await resolveEntitlement(user);

  // Auto-onboard eligible users: if they have a name and verified email
  // but have never completed the Android onboarding flow, mark them as
  // onboarded automatically. This ensures accounts created on Web (which
  // has no onboarding page) do not trigger Android's onboarding redirect.
  // The SQL is idempotent (COALESCE guards against race conditions).
  if (!user.onboarded_at && user.name && (user.email_verified_at || user.is_verified)) {
    try {
      await pool.query(
        'UPDATE users SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = ? AND onboarded_at IS NULL',
        [user.id]
      );
      user.onboarded_at = new Date();
    } catch (_) {
      // Non-fatal — the DTO will still return onboarded:false and
      // Navigation.afterAuth will redirect to onboarding as before.
    }
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username || null,
    displayName: user.display_name || user.name || null,
    avatarUrl: user.avatar_url || null,
    status: user.status || 'pending',
    emailVerified: !!user.email_verified_at || !!user.is_verified,
    authProvider: user.auth_provider || 'password',
    isAdmin,
    roles,
    createdAt: user.created_at || null,
    lastLoginAt: user.last_login_at || user.last_login || null,
    onboarded: !!user.onboarded_at,
    entitlement,
    preferences: await getPreferences(user.id),
  };
}

/**
 * Resolve the user's current premium entitlement from the DB.
 * Source: 'subscription' (active subscription), 'legacy' (is_premium flag),
 * or null when not premium.
 */
async function resolveEntitlement(user) {
  // Admin users always have premium access.
  try {
    const { hasRole } = require('../utils/hasRole');
    const roles = await hasRole(user.id, 'admin');
    if (roles) {
      return { isPremium: true, plan: 'admin', expiresAt: null, source: 'admin' };
    }
  } catch (_) { /* non-fatal — fall through */ }

  // 1. Active subscription (authoritative).
  try {
    const [subs] = await pool.query(
      `SELECT plan, ends_at, state, status
       FROM subscriptions
       WHERE user_id = ? AND status = 'COMPLETED' AND state IN ('trialing', 'active', 'grace')
         AND (ends_at IS NULL OR ends_at > NOW())
       ORDER BY ends_at DESC
       LIMIT 1`,
      [user.id]
    );
    if (subs.length) {
      const sub = subs[0];
      return {
        isPremium: true,
        plan: (sub.plan || 'standard').toLowerCase(),
        expiresAt: sub.ends_at || null,
        source: 'subscription',
      };
    }
  } catch (e) {
    // subscriptions table may not exist yet — fall through to legacy flag.
  }

  // 2. Legacy is_premium flag (pre-subscription model).
  if (user.is_premium) {
    return {
      isPremium: true,
      plan: 'standard',
      expiresAt: user.premium_expires_at || null,
      source: 'legacy',
    };
  }

  return { isPremium: false, plan: null, expiresAt: null, source: null };
}

module.exports = { buildUserDto, resolveEntitlement };
