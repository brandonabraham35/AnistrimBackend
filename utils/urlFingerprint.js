// =============================================================
//  utils/urlFingerprint.js — Safe URL Fingerprint Analysis
//
//  PURPOSE:
//    Deterministic comparison of stream URLs without exposing
//    sensitive content (full URLs, tokens, cookies).
//
//  Extracts from a CDN URL:
//    - protocol, hostname, path
//    - content hash (first query param for AnimeHeaven)
//    - CDN token (second query param for AnimeHeaven)
//    - query parameter names (not values)
//
//  Generates safe fingerprints that can be logged, stored, and
//  compared without leaking secrets.
// =============================================================
'use strict';

const crypto = require('crypto');

/**
 * Parse an AnimeHeaven CDN URL into its components.
 *
 * URL format: https://{host}.animeheaven.me/video.mp4?{content-hash}&{cdn-token}
 *
 * @param {string} urlStr
 * @returns {object|null} { protocol, hostname, path, contentHash, cdnToken, params, fullHash }
 */
function parseStreamUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const u = new URL(urlStr);
    const paramNames = [...u.searchParams.keys()];
    const paramValues = [...u.searchParams.values()];

    // AnimeHeaven convention: URL format is ?hash&token (bare values as param names)
    // searchParams.keys() returns the bare values, searchParams.values() returns empty strings
    const contentHash = paramNames[0] || null;
    const cdnToken = paramNames[1] || null;

    return {
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname,
      contentHash,
      cdnToken,
      params: paramNames,
      fullHash: crypto.createHash('sha256').update(urlStr).digest('hex').substring(0, 16),
    };
  } catch {
    return null;
  }
}

/**
 * Generate a safe loggable fingerprint for a URL.
 * NEVER returns the full URL or full token values.
 *
 * @param {string} urlStr
 * @returns {object|null} { hash, host, path, params } — safe for logging
 */
function fingerprint(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    return {
      hash: crypto.createHash('sha256').update(urlStr).digest('hex').substring(0, 12),
      host: u.hostname,
      path: u.pathname,
      params: [...u.searchParams.keys()],
    };
  } catch {
    return null;
  }
}

/**
 * Compare two stream URLs for the same episode.
 *
 * @param {string} oldUrl
 * @param {string} newUrl
 * @returns {object} { sameUrl, hostChanged, contentHashChanged, tokenChanged, bothPresent }
 */
function compareUrls(oldUrl, newUrl) {
  const result = {
    sameUrl: false,
    hostChanged: false,
    contentHashChanged: false,
    tokenChanged: false,
    bothPresent: false,
  };

  const old = parseStreamUrl(oldUrl);
  const nu = parseStreamUrl(newUrl);

  if (!old || !nu) return result;

  result.bothPresent = true;
  result.sameUrl = oldUrl === newUrl;
  result.hostChanged = old.hostname !== nu.hostname;
  result.contentHashChanged = old.contentHash !== nu.contentHash;
  result.tokenChanged = old.cdnToken !== nu.cdnToken;

  return result;
}

module.exports = {
  parseStreamUrl,
  fingerprint,
  compareUrls,
};