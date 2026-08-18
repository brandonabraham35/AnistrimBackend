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
// Single source of truth for HLS URI detection so the suffix appended to
// proxy URLs can never diverge from the proxy controller's HLS handling.
const { isHlsUri } = require('./hlsRewriter');
// Single source of truth for the playback context (referer/origin/cookies/
// userAgent). Reused so the stored context carries the exact browser-like UA
// and cookie jar the scraper uses — no duplicate cookie/UA logic.
const { getPlaybackContext } = require('../services/animeHeavenProvider');

/**
 * Cosmetic path suffix appended to a proxy URL whose registered target is an
 * HLS playlist (e.g. /api/stream-proxy/<id>/index.m3u8).
 *
 * WHY: players (hls.js gate in the frontend) decide between HLS and native
 * <video> playback by looking for a `.m3u8` hint in the URL. The anonymized
 * /api/stream-proxy/:streamId path carries no extension, so Android/Chrome
 * clients took the native path for an HLS manifest and failed with
 * MEDIA_ERR_SRC_NOT_SUPPORTED ("All available stream sources failed to load")
 * even though the backend resolved the source successfully. Appending a real
 * `.m3u8` segment keeps the URL anonymous (streamId + token still gate it)
 * while letting ANY client — including already-installed apps — detect HLS.
 * The proxy route accepts the suffix as an optional, ignored path segment.
 */
const HLS_URL_SUFFIX = '/index.m3u8';

/**
 * Cosmetic path suffix appended to a proxy URL whose registered target is a
 * direct MP4 (e.g. /api/stream-proxy/<id>/index.mp4). Mirror of the HLS
 * `.m3u8` hint for the inverse case.
 *
 * WHY: AnimeHeaven's direct sources are `video.mp4?<signed-token>` — proxied
 * behind an extension-less `/api/stream-proxy/:streamId`. The frontend's
 * attachStreamSource routes ANY extension-less proxy URL through hls.js first
 * (treating it as potentially-HLS). For a direct MP4, hls.js fetches the
 * bytes, fails MANIFEST_PARSE_ERROR, and only a narrow `manifestError` handler
 * recovers — risking a stall/failure before the native MP4 path engages.
 * Appending a real `.mp4` segment lets the frontend classify the source as a
 * direct MP4 and play it natively (no hls.js round-trip), while the URL stays
 * anonymous (streamId + token still gate it). The proxy route accepts the
 * suffix as an ignored path segment (same as `.m3u8`).
 */
const MP4_URL_SUFFIX = '/index.mp4';

/**
 * @param {string|null|undefined} targetUrl - upstream media URL
 * @returns {string} MP4_URL_SUFFIX for direct MP4 targets, HLS_URL_SUFFIX for
 *   HLS playlists, else ''.
 */
function proxyUrlSuffix(targetUrl) {
  if (isHlsUri(targetUrl)) return HLS_URL_SUFFIX;
  // Direct MP4 / track media → append a `.mp4` hint so the frontend plays it
  // natively instead of routing it through hls.js as a would-be manifest.
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(String(targetUrl || ''))) return MP4_URL_SUFFIX;
  return '';
}

/**
 * Normalize the requesting user's identity across all call sites. Guarantees
 * getStream / authorizeStream / rewriteResultToProxy all use the SAME user id
 * so the ctxUserId↔tokUserId comparison in streamProxyController can't mismatch.
 * @param {number|string|null} reqUser - req.user
 * @param {number|string|null} userId - explicit userId override
 * @returns {string|null} normalized user id or null
 */
function resolveUserId(reqUser, userId) {
  const id = userId ?? reqUser?.userId ?? reqUser?.id ?? reqUser ?? null;
  return id === null || id === undefined || id === '' ? null : String(id);
}

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
function rewriteSource(src, userId = null, episodeId = null, ipHash = '') {
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
    userId: userId ?? src.userId ?? null,
    episodeId: episodeId != null ? String(episodeId) : (src.episodeId != null ? String(src.episodeId) : null),
    // ipHash makes the deterministic streamId per-IP for guests (no userId),
    // so a guest on one IP can't reuse another guest's streamId.
    ipHash: ipHash || src.ipHash || '',
  });
  if (!streamId) {
    logger.warn('[streamProxy] Failed to register source context', { url: src.url });
    return null;
  }
  return {
    // HLS targets get a cosmetic `/index.m3u8` segment so clients can detect
    // HLS from the URL (see proxyUrlSuffix). Non-HLS targets stay extension-less.
    url: `${PROXY_BASE}/${streamId}${proxyUrlSuffix(src.url)}`,
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
function rewriteResultToProxy(result, userId = null, episodeId = null, ipHash = '') {
  if (!result || !Array.isArray(result.sources)) return result;

  const rewritten = [];
  for (const src of result.sources) {
    if (isAnimeHeavenSource(src)) {
      const safe = rewriteSource(src, userId, episodeId, ipHash);
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
  HLS_URL_SUFFIX,
  MP4_URL_SUFFIX,
  proxyUrlSuffix,
  isAnimeHeavenSource,
  rewriteSource,
  rewriteResultToProxy,
  // Normalizes the requesting user's identity across all call sites so
  // getStream/authorizeStream/rewriteResultToProxy can't use different ids.
  resolveUserId,
};
