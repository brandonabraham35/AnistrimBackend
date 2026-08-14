// utils/episodeAccess.js — P2/P7: server-side episode access authority.
//
// Effective access is computed HERE (application layer) from the schema added by
// migrations_v28_premium_access.sql. The single source of truth for the
// fallthrough logic is this file, reused by watch/stream/detail endpoints:
//   • episode INHERIT                       -> anime.access_tier
//   • episode FREE                          -> free
//   • episode PREMIUM + premium_until NULL  -> premium (permanent)
//   • episode PREMIUM + premium_until < NOW -> free (expired => free everywhere)
//
// Phase 7 (7.2): one entitlement function + canWatch:
//   getEntitlement(userId) → { isPremium, tier, planCode, expiresAt, state, source }
//   canWatch(userId, episodeId) → { allow, reason, requiredTier, availableAt }
//     allow = effectiveTier === 'free'
//          || entitlement.isPremium && state in ('trialing','active','grace')
//          || user.isAdmin
const pool = require('../config/db');

// Authoritative premium state that grants access.
const GRANTING_STATES = new Set(['trialing', 'active', 'grace']);

// Load the effective tier for a list of episode ids in one query.
async function loadTiers(episodeIds) {
  const ids = Array.isArray(episodeIds) ? episodeIds : [episodeIds];
  if (!ids.length) return {};
  const [rows] = await pool.query(
    `SELECT e.id,
            COALESCE(e.access_tier, 'inherit') AS e_tier,
            e.premium_until AS e_until,
            COALESCE(a.access_tier, 'free')   AS a_tier
     FROM episodes e
     JOIN anime a ON a.id = e.anime_id
     WHERE e.id IN (?)`,
    [ids]
  );
  const now = Date.now();
  const map = {};
  for (const r of rows) {
    let tier = 'free';
    let availableAt = null;
    if (r.e_tier === 'premium') {
      tier = 'premium';
      if (r.e_until && new Date(r.e_until).getTime() <= now) tier = 'free'; // expired
      else if (r.e_until) availableAt = r.e_until; // future premium window
    } else if (r.e_tier === 'free') {
      tier = 'free';
    } else { // inherit
      tier = r.a_tier === 'premium' ? 'premium' : 'free';
    }
    map[r.id] = { tier, availableAt };
  }
  return map;
}

/**
 * Effective access tier for a single episode: 'free' | 'premium'.
 */
async function effectiveAccess(episodeId) {
  if (episodeId === undefined || episodeId === null) return 'premium';
  try {
    const map = await loadTiers([episodeId]);
    return (map[episodeId] && map[episodeId].tier) || 'free';
  } catch (e) {
    // Columns not migrated yet — fall back to legacy is_premium.
    try {
      const [rows] = await pool.query('SELECT is_premium FROM episodes WHERE id = ?', [episodeId]);
      return (rows.length && rows[0] && rows[0].is_premium) ? 'premium' : 'free';
    } catch (_) { return 'free'; }
  }
}

/**
 * Phase 7.2 — getEntitlement(userId): server-authoritative entitlement from the
 * subscriptions + plans read path. users.is_premium is a derived cache only and
 * is NEVER read for authorization.
 * @param {number|string} userId
 * @returns {Promise<{isPremium, tier, planCode, expiresAt, state, source}>}
 */
async function getEntitlement(userId) {
  if (userId === undefined || userId === null) {
    return { isPremium: false, tier: null, planCode: null, expiresAt: null, state: null, source: null };
  }
  try {
    // Prefer the enriched subscriptions read path (plan joined).
    const [rows] = await pool.query(
      `SELECT s.state, s.source, s.ends_at, p.code AS plan_code, p.tier AS plan_tier
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ?
         AND s.state IN ('trialing','active','grace')
         AND (s.ends_at IS NULL OR s.ends_at > NOW())
       ORDER BY s.ends_at DESC
       LIMIT 1`,
      [userId]
    );
    if (rows.length) {
      const s = rows[0];
      const tier = s.plan_tier || 'standard';
      return {
        isPremium: true,
        tier,
        planCode: s.plan_code || null,
        expiresAt: s.ends_at || null,
        state: s.state,
        source: s.source || 'payment',
      };
    }
  } catch (e) {
    // subscriptions/plans may not be migrated — fall through to legacy flag.
  }

  // Legacy fallback (pre-enrichment): the is_premium cache + expiry.
  try {
    const [u] = await pool.query(
      'SELECT is_premium, premium_expires_at FROM users WHERE id = ?',
      [userId]
    );
    if (u.length && u[0].is_premium) {
      const exp = u[0].premium_expires_at;
      if (!exp || new Date(exp).getTime() > Date.now()) {
        return { isPremium: true, tier: 'standard', planCode: null, expiresAt: exp || null, state: 'active', source: 'legacy' };
      }
    }
  } catch (_) { /* ignore */ }

  return { isPremium: false, tier: null, planCode: null, expiresAt: null, state: null, source: null };
}

/**
 * Is the caller entitled to play premium content? (legacy convenience wrapper)
 * @param {object} [user] decoded JWT payload from protect (req.user)
 */
async function isEntitled(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const ent = await getEntitlement(user.userId ?? user.id);
  // token_version / status gate is enforced by protect; here we only need entitlement.
  return ent.isPremium && GRANTING_STATES.has(ent.state);
}

/**
 * Phase 7.2 — canWatch(userId, episodeId): the single gate the stream/progress/
 * detail/download routes call.
 * @returns {Promise<{allow, reason, requiredTier, availableAt, isPremium}>}
 *   For a denied premium episode with a future window, availableAt lets the
 *   player show "Free on Aug 15".
 */
async function canWatch(userId, episodeId, { isAdmin = false } = {}) {
  const ent = await getEntitlement(userId);
  return canWatchWithEntitlement(ent, episodeId, isAdmin);
}

/**
 * Internal: canWatch given a resolved entitlement (used when caller already
 * has it, e.g. from /api/auth/me).
 */
async function canWatchWithEntitlement(ent, episodeId, isAdmin = false) {
  let effective = { tier: 'free', availableAt: null };
  try {
    const map = await loadTiers([episodeId]);
    effective = map[episodeId] || { tier: 'free', availableAt: null };
  } catch (e) {
    // fall back to effectiveAccess
    const tier = await effectiveAccess(episodeId);
    effective = { tier, availableAt: null };
  }

  if (effective.tier === 'free') {
    return { allow: true, reason: null, requiredTier: null, availableAt: null, isPremium: ent.isPremium };
  }

  // Premium tier required. Grant when premium + granting state, or admin.
  const granted = (ent && ent.isPremium && GRANTING_STATES.has(ent.state)) || isAdmin;
  if (granted) {
    return { allow: true, reason: null, requiredTier: ent.tier || 'standard', availableAt: null, isPremium: ent.isPremium };
  }

  return {
    allow: false,
    reason: 'PREMIUM_REQUIRED',
    requiredTier: 'premium',
    availableAt: effective.availableAt, // future window, if any → "Free on {date}"
    isPremium: false,
  };
}

/**
 * Mask a single episode's sensitive fields for a non-entitled caller while
 * keeping metadata public (title, thumbnail, number remain visible-but-locked).
 * Mutates and returns the episode object.
 */
async function maskEpisode(episode, user) {
  const { locked } = episode.locked !== undefined
    ? { locked: episode.locked }
    : await canPlay(episode.id, user);
  episode.locked = locked;
  episode.premium = episode.effectiveTier === 'premium' || locked;
  if (locked) {
    // Never leak the raw video source for a locked premium episode.
    if ('video_url' in episode) episode.video_url = null;
    if ('cloudinary_public_id' in episode) episode.cloudinary_public_id = null;
  }
  return episode;
}

/**
 * Legacy convenience: can this user play this episode right now?
 * (canWatch is the authoritative gate for new code.)
 */
async function canPlay(episodeId, user) {
  const userId = user?.userId ?? user?.id;
  const res = await canWatch(userId, episodeId, { isAdmin: !!user?.isAdmin });
  return { allowed: res.allow, tier: res.requiredTier || 'free', locked: !res.allow };
}

module.exports = {
  effectiveAccess,
  isEntitled,
  canPlay,
  maskEpisode,
  getEntitlement,
  canWatch,
  canWatchWithEntitlement,
  GRANTING_STATES,
};