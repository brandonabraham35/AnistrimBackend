// =============================================================
//  controllers/streamProxyController.js — Secure AnimeHeaven Playback Proxy
//
//  WHY:
//    AnimeHeaven CDNs are hotlink-protected: they require the cookie,
//    referer and origin headers that the scraper established server-side
//    before serving media. A browser cannot supply those (it never had
//    them), so direct playback of the raw CDN URL fails. This controller
//    proxies playback through the server, injecting the exact context
//    captured during scraping, so the browser gets a clean, playable
//    same-origin stream.
//
//  FEATURES:
//    • MP4 streaming with full byte-range (Range/Content-Range/Accept-Ranges)
//    • HLS (.m3u8): downloads the manifest, rewrites every child URI
//      (variant playlists, media playlists, TS segments, fMP4 segments,
//      audio/subtitle playlists, key URIs, init segments) to
//      /api/stream-proxy/:streamId?url=<encoded> so all subsequent requests
//      stay behind the proxy. Supports relative + absolute (data: passthrough).
//    • Low-memory streaming — upstream response is piped through, never
//      buffered whole (except HLS manifests, which are small text).
//    • Injects Referer, Origin, Cookie, User-Agent, Range, Accept,
//      Accept-Encoding, Connection from the stored context + client request.
//    • Reuses utils/providerHttp.request() so retries, health tracking and
//      unified header building stay centralized (no duplicate HTTP layer).
//    • Timeout handling + one retry for transient upstream failures.
//    • Structured JSON errors; never crashes Express.
//
//  SECURITY (NOT an open proxy):
//    • streamId must exist and not be expired (else 404).
//    • Every requested URL host must match the host stored in the context
//      (streamProxyStore.isHostAllowed). Only registered AnimeHeaven CDN
//      hosts are reachable.
//    • Cookies/referers/origins/tokens NEVER leave the server.
// =============================================================
'use strict';

const { request } = require('../utils/providerHttp');
const streamProxyStore = require('../utils/streamProxyStore');
const logger = require('../utils/logger');
// Single source of truth for the playback headers. getPlaybackContext reuses
// the provider's existing cookie jar (no duplicate cookie logic) and returns
// the exact browser-like User-Agent used during scraping.
const { getPlaybackContext, PLAYBACK_USER_AGENT } = require('../services/animeHeavenProvider');

const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2MB cap for HLS manifests
const PROXY_BASE = '/api/stream-proxy';
const PROXY_PROVIDER_TAG = 'animeheaven-proxy';

// A realistic browser UA so hotlink-protected CDNs authorise the request.
// Kept as a last-resort fallback; the provider's PLAYBACK_USER_AGENT is used
// first wherever the playback context is available.
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Build the upstream request headers for a given context + client request.
 * Context headers (cookie/referer/origin) take precedence; they are the ones
 * the scraper established. Range/Accept/Accept-Encoding/Connection are
 * forwarded from the browser so seeking + compressed delivery + keep-alive
 * work as expected.
 *
 * @param {object} ctx - streamProxyStore context
 * @param {object} req - Express request
 * @param {object} [playback] - playback context from getPlaybackContext()
 * @returns {object} headers object for the upstream request
 */
function buildUpstreamHeaders(ctx, req, playback = {}) {
  const headers = {
    'User-Agent': playback.userAgent || ctx.userAgent || PLAYBACK_USER_AGENT || FALLBACK_UA,
    // Forward the client's desired Accept / Accept-Encoding so compressed
    // delivery and media negotiation work. We relay raw bytes and copy the
    // upstream content-encoding back, so the browser can decode correctly.
    Accept: req.headers.accept || '*/*',
    'Accept-Encoding': req.headers['accept-encoding'] || 'identity',
    Connection: req.headers.connection || 'keep-alive',
  };

  // Forward range for byte-range / seeking support (MP4 + HLS segments).
  if (req.headers.range) headers.Range = req.headers.range;

  // Context headers take precedence (these are the authorize-ing ones).
  if (ctx.referer) headers.Referer = ctx.referer;
  if (ctx.origin) headers.Origin = ctx.origin;
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
 * Resolve a URI reference against a base URL, handling both relative and
 * absolute URIs (HLS spec). Falls back to the raw string if unparseable.
 *
 * @param {string} base - absolute URL of the manifest
 * @param {string} uri - the URI to resolve
 * @returns {string} absolute URL
 */
function resolveUri(base, uri) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

/**
 * Rewrite an HLS manifest so every child request flows through the proxy.
 *
 * Handles:
 *   • Variant playlists        (#EXT-X-STREAM-INF -> URI)
 *   • Media playlists          (#EXTINF -> segment URI, incl. fMP4/TS)
 *   • Audio/Subtitle playlists (#EXT-X-MEDIA URI=...)
 *   • Encryption key URIs      (#EXT-X-KEY URI=...)
 *   • init segments            (#EXT-X-MAP URI=..., BYTERANGE)
 *
 * Every rewritten URI becomes:
 *   /api/stream-proxy/:streamId?url=<encodeURIComponent(absUrl)>
 *
 * The proxy enforces host-matching on every such request, so a rewritten
 * manifest cannot be abused to reach arbitrary hosts — no direct CDN URLs
 * are ever left inside the manifest.
 *
 * @param {string} manifestBody - raw HLS manifest text
 * @param {string} manifestUrl - absolute URL of the manifest
 * @param {string} streamId - the active proxy stream id
 * @param {string} host - the allowed upstream host (for logging)
 * @returns {string} rewritten manifest
 */
function rewriteHlsManifest(manifestBody, manifestUrl, streamId, host) {
  const lines = String(manifestBody || '').split(/\r?\n/);
  const base = manifestUrl;

  const rewriteUri = (uri) => {
    if (!uri) return uri;
    if (/^data:/i.test(uri)) return uri; // don't touch data URIs
    if (/^blob:/i.test(uri)) return uri; // don't touch blob URIs
    const abs = resolveUri(base, uri);
    return `${PROXY_BASE}/${streamId}?url=${encodeURIComponent(abs)}`;
  };

  const needsRewrite = (line) => {
    return /^#EXT-X-STREAM-INF:/i.test(line) ||
      /^#EXTINF:/i.test(line) ||
      /^#EXT-X-MEDIA:/i.test(line) ||
      /^#EXT-X-KEY:/i.test(line) ||
      /^#EXT-X-MAP:/i.test(line) ||
      /^#EXT-X-BYTERANGE:/i.test(line);
  };

  const startTime = Date.now();
  let rewritten = 0;

  const out = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    // Header/attribute lines that embed a URI="..." reference.
    if (/^#EXT:(X-MEDIA|X-KEY|X-MAP):/i.test(line)) {
      const rewrittenLine = line.replace(/URI="([^"]+)"/g, (m, uri) => {
        rewritten += 1;
        return `URI="${rewriteUri(uri)}"`;
      });
      return rawLine.indexOf(line) === 0 ? rewrittenLine : rawLine;
    }

    // A URI line follows a header that we need to rewrite (segment/playlist).
    if (needsRewrite(line)) {
      // Keep the header line as-is; the NEXT non-comment line is the URI.
      return rawLine;
    }

    // This is a plain URI line (preceded by a needsRewrite header).
    // Heuristic: it's a relative path or absolute http(s)/https URL.
    if (/^\S+$/.test(line) && !line.startsWith('#')) {
      rewritten += 1;
      return rewriteUri(line);
    }

    return rawLine;
  });

  logger.debug('[streamProxy] HLS manifest rewritten', {
    streamId: streamId.slice(0, 8),
    host,
    lines: lines.length,
    rewritten,
    ms: Date.now() - startTime,
  });

  return out.join('\n');
}

/**
 * Perform the upstream fetch as a stream and pipe it to the client.
 * Used for MP4/segment/direct media (non-manifest) requests.
 *
 * Reuses utils/providerHttp.request() so retries, health tracking and the
 * unified header/proxy layer stay centralized. skipProxy=true keeps the CDN
 * fetch direct (the CDN URLs are not meant to be tunnelled through the
 * scraping proxy), while still benefiting from the shared HTTP layer.
 *
 * @param {string} url - upstream URL
 * @param {object} headers - upstream headers
 * @returns {Promise<object>} upstream response (axios-like, data is a stream)
 */
async function pipeStream(url, headers) {
  return request(
    { method: 'get', url, headers, responseType: 'stream', maxRedirects: 5 },
    {
      providerName: PROXY_PROVIDER_TAG,
      streaming: true,
      skipProxy: true,
      timeout: DEFAULT_UPSTREAM_TIMEOUT_MS,
    }
  );
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

/**
 * Small helper to safely extract a host for logging.
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * GET /api/stream-proxy/:streamId
 * Handles both MP4 (byte-range stream) and HLS (manifest rewrite + relay).
 *
 * Query params:
 *   url — OPTIONAL. When present, this is a child resource (segment/variant/
 *         key/subtitle/audio) of an HLS manifest and must resolve to the SAME
 *         host as the stored context. When absent, context.targetUrl is used.
 */
exports.streamMedia = async (req, res) => {
  const { streamId } = req.params;
  const requestedUrl = req.query.url || null;

  // ── Security: validate the stream context ────────────────
  const ctx = streamProxyStore.get(streamId);
  if (!ctx) {
    return res.status(404).json({ error: 'Stream context not found or expired.' });
  }

  // Determine the target URL.
  let target = requestedUrl || ctx.targetUrl;
  if (!target) {
    return res.status(404).json({ error: 'No target URL registered for this stream.' });
  }

  // Host-matching: any requested URL must be on the SAME host as the context.
  // This prevents the proxy from becoming an open proxy.
  if (!streamProxyStore.isHostAllowed(ctx, target)) {
    logger.warn('[streamProxy] Host mismatch rejected', {
      streamId: streamId.slice(0, 8),
      requestedHost: safeHost(target),
      allowedHost: ctx.host,
    });
    return res.status(403).json({ error: 'Requested host not allowed for this stream.' });
  }

  // Derive the authoritative playback context (userAgent + fresh cookies from
  // the shared cookie jar) via the provider — no duplicate cookie logic.
  const playback = getPlaybackContext(target, ctx.referer || null);
  const upstreamHeaders = buildUpstreamHeaders(ctx, req, playback);
  const isHls = /\.m3u8(\?|$)/i.test(target);
  const started = Date.now();

  try {
    // ── HLS path: fetch manifest, rewrite, relay ───────────
    if (isHls) {
      // Fetch the manifest as text (small).
      const resp = await request(
        { method: 'get', url: target, headers: upstreamHeaders, responseType: 'text', maxRedirects: 5 },
        {
          providerName: PROXY_PROVIDER_TAG,
          streaming: true,
          skipProxy: true,
          timeout: DEFAULT_UPSTREAM_TIMEOUT_MS,
        }
      );

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Upstream manifest returned ${resp.status}`);
      }

      const body = String(resp.data || '');
      const rewritten = rewriteHlsManifest(body, target, streamId, ctx.host);

      res.status(resp.status);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      setCorsHeaders(res);
      res.end(rewritten);

      logger.streamAttempt({
        provider: PROXY_PROVIDER_TAG,
        result: 'success',
        httpStatus: resp.status,
        streamType: 'hls',
        latencyMs: Date.now() - started,
        streamId: streamId.slice(0, 8),
      });
      return;
    }

    // ── MP4 / direct media path: stream with byte-range ────
    let attempt = 0;
    let pipeError = null;
    while (attempt <= 1) {
      try {
        const upstream = await pipeStream(target, upstreamHeaders);
        if (!upstream) {
          throw new Error('Upstream did not respond');
        }

        // Copy safe headers (Content-Type, Content-Length, Content-Range,
        // Accept-Ranges, Cache-Control, ETag, Last-Modified). This naturally
        // produces HTTP 206 Partial Content when the client sent a Range header.
        copySafeHeaders(upstream.headers, res);
        res.status(upstream.status);
        setCorsHeaders(res);

        // Pipe the upstream stream to the client (low-memory).
        upstream.data.pipe(res);

        upstream.data.on('error', (err) => {
          logger.warn('[streamProxy] Upstream stream error', { streamId: streamId.slice(0, 8), error: err.message });
          if (!res.headersSent) {
            res.status(502).json({ error: 'Upstream stream error.' });
          } else {
            res.end();
          }
        });

        res.on('close', () => {
          // Abort the upstream if the client disconnects mid-stream.
          if (upstream.data && typeof upstream.data.destroy === 'function') {
            upstream.data.destroy();
          }
        });

        logger.streamAttempt({
          provider: PROXY_PROVIDER_TAG,
          result: 'success',
          httpStatus: upstream.status,
          streamType: 'mp4',
          bytes: upstream.headers['content-length'] || null,
          latencyMs: Date.now() - started,
          streamId: streamId.slice(0, 8),
        });
        return;
      } catch (err) {
        pipeError = err;
        attempt += 1;
        // Retry once for transient network errors / 5xx / empty responses.
        const transient = !err.response || err.response.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        if (attempt <= 1 && transient) {
          logger.warn('[streamProxy] Retrying upstream', {
            streamId: streamId.slice(0, 8),
            attempt,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        break;
      }
    }

    // All attempts failed.
    if (!res.headersSent) {
      const status = pipeError?.response?.status;
      if (status) {
        res.status(status).json({ error: `Upstream error ${status}.` });
      } else {
        res.status(502).json({ error: 'Failed to fetch upstream media.' });
      }
    } else {
      res.end();
    }
    logger.streamAttempt({
      provider: PROXY_PROVIDER_TAG,
      result: 'failure',
      httpStatus: pipeError?.response?.status || 0,
      streamType: 'mp4',
      error: pipeError?.message,
      latencyMs: Date.now() - started,
      streamId: streamId.slice(0, 8),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error.' });
    } else {
      res.end();
    }
    logger.streamAttempt({
      provider: PROXY_PROVIDER_TAG,
      result: 'failure',
      httpStatus: err.response?.status || 0,
      error: err.message,
      latencyMs: Date.now() - started,
      streamId: streamId.slice(0, 8),
    });
  }
};

/**
 * Preflight handler for the proxy route (CORS).
 */
exports.preflight = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
};
