// =============================================================
//  utils/streamProxyStore.js — In-Memory Stream Context Store
//
//  PURPOSE:
//    Stores the playback context (target URL, referer, origin,
//    cookies, headers) needed to authorize an AnimeHeaven stream,
//    keyed by a SHORT-LIVED streamId. The streamId is the ONLY
//    thing ever exposed to the browser — cookies, referers,
//    origins, and tokens NEVER leave the server.
//
//  DESIGN:
//    • TTL-based expiry (default 8 minutes) so stale contexts are
//      automatically reclaimed.
//    • Last-access tracking so inactive contexts are removed.
//    • Maps streamId → { targetUrl, host, referer, origin, cookies,
//      headers, userId, createdAt, lastAccessAt, hits }.
//    • userId (optional) binds the ticket to the verified user who
//      requested the stream — defense-in-depth so a shared/scraped
//      streamId cannot be silently replayed by another account.
//    • Pure in-memory (no disk). Single-process assumption is fine
//      for this backend (Render single instance).
// =============================================================
'use strict';

const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_TTL_MS = Number(process.env.STREAM_PROXY_TTL_MS || 8 * 60 * 1000); // 8 min
const MAX_CONTEXTS = Number(process.env.STREAM_PROXY_MAX_CONTEXTS || 5000);
const SWEEP_INTERVAL_MS = 60 * 1000; // sweep expired once per minute

const contexts = new Map(); // streamId -> context

/**
 * Generate a short, unguessable stream id.
 * @returns {string} A 24-char url-safe token
 */
function generateStreamId() {
  return crypto.randomBytes(18).toString('hex'); // 36 hex chars
}

/**
 * Derive a DETERMINISTIC stream id for the same (targetUrl, userId, episodeId).
 * This is the key fix for the token/streamId binding race: POST /api/stream/
 * authorize and GET /api/stream/:title/:ep both call store(), and both MUST
 * produce the SAME streamId for the same source so a token minted by authorize
 * matches the streamId the /api/stream response carries.
 *
 * When userId is absent (guest/anonymous), we key on (targetUrl, episodeId,
 * ipHash) so a guest on one IP is still deterministic per source+episode, but
 * another device/IP cannot reuse the same streamId.
 *
 * @param {object} entry - { targetUrl, userId, episodeId, ipHash }
 * @returns {string} hex sha256 (64 chars) prefixed with 's' to stay url-safe
 */
function deterministicStreamId({ targetUrl, userId, episodeId, ipHash }) {
  const key = [
    'stream',
    String(targetUrl || ''),
    String(userId ?? ''),
    String(episodeId ?? ''),
    String(ipHash || ''),
  ].join('|');
  return 's' + crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Internal sweep: remove expired contexts and enforce the max-size cap.
 * Called periodically and opportunistically on writes.
 */
function sweep() {
  const now = Date.now();
  for (const [id, ctx] of contexts) {
    if (!ctx || now - ctx.lastAccessAt > DEFAULT_TTL_MS || now - ctx.createdAt > DEFAULT_TTL_MS) {
      contexts.delete(id);
    }
  }
  // Enforce cap (drop oldest by lastAccessAt if over cap)
  if (contexts.size > MAX_CONTEXTS) {
    const sorted = [...contexts.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    const toRemove = sorted.slice(0, contexts.size - MAX_CONTEXTS);
    for (const [id] of toRemove) contexts.delete(id);
  }
}

// Start periodic sweeper.
const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
if (sweeper.unref) sweeper.unref();
sweeper._anistrim = true;

/**
 * Register a stream context and return its short streamId.
 * @param {object} entry - { targetUrl, host, referer, origin, cookies, headers, userId }
 * @returns {string} streamId
 */
function store(entry = {}) {
  const targetUrl = String(entry.targetUrl || '');
  if (!targetUrl) return null;

  let host = entry.host || null;
  if (!host) {
    try {
      host = new URL(targetUrl).host;
    } catch {
      host = null;
    }
  }

  // ── DETERMINISTIC streamId + idempotent registration ──────────
  // Reuse an existing context for the same (targetUrl, userId, episodeId)
  // instead of minting a brand-new streamId on every call. This guarantees
  // authorize and /api/stream produce the SAME streamId for the same source,
  // so the token bound to that streamId verifies at the proxy.
  const streamId = deterministicStreamId({
    targetUrl,
    userId: entry.userId ?? null,
    episodeId: entry.episodeId ?? null,
    ipHash: entry.ipHash || '',
  });

  const now = Date.now();
  const existing = contexts.get(streamId);
  if (existing) {
    // Refresh lastAccessAt + hits, and update the live playback context
    // (cookies/referer/origin can rotate) so we always proxy with fresh data.
    existing.targetUrl = targetUrl;
    existing.host = host || existing.host;
    existing.referer = entry.referer || existing.referer;
    existing.origin = entry.origin || existing.origin;
    if (entry.cookies) existing.cookies = entry.cookies;
    if (entry.userAgent) existing.userAgent = entry.userAgent;
    if (entry.headers) existing.headers = entry.headers;
    existing.userId = entry.userId || existing.userId;
    existing.episodeId = entry.episodeId || existing.episodeId;
    if (entry.ipHash) existing.ipHash = String(entry.ipHash);
    existing.lastAccessAt = now;
    existing.hits += 1;
    return streamId;
  }

  contexts.set(streamId, {
    targetUrl,
    host,
    referer: entry.referer || null,
    origin: entry.origin || null,
    cookies: entry.cookies || null,
    userAgent: entry.userAgent || null,
    headers: entry.headers || null,
    userId: entry.userId || null,
    episodeId: entry.episodeId || null,
    ipHash: entry.ipHash ? String(entry.ipHash) : undefined,
    createdAt: now,
    lastAccessAt: now,
    hits: 0,
  });

  sweep(); // opportunistic cleanup
  return streamId;
}

/**
 * Retrieve a context by streamId, refreshing its lastAccessAt.
 * Returns null if unknown or expired.
 * @param {string} streamId
 * @returns {object|null}
 */
function get(streamId) {
  if (!streamId) return null;
  const ctx = contexts.get(streamId);
  if (!ctx) return null;
const now = Date.now();
  if (now - ctx.lastAccessAt > DEFAULT_TTL_MS || now - ctx.createdAt > DEFAULT_TTL_MS) {
    contexts.delete(streamId);
    return null;
  }
  ctx.lastAccessAt = now;
  ctx.hits += 1;
  return ctx;
}

/**
 * Remove a context by streamId (e.g. after a terminal error or explicit release).
 * @param {string} streamId
 */
function remove(streamId) {
  if (!streamId) return;
  contexts.delete(streamId);
}

/**
 * Validate that a requested target URL host matches the stored host.
 * Prevents open-proxy abuse: a caller holding a valid streamId may only
 * fetch resources on the SAME host as the original context target.
 * @param {object} ctx - context from get()
 * @param {string} candidateUrl - URL the caller wants to fetch
 * @returns {boolean}
 */
function isHostAllowed(ctx, candidateUrl) {
  if (!ctx || !ctx.host) return false;
  try {
    return new URL(candidateUrl).host === ctx.host;
  } catch {
    return false;
  }
}

/**
 * Return all active context streamIds registered for a given userId + episodeId.
 * Used by /api/stream/authorize to mint tokens bound to the REAL streamIds that
 * were registered when the stream was resolved (via rewriteResultToProxy →
 * store()). This is the fix for the P0 where authorize invented a phantom
 * randomUUID() that never matched a registered context.
 *
 * @param {number|string} userId - the owning user id (string-normalized)
 * @param {number|string} episodeId - the episode id (string-normalized)
 * @returns {{streamId: string, userId: string, episodeId: string}[]}
 */
function getByUserEpisode(userId, episodeId) {
  const wantUser = String(userId ?? '');
  const wantEp = String(episodeId ?? '');
  if (!wantUser || !wantEp) return [];
  const out = [];
  const now = Date.now();
  for (const [streamId, ctx] of contexts) {
    if (!ctx) continue;
    if (now - ctx.lastAccessAt > DEFAULT_TTL_MS || now - ctx.createdAt > DEFAULT_TTL_MS) continue; // expired
    if (String(ctx.userId ?? '') === wantUser && String(ctx.episodeId ?? '') === wantEp) {
      out.push({ streamId, userId: wantUser, episodeId: wantEp });
    }
  }
  return out;
}

/**
 * Return all active context streamIds registered for a GUEST (no userId) with
 * the given episodeId + ipHash. Because guest streamIds are deterministic
 * (targetUrl + '' + episodeId + ipHash) but we can't backward-derive them from
 * a URL, we scan the store and match on (episodeId, ipHash, no userId).
 *
 * @param {number|string} episodeId - the episode id (string-normalized)
 * @param {string} ipHash - the anonymous user's ipHash
 * @returns {string[]} matching streamIds
 */
function getByIpEpisode(episodeId, ipHash) {
  const wantEp = String(episodeId ?? '');
  const wantIp = String(ipHash || '');
  if (!wantEp || !wantIp) return [];
  const out = [];
  const now = Date.now();
  for (const [streamId, ctx] of contexts) {
    if (!ctx) continue;
    if (now - ctx.lastAccessAt > DEFAULT_TTL_MS || now - ctx.createdAt > DEFAULT_TTL_MS) continue; // expired
    if (!ctx.userId && String(ctx.episodeId ?? '') === wantEp && String(ctx.ipHash || '') === wantIp) {
      out.push(streamId);
    }
  }
  return out;
}

/**
 * Get the number of currently stored contexts (observability).
 * @returns {number}
 */
function size() {
  return contexts.size;
}

/**
 * Clear all contexts (testing / admin).
 */
function clear() {
  contexts.clear();
}

// Stop the sweeper interval on process exit to allow clean shutdown.
process.on('exit', () => {
  if (sweeper && sweeper._anistrim && typeof sweeper.unref === 'function') clearInterval(sweeper);
});

module.exports = {
  store,
  get,
  remove,
  isHostAllowed,
  getByUserEpisode,
  getByIpEpisode,
  deterministicStreamId,
  size,
  clear,
  DEFAULT_TTL_MS,
};
