// =============================================================
//  utils/streamProxy.js — AnimeHeaven Stream → Secure Proxy Rewriter
//
//  PURPOSE:
//    Registers each AnimeHeaven source's playback context (targetUrl,
//    referer, origin, cookies, headers) in the in-memory
//    streamProxyStore, then returns an ANONYMIZED, same-origin proxy
//    URL (/api/stream-proxy/:streamId) that the browser can actually
//    play. Hotlink-protected AnimeHeaven CDNs require the cookie/
//    referer/origin context the scraper established server-side; by
//    routing playback through our proxy, the browser never needs (or
//    sees) those secrets.
//
//  SECURITY:
//    • Cookies/referers/origins/target URLs NEVER leave the server.
//    • The browser only ever receives /api/stream-proxy/:streamId.
//    • The proxy validates the streamId and confines every request to
//      the CDN host registered in the original context.
//    • Only the AnimeHeaven provider (which carries context) is
//      rewritten. Anonymous providers (Consumet, etc.) pass through
//      untouched — their behavior is unchanged.
//
//  HLS:
//    A source whose URL ends in .m3u8 is a manifest. The proxy's
//    manifest rewriter will translate every child URI (variant
//    playlists, segments, audio/subtitle playlists, key URIs) into
//    /api/stream-proxy/:streamId?url=<encoded> so all subsequent
//    requests also flow through the proxy. The host restriction is
//    enforced per-request via streamProxyStore.isHostAllowed().
// =============================================================
'use strict';

const streamProxyStore = require('./streamProxyStore');
const logger = require('./logger');
// Single source of truth for the playback context (referer/origin/cookies/
// userAgent). Reused so the stored context carries the exact browser-like UA
// and cookie jar the scraper uses — no duplicate cookie/UA logic.
const { getPlaybackContext } = require('../services/animeHeavenProvider');

/**
 * The mount point of the proxy route (must match routes/streamProxyRoutes.js).
 */
const PROXY_BASE = '/api/stream-proxy';

/**
 * True when a source carries server-side playback context (i.e. it is an
 * AnimeHeaven source that must be proxied). Anonymous sources (Consumet,
 * hosted, static CDN links) have no referer/origin/cookies and pass through.
 *
 * @param {object} src - normalized source { url, quality, referer, origin, cookies }
 * @returns {boolean}
 */
function isAnimeHeavenSource(src) {
  return !!(
    src &&
    src.url &&
    (/^https?:\/\//i.test(src.url)) &&
    (src.referer || src.origin || src.cookies || src.headers)
  );
}

/**
 * Register a single source's context and return a sanitized proxy URL.
 *
 * @param {object} src - normalized source with context
 * @param {number|string|null} userId - optional id of the requesting user
 * @returns {{ url: string, quality: string, sourceType: string|null }|null}
 *   A sanitized source object whose url is the proxy endpoint, or null on failure.
 */
function rewriteSource(src, userId = null, episodeId = null) {
  // Resolve the authoritative playback context (referer/origin/cookies/
  // userAgent) from the provider so the stored context always carries the
  // exact headers the CDN expects — reusing the provider's cookie jar.
  const playback = getPlaybackContext(src.url, src.referer || null);
  const streamId = streamProxyStore.store({
    targetUrl: src.url,
    referer: src.referer || playback.referer || null,
    origin: src.origin || playback.origin || null,
    cookies: src.cookies || playback.cookies || null,
    userAgent: src.userAgent || playback.userAgent || null,
    headers: src.headers || null,
    userId,
    episodeId,
  });
  if (!streamId) {
    logger.warn('[streamProxy] Failed to register source context', { url: src.url });
    return null;
  }
  return {
    url: `${PROXY_BASE}/${streamId}`,
    quality: src.quality || 'auto',
    sourceType: src.sourceType || null,
    proxied: true,
  };
}

/**
 * Rewrite an entire provider result so that every AnimeHeaven source becomes
 * a sanitized proxy URL and the top-level streamUrl points at the proxy too.
 *
 * Context fields (referer/origin/cookies/headers) are deliberately NOT copied
 * into the returned structure — they live only in the streamProxyStore.
 *
 * Sources without context (anonymous providers) are returned unchanged, so
 * Consumet/KickAssAnime/AnimeKai/AnimePahe/AnimeSaturn/AnimeUnity/AnimeSama/
 * Hianime behavior is completely untouched.
 *
 * @param {object|null} result - normalized provider result
 * @param {number|string|null} userId - optional id of the requesting user
 * @returns {object|null} A public-safe result, or null if all proxied sources failed.
 */
function rewriteResultToProxy(result, userId = null, episodeId = null) {
  if (!result || !Array.isArray(result.sources)) return result;

  const rewritten = [];
  for (const src of result.sources) {
    if (isAnimeHeavenSource(src)) {
      const safe = rewriteSource(src, userId, episodeId);
      if (safe) rewritten.push(safe);
      // If a single source fails to register, we skip it (fail-soft) rather
      // than dropping the whole result.
    } else {
      // Anonymous source — sanitize just in case (strip any context fields).
      const { referer, origin, cookies, headers, ...publicSrc } = src;
      rewritten.push(publicSrc);
    }
  }

if (rewritten.length === 0) return null;

  // Recompute streamUrl from the first rewritten source (matching the pipeline's
  // "best quality first" ordering already applied by the provider).
  const first = rewritten[0];

  // Preserve the FULL provider result contract. Only the fields that actually
  // change are overridden (streamUrl + sources + subtitles). bestQuality, tier,
  // subtitleMode, externalTracks and any future provider metadata are carried
  // through unchanged so the /api/stream response stays backwards-compatible.
  return {
    ...result,
    provider: result.provider,
    streamUrl: first.url,
    sources: rewritten,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

module.exports = {
  PROXY_BASE,
  isAnimeHeavenSource,
  rewriteSource,
  rewriteResultToProxy,
};
