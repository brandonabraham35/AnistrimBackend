// =============================================================
//  utils/streamProxyHeaders.js — Shared Playback-Proxy Header Helpers
//
//  PURPOSE:
//    Single source of truth for the upstream headers the reverse
//    proxies (controllers/streamProxyController.js and
//    controllers/streamProxyQueryController.js) inject when fetching
//    hotlink-protected AnimeHeaven media. This module consolidates the
//    header logic that was previously duplicated across both proxy
//    controllers so the two code paths can never diverge.
//
//  GUARANTEED UPSTREAM HEADERS:
//    • User-Agent      — browser-like UA (from playback context, then
//                        PLAYBACK_USER_AGENT, then a last-resort fallback)
//    • Accept          — forwarded from the client (default '*/*')
//    • Accept-Encoding — forwarded from the client (default 'identity')
//    • Connection      — forwarded from the client (default 'keep-alive')
//    • Referer         — when present in the playback context (hotlink auth)
//    • Origin          — when present in the playback context (hotlink auth)
//    • Cookie          — when present in the playback context (hotlink auth)
//    • Range           — forwarded from the client for seeking/byte-range
//
//  NOTE: Referer/Origin/Cookie/Range are only emitted when a real value
//  exists — we never fabricate authorizing headers. For AnimeHeaven the
//  playback context (built via getPlaybackContext()) always carries them.
//
//  SECURITY:
//    Cookies/referers/origins NEVER leave the server; they are only used
//    to build the outgoing upstream request, never returned to the client.
// =============================================================
'use strict';

const { PLAYBACK_USER_AGENT } = require('../services/animeHeavenProvider');

// A realistic browser UA fallback (the provider's PLAYBACK_USER_AGENT is used
// first wherever the playback context is available).
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Resolve the effective browser-like User-Agent for an upstream request.
 * Priority: playback context > stored context > PLAYBACK_USER_AGENT > fallback.
 *
 * @param {object} [playback] - playback context ({ userAgent }) from getPlaybackContext()
 * @param {object} [ctx]      - streamProxyStore context ({ userAgent }) when available
 * @returns {string}
 */
function resolveUserAgent(playback = {}, ctx = {}) {
  return playback.userAgent || ctx.userAgent || PLAYBACK_USER_AGENT || FALLBACK_UA;
}

/**
 * Build the upstream request headers for a given playback context + client
 * request. Context headers (cookie/referer/origin/UA) take precedence; they
 * are the ones the scraper established. Range/Accept/Accept-Encoding/Connection
 * are forwarded from the browser so seeking + compressed delivery + keep-alive
 * work as expected.
 *
 * @param {object} playback - playback context from getPlaybackContext()
 * @param {object} req      - Express request (for forwarded client headers)
 * @param {object} [ctx]    - optional streamProxyStore context (extra headers / UA fallback)
 * @returns {object} headers object for the upstream request
 */
function buildUpstreamHeaders(playback, req, ctx = {}) {
  const headers = {
    'User-Agent': resolveUserAgent(playback, ctx),
    // Forward the client's desired Accept / Accept-Encoding so compressed
    // delivery and media negotiation work. We relay raw bytes and copy the
    // upstream content-encoding back, so the browser can decode correctly.
    Accept: req.headers.accept || '*/*',
    'Accept-Encoding': req.headers['accept-encoding'] || 'identity',
    Connection: req.headers.connection || 'keep-alive',
  };

  // Forward range for byte-range / seeking support (MP4 + HLS segments).
  if (req.headers.range) headers.Range = req.headers.range;

  // Context headers take precedence (these are the authorizing ones).
  if (playback.referer) headers.Referer = playback.referer;
  if (playback.origin) headers.Origin = playback.origin;
  // Use the freshly-derived cookie from the shared cookie jar when available,
  // otherwise fall back to the cookie captured at store time.
  const cookies = playback.cookies || ctx.cookies;
  if (cookies) headers.Cookie = cookies;

  // Extra headers captured from scraping (if any).
  if (ctx.headers && typeof ctx.headers === 'object') {
    for (const [k, v] of Object.entries(ctx.headers)) {
      if (v && !headers[k]) headers[k] = v;
    }
  }

  return headers;
}

/**
 * Copy a small set of safe response headers from the upstream to the client.
 * HLS/MP4 browsers need Content-Type, Content-Length, Content-Range,
 * Accept-Ranges, Cache-Control, ETag, Last-Modified.
 *
 * @param {object} upstreamHeaders - upstream response .headers
 * @param {object} res - Express response
 */
function copySafeHeaders(upstreamHeaders, res) {
  const safe = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'etag',
    'last-modified',
    'content-disposition',
    'content-encoding',
  ];
  for (const name of safe) {
    const val = upstreamHeaders[name];
    if (val !== undefined && val !== null) {
      res.setHeader(name, val);
    }
  }
}

/**
 * Attach CORS headers required for cross-origin media playback.
 *
 * @param {object} res - Express response
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

module.exports = {
  buildUpstreamHeaders,
  copySafeHeaders,
  setCorsHeaders,
  resolveUserAgent,
  FALLBACK_UA,
};
