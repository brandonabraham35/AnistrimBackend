// utils/episodeAccess.js — P2: server-side episode access authority.
//
// Effective access is computed by the single SQL function
// episode_effective_access(episode_id) created in migrations_v28_premium_access.sql
// (inherit -> anime tier; explicit; premium with premium_until < NOW() -> free).
// This helper wraps it and decides whether the requester may play a locked
// episode. MySQL has no Postgres RLS, so enforcement is here: watch/stream/detail
// endpoints call canPlay() / maskEpisode() before exposing a video source.
const pool = require('../config/db');

/**
 * Effective access tier for an episode: 'free' | 'premium'.
 * Uses the DB function so the fallthrough logic lives in exactly one place.
 */
async function effectiveAccess(episodeId) {
  if (episodeId === undefined || episodeId === null) return 'premium';
  try {
    const [rows] = await pool.query('SELECT episode_effective_access(?) AS tier', [episodeId]);
    return (rows[0] && rows[0].tier) || 'free';
  } catch (e) {
    // Function not migrated yet (column missing) — fall back to legacy is_premium.
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