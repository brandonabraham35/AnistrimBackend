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
//
// Prompt 4: FAIL CLOSED. Every unresolved case (unknown episode id, failed
// anime JOIN, unmigrated column, query failure) must DENY with reason
// 'ACCESS_UNKNOWN' — never grant.
//
// Prompt 6: maskEpisode / maskEpisodes emit effectiveTier, locked, availableAt,
// AND accessState so the frontend can distinguish:
//   free / premium / premium_required / subscription_expired / in_grace / scheduled
// The frontend reads ONLY these fields — never is_premium, never localStorage,
// never a JWT claim. Frontend gating is cosmetic only; the server is the boundary.
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
 * Effective access tier for a single episode: 'free' | 'premium' | 'unknown'.
 * Prompt 4: FAIL CLOSED — an unknown episode id or a failed query returns
 * 'unknown' (deny), never 'free'.
 */
async function effectiveAccess(episodeId) {
  if (episodeId === undefined || episodeId === null) return 'unknown';
  try {
    const map = await loadTiers([episodeId]);
    if (!map[episodeId]) {
      console.warn('[EpisodeAccess] effectiveAccess: episode not found (fail closed)', { episodeId });
      return 'unknown';
    }
    return map[episodeId].tier;
  } catch (e) {
    console.error('[EpisodeAccess] effectiveAccess query failed (fail closed):', e.message);
    return 'unknown';
  }
}

/**
 * Phase 7.2 — getEntitlement(userId): server-authoritative entitlement from the
 * subscriptions + plans read path. users.is_premium is a derived cache only and
 * is NEVER read for authorization.
 *
 * Prompt 4: Distinguish "table not migrated" from "query failed":
 *   - Table not migrated (ER_BAD_TABLE_ERROR / ER_NO_SUCH_TABLE) → fall back to
 *     the legacy users.is_premium flag (documented migration step).
 *   - Any other query failure → DENY (return isPremium:false, error set).
 *
 * Prompt 6: also returns hasExpiredSubscription so the frontend can distinguish
 * "subscription expired" from "never had premium" for the UI state.
 *
 * @param {number|string} userId
 * @returns {Promise<{isPremium, tier, planCode, expiresAt, state, source, hasExpiredSubscription?, error?}>}
 */
async function getEntitlement(userId) {
  if (userId === undefined || userId === null) {
    return { isPremium: false, tier: null, planCode: null, expiresAt: null, state: null, source: null, hasExpiredSubscription: false };
  }

  // Admin users always have premium access (authoritative from user_roles table).
  try {
    const { hasRole } = require('./hasRole');
    const isAdmin = await hasRole(userId, 'admin');
    if (isAdmin) {
      return { isPremium: true, tier: 'admin', planCode: null, expiresAt: null, state: 'active', source: 'admin', hasExpiredSubscription: false };
    }
  } catch (_) { /* non-fatal — fall through to subscription check */ }

  try {
    // Prefer the enriched subscriptions read path (plan joined).
    // Prompt 4: ORDER BY s.ends_at IS NULL DESC puts lifetime (NULL ends_at)
    // subscriptions FIRST — a NULL ends_at (lifetime) must not lose to a
    // nearly-expired one.
    const [rows] = await pool.query(
      `SELECT s.state, s.source, s.ends_at, p.code AS plan_code, p.tier AS plan_tier
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ?
         AND s.state IN ('trialing','active','grace')
         AND (s.ends_at IS NULL OR s.ends_at > NOW())
       ORDER BY s.ends_at IS NULL DESC, s.ends_at DESC
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
        hasExpiredSubscription: false,
      };
    }
  } catch (e) {
    // Prompt 4: Distinguish "table not migrated" from "query failed".
    const isMissingTable =
      e.code === 'ER_BAD_TABLE_ERROR' ||
      e.code === 'ER_NO_SUCH_TABLE' ||
      (e.message && /doesn't exist|Unknown column/i.test(e.message));
    if (isMissingTable) {
      console.warn('[EpisodeAccess] subscriptions/plans not migrated — falling back to legacy flag.');
    } else {
      // Any other query failure → DENY. Do NOT fall back to the legacy flag.
      console.error('[EpisodeAccess] getEntitlement query failed (deny):', e.message);
      return { isPremium: false, tier: null, planCode: null, expiresAt: null, state: null, source: null, hasExpiredSubscription: false, error: 'ENTITLEMENT_QUERY_FAILED' };
    }
  }

  // Prompt 6: detect an expired/cancelled subscription so the UI can show
  // "Subscription expired" instead of "Premium required".
  let hasExpiredSubscription = false;
  try {
    const [expRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM subscriptions
       WHERE user_id = ? AND state IN ('expired','cancelled','refunded')`,
      [userId]
    );
    hasExpiredSubscription = (expRows[0]?.c || 0) > 0;
  } catch (_) { /* non-fatal */ }

  // Legacy fallback (pre-enrichment): the is_premium cache + expiry.
  // Prompt 4: This is the documented migration step — once v35 is applied,
  // this fallback is never reached because the subscriptions query succeeds.
  try {
    const [u] = await pool.query(
      'SELECT is_premium, premium_expires_at FROM users WHERE id = ?',
      [userId]
    );
    if (u.length && u[0].is_premium) {
      const exp = u[0].premium_expires_at;
      if (!exp || new Date(exp).getTime() > Date.now()) {
        return { isPremium: true, tier: 'standard', planCode: null, expiresAt: exp || null, state: 'active', source: 'legacy', hasExpiredSubscription };
      }
      // Legacy premium expired → treat as subscription-expired.
      hasExpiredSubscription = true;
    }
  } catch (_) { /* ignore */ }

  return { isPremium: false, tier: null, planCode: null, expiresAt: null, state: null, source: null, hasExpiredSubscription };
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
 *
 * Prompt 4: FAIL CLOSED. A missing tier map entry (unknown episode id, failed
 * anime JOIN, unmigrated column) returns deny with reason 'ACCESS_UNKNOWN'.
 */
async function canWatchWithEntitlement(ent, episodeId, isAdmin = false) {
  let effective = { tier: 'unknown', availableAt: null };
  try {
    const map = await loadTiers([episodeId]);
    if (!map[episodeId]) {
      console.warn('[EpisodeAccess] canWatch: episode not found (fail closed)', { episodeId });
      return {
        allow: false,
        reason: 'ACCESS_UNKNOWN',
        requiredTier: null,
        availableAt: null,
        isPremium: !!(ent && ent.isPremium),
      };
    }
    effective = map[episodeId];
  } catch (e) {
    console.error('[EpisodeAccess] canWatch: loadTiers failed (fail closed):', e.message);
    return {
      allow: false,
      reason: 'ACCESS_UNKNOWN',
      requiredTier: null,
      availableAt: null,
      isPremium: !!(ent && ent.isPremium),
    };
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
 * Compute the UI accessState for an episode given its effective tier, whether
 * the caller is entitled, and the entitlement state.
 *
 * Prompt 6: the frontend reads ONLY this + availableAt to render:
 *   free                 — playable, no lock
 *   premium              — playable (user entitled: active/trialing/grace)
 *   premium_required     — locked, user not entitled, no future window
 *   subscription_expired — locked, user's subscription expired
 *   in_grace             — playable, user in grace period
 *   scheduled            — locked, future availableAt → "Free on {date}"
 */
function computeAccessState(effectiveTier, entitled, entState, hasExpiredSubscription, availableAt) {
  // Phase 4 (BUG-6): distinguish 'unknown' (infrastructure/data error) from
  // 'premium' (the content is actually premium). The frontend still shows a
  // locked/gated state, but the label is 'Unavailable' not 'Premium required'.
  if (effectiveTier === 'unknown') return 'unavailable';
  if (effectiveTier === 'free') return 'free';
  if (entitled) {
    return entState === 'grace' ? 'in_grace' : 'premium';
  }
  if (availableAt && new Date(availableAt).getTime() > Date.now()) {
    return 'scheduled';
  }
  if (hasExpiredSubscription) {
    return 'subscription_expired';
  }
  return 'premium_required';
}

/**
 * Mask a single episode's sensitive fields for a non-entitled caller while
 * keeping metadata public (title, thumbnail, number remain visible-but-locked).
 * Mutates and returns the episode object.
 *
 * Prompt 6: emits effectiveTier, locked, availableAt, AND accessState so the
 * frontend never needs is_premium / localStorage / JWT claims.
 */
async function maskEpisode(episode, user) {
  const userId = user?.userId ?? user?.id;
  const isAdmin = !!user?.isAdmin;

  // Load effective tier + availableAt (fail closed → 'unknown').
  let effectiveTier = 'unknown';
  let availableAt = null;
  try {
    const map = await loadTiers([episode.id]);
    if (map[episode.id]) {
      effectiveTier = map[episode.id].tier;
      availableAt = map[episode.id].availableAt;
    }
  } catch (e) {
    console.error('[EpisodeAccess] maskEpisode loadTiers failed (fail closed):', e.message);
  }

  // Compute locked.
  const { locked } = episode.locked !== undefined
    ? { locked: episode.locked }
    : await canPlay(episode.id, user);

  // Get entitlement for accessState.
  const ent = await getEntitlement(userId);
  const entitled = (ent && ent.isPremium && GRANTING_STATES.has(ent.state)) || isAdmin;

  const accessState = computeAccessState(
    effectiveTier,
    entitled,
    ent?.state || null,
    !!(ent && ent.hasExpiredSubscription),
    availableAt
  );

  episode.effectiveTier = effectiveTier;
  episode.availableAt = availableAt;
  episode.locked = locked;
  episode.accessState = accessState;
  episode.premium = effectiveTier === 'premium';

  if (locked) {
    // Never leak the raw video source for a locked premium episode.
    if ('video_url' in episode) episode.video_url = null;
    if ('cloudinary_public_id' in episode) episode.cloudinary_public_id = null;
  }
  return episode;
}

/**
 * Prompt 6: batch mask a list of episodes efficiently (one loadTiers + one
 * getEntitlement). Each episode gets effectiveTier, locked, availableAt,
 * accessState, and premium. Returns a NEW array (does not mutate inputs).
 */
async function maskEpisodes(episodes, user) {
  if (!episodes || !episodes.length) return episodes || [];
  const userId = user?.userId ?? user?.id;
  const isAdmin = !!user?.isAdmin;

  // Batch load tiers.
  const ids = episodes.map(e => e.id);
  let tierMap = {};
  try {
    tierMap = await loadTiers(ids);
  } catch (e) {
    console.error('[EpisodeAccess] maskEpisodes loadTiers failed (fail closed):', e.message);
  }

  // Get entitlement once.
  const ent = await getEntitlement(userId);
  const entitled = (ent && ent.isPremium && GRANTING_STATES.has(ent.state)) || isAdmin;

  return episodes.map(ep => {
    const tierInfo = tierMap[ep.id] || { tier: 'unknown', availableAt: null };
    const effectiveTier = tierInfo.tier;
    const availableAt = tierInfo.availableAt;
    const locked = !(effectiveTier === 'free' || entitled);

    const accessState = computeAccessState(
      effectiveTier,
      entitled,
      ent?.state || null,
      !!(ent && ent.hasExpiredSubscription),
      availableAt
    );

    const masked = { ...ep };
    masked.effectiveTier = effectiveTier;
    masked.availableAt = availableAt;
    masked.locked = locked;
    masked.accessState = accessState;
    masked.premium = effectiveTier === 'premium';

    if (locked) {
      if ('video_url' in masked) masked.video_url = null;
      if ('cloudinary_public_id' in masked) masked.cloudinary_public_id = null;
    }
    return masked;
  });
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
  maskEpisodes,
  getEntitlement,
  canWatch,
  canWatchWithEntitlement,
  computeAccessState,
  GRANTING_STATES,
};