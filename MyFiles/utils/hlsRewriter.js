// =============================================================
//  utils/hlsRewriter.js — Production-grade HLS Manifest Rewriter
//
//  PURPOSE:
//    Single source of truth for HLS (HTTP Live Streaming) manifest
//    rewriting across the entire backend. Both playback proxies
//    (controllers/streamProxyController.js and
//    controllers/streamProxyQueryController.js) previously maintained
//    their OWN copy of this logic, which could diverge. This module
//    centralises it so every child URI in a downloaded manifest is
//    translated to a proxy URL that flows back through the backend.
//
//  WHAT IT REWRITES:
//    • Variant playlists      (#EXT-X-STREAM-INF -> following URI line)
//    • Media playlists        (#EXTINF -> segment URI, incl. TS/fMP4)
//    • Audio/Subtitle playlists (#EXT-X-MEDIA URI="...")
//    • Encryption key URIs    (#EXT-X-KEY URI="...", #EXT-X-SESSION-KEY)
//    • init segments          (#EXT-X-MAP URI="..." [BYTERANGE])
//    • LL-HLS                 (#EXT-X-PART URI="...", #EXT-X-PRELOAD-HINT,
//                              #EXT-X-RENDITION-REPORT URI="...")
//    • Byte-range segments    (#EXT-X-BYTERANGE -> following URI line)
//    • I-frame playlists      (#EXT-X-I-FRAME-STREAM-INF URI="...")
//    • Date-range ad markers  (#EXT-X-DATERANGE END-DATE... URI="...")
//
//  SUPPORTED URL FORMS:
//    relative ("seg.ts", "../seg.ts", "/seg.ts", "?token=abc", "seg.ts#frag")
//    absolute ("https://cdn.example.com/seg.ts?token=abc")
//    query strings / tokenized / signed URLs (preserved & encoded)
//
//  EXPLICITLY NOT REWRITTEN (left untouched / pass-through):
//    data:, blob:, javascript:, mailto: URIs
//
//  DESIGN:
//    • Pure line-based transform — every non-URI line (tags, comments,
//      blank lines) is emitted VERBATIM so HLS syntax is never broken.
//    • A pluggable proxyUrlBuilder(absUrl) callback lets each caller
//      decide the exact proxy URL shape:
//        - streamProxyController has a streamId-scoped route
//        - streamProxyQueryController has a stateless query route
//    • No HTTP logic, no controller logic, no logging dependency —
//      pure, deterministic, unit-testable.
// =============================================================
'use strict';

// HLS MIME types that identify a downloaded body as a manifest. Detection is
// used by the proxy controllers to decide whether to treat a response as text
// (manifest rewrite) or as a byte stream (segment/MP4).
const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/x-mpegURL',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

// URI schemes that must NEVER be rewritten (pass through untouched). Only
// http(s) resources and relative paths are proxied.
const NON_REWRITABLE_SCHEME = /^([a-z][a-z0-9+.-]*:)/i;

// Tag attribute lines that embed a URI="..." (or URI=...) reference and must
// have that URI rewritten in-place. Note the HLS tag prefix is "#EXT-X-..."
// (the "-X-" is literal), so we must match "#EXT-X-" — the old "#EXT:" form
// never matched and silently skipped these lines.
const URI_ATTRIBUTE_LINE = /^#EXT-X-(MEDIA|KEY|SESSION-KEY|MAP|PART|PRELOAD-HINT|RENDITION-REPORT|I-FRAME-STREAM-INF|DATERANGE):/i;

// Tag header lines that are FOLLOWED by a bare URI line (variant playlist,
// media segment, or byte-range segment).
const URI_FOLLOWING_LINE = /^#EXT-X-(STREAM-INF|INF|BYTERANGE):/i;

/**
 * Resolve a URI reference against a base URL (RFC 3986, exactly as an HLS
 * client would). Handles relative, root-relative, query-only, fragment-only,
 * and absolute URIs. Preserves query strings and fragments. Falls back to the
 * raw string if the base cannot be parsed.
 *
 * @param {string} base - absolute URL of the manifest
 * @param {string} uri - the URI reference to resolve
 * @returns {string} absolute URL (or the raw uri on failure)
 */
function resolveUri(base, uri) {
  if (!uri) return uri;
  try {
    return new URL(String(uri), base).toString();
  } catch {
    return String(uri);
  }
}

/**
 * True when a URL looks like an HLS manifest (ends in .m3u8, ignoring a
 * trailing query string / fragment). Used as a fallback when no Content-Type
 * is available (or when the remote server mislabels the response).
 *
 * @param {string} url - the target URL
 * @returns {boolean}
 */
function isHlsUri(url) {
  if (!url) return false;
  // Strip query string + fragment before matching the extension.
  const path = String(url).split(/[?#]/)[0];
  return /\.m3u8$/i.test(path);
}

/**
 * True when a Content-Type header identifies an HLS manifest.
 * Supports the Apple, generic x-mpegurl, and audio flavours.
 *
 * @param {string} contentType - the upstream Content-Type header value
 * @returns {boolean}
 */
function isHlsContentType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  return HLS_CONTENT_TYPES.includes(type);
}

/**
 * Decide whether a raw URI reference should be rewritten to the proxy.
 * Returns true for http(s) absolute URLs and relative references. Returns
 * false for data:/blob:/javascript:/mailto: and other non-http schemes.
 *
 * @param {string} uri - the URI reference to test
 * @returns {boolean}
 */
function shouldRewriteUrl(uri) {
  if (!uri) return false;
  const value = String(uri).trim();
  if (!value) return false;
  // Data and blob URIs are browser-session scoped — never proxy them.
  if (/^data:/i.test(value)) return false;
  if (/^blob:/i.test(value)) return false;
  // Never proxy our own local API paths. These are already same-origin proxy
  // URLs (or local assets) and must be left untouched — this also makes the
  // rewriter idempotent (an already-rewritten manifest is a no-op).
  if (/^\/api\//i.test(value)) return false;
  // Only http(s) and relative references are rewriteable.
  const schemeMatch = value.match(NON_REWRITABLE_SCHEME);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    return scheme === 'http:' || scheme === 'https:';
  }
  return true; // no scheme → relative reference
}

/**
 * Rewrite an HLS manifest so every child request flows through the proxy.
 *
 * This is the ONLY implementation of HLS manifest rewriting in the project.
 * Both proxy controllers call this with their own proxyUrlBuilder.
 *
 * @param {string} manifestBody - raw HLS manifest text
 * @param {string} manifestUrl - absolute URL of the manifest (resolution base)
 * @param {Function} proxyUrlBuilder - (absUrl) => proxyUrl string
 * @returns {string} rewritten manifest
 */
function rewriteHlsManifest(manifestBody, manifestUrl, proxyUrlBuilder) {
  if (typeof proxyUrlBuilder !== 'function') {
    throw new TypeError('rewriteHlsManifest: proxyUrlBuilder must be a function.');
  }

  const raw = String(manifestBody || '');
  const lines = raw.split(/\r?\n/);
  const base = manifestUrl;
  let rewritten = 0;

  const rewriteUri = (uri) => {
    if (!shouldRewriteUrl(uri)) return uri;
    const abs = resolveUri(base, uri);
    rewritten += 1;
    return proxyUrlBuilder(abs);
  };

// Rewrite URI="..." attributes on a tag line. Handles both quoted and
  // unquoted URI= attribute forms (some producers emit URI=path without
  // quotes in STREAM-INF / KEY / MAP / PART tags). A single-pass alternation
  // guarantees an already-rewritten URI is never re-matched by a second pass
  // (which would corrupt it and double-count it).
  const rewriteAttributeLine = (line) => {
    return line.replace(/URI\s*=\s*("([^"]*)"|([^\s,]+))/gi, (m, quoted, quotedUri, unquotedUri) => {
      const uri = quotedUri !== undefined ? quotedUri : unquotedUri;
      const rewrittenUri = rewriteUri(uri);
      return quotedUri !== undefined ? `URI="${rewrittenUri}"` : `URI=${rewrittenUri}`;
    });
  };

  const out = lines.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return rawLine; // preserve blank lines exactly

    // 1) Tag lines that embed a URI="..." attribute.
    if (URI_ATTRIBUTE_LINE.test(trimmed)) {
      return rewriteAttributeLine(rawLine);
    }

    // 2) Tag header lines that are followed by a URI line. Keep verbatim;
    //    the NEXT non-comment line is the URI and is handled below.
    if (URI_FOLLOWING_LINE.test(trimmed)) {
      return rawLine;
    }

    // 3) A plain URI line (preceded by a STREAM-INF / INF / BYTERANGE header).
    //    Heuristic: a single non-whitespace token that is not a comment/tag.
    if (/^\S+$/.test(trimmed) && !trimmed.startsWith('#')) {
      return rewriteUri(trimmed);
    }

    // 4) Everything else (comments, other tags, blank lines) — verbatim.
    return rawLine;
  });

  return {
    body: out.join('\n'),
    rewritten,
  };
}

module.exports = {
  rewriteHlsManifest,
  resolveUri,
  isHlsUri,
  isHlsContentType,
  shouldRewriteUrl,
  HLS_CONTENT_TYPES,
};
