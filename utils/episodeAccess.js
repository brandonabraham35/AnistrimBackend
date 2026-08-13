// utils/episodeAccess.js — P2: server-side episode access authority.
//
// Effective access is computed HERE (application layer) from the schema added by
// migrations_v28_premium_access.sql. This avoids a MySQL stored function, which
// many migration runners can't apply (DELIMITER / CREATE FUNCTION are rejected).
// The single source of truth for the fallthrough logic is this file, reused by
// watch/stream/detail endpoints:
//   • episode INHERIT                       -> anime.access_tier
//   • episode FREE                          -> free
//   • episode PREMIUM + premium_until NULL  -> premium (permanent)
//   • episode PREMIUM + premium_until < NOW -> free (expired => free everywhere)
const pool = require('../config/db');

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
    if (r.e_tier === 'premium') {
      tier = 'premium';
      if (r.e_until && new Date(r.e_until).getTime() <= now) tier = 'free'; // expired
    } else if (r.e_tier === 'free') {
      tier = 'free';
    } else { // inherit
      tier = r.a_tier === 'premium' ? 'premium' : 'free';
    }
    map[r.id] = tier;
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
    return map[episodeId] || 'free';
  } catch (e) {
    // Columns not migrated yet — fall back to legacy is_premium.
    try {
      const [rows] = await pool.query('SELECT is_premium FROM episodes WHERE id = ?', [episodeId]);
      return (rows.length && rows[0] && rows[0].is_premium) ? 'premium' : 'free';
    } catch (_) { return 'free'; }
  }
}

/**
 * Is the caller entitled to play premium content?
 * @param {object} [user] decoded JWT payload from protect (req.user)
 */
async function isEntitled(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.isPremium) return true;
  // Server-authoritative premium check (the JWT claim can be stale).
  try {
    const [rows] = await pool.query(
      'SELECT is_premium, premium_expires_at FROM users WHERE id = ?',
      [user.userId ?? user.id]
    );
    const u = rows[0];
    if (!u) return false;
    if (u.is_premium) {
      if (u.premium_expires_at && new Date(u.premium_expires_at).getTime() <= Date.now()) return false;
      return true;
    }
  } catch (_) { /* fall through: rely on JWT claim already handled above */ }
  return false;
}

/**
 * Can this user play this episode right now?
 */
async function canPlay(episodeId, user) {
  const tier = await effectiveAccess(episodeId);
  if (tier === 'free') return { allowed: true, tier: 'free', locked: false };
  const entitled = await isEntitled(user);
  return { allowed: entitled, tier: 'premium', locked: !entitled };
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

module.exports = { effectiveAccess, isEntitled, canPlay, maskEpisode };