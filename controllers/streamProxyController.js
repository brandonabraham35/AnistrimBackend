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
//    • HLS manifest rewriting is delegated to utils/hlsRewriter.js — the
//      single source of truth shared with streamProxyQueryController.js.
//      A response is treated as a manifest when the upstream Content-Type is
//      application/vnd.apple.mpegurl / application/x-mpegURL / ... OR the URL
//      ends in .m3u8. Every child URI (variant playlists, media playlists,
//      TS/fMP4 segments, audio/subtitle playlists, key URIs, init segments,
//      LL-HLS parts/preload-hints, I-frame playlists, byte-range segments) is
//      rewritten to /api/stream-proxy/:streamId?url=<encoded> so all
//      subsequent requests stay behind the proxy. Supports relative +
//      absolute + query/tokenized URLs (data:/blob: pass through untouched).
//    • Low-memory streaming — upstream response is piped through, never
//      buffered whole (except HLS manifests, which are small text and are
//      buffered under a hard cap).
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
const { getPlaybackContext } = require('../services/animeHeavenProvider');
// Shared header helpers (upstream header build + safe response relay + CORS)
// so both proxy controllers never diverge.
const {
  buildUpstreamHeaders,
  copySafeHeaders,
  setCorsHeaders,
} = require('../utils/streamProxyHeaders');
// Single source of truth for HLS manifest rewriting + HLS detection. Both
// proxy controllers share utils/hlsRewriter so they can never diverge.
const { rewriteHlsManifest, isHlsUri, isHlsContentType } = require('../utils/hlsRewriter');

const DEFAULT_UPSTREAM_TIMEOUT_MS = 15000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2MB cap for HLS manifests
const PROXY_BASE = '/api/stream-proxy';
const PROXY_PROVIDER_TAG = 'animeheaven-proxy';

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
 * Collect a streamed upstream response body into a Buffer, enforcing a hard
 * cap so a mislabelled manifest cannot exhaust memory. Manifests are text and
 * small; media segments are streamed, never collected.
 *
 * @param {import('stream').Readable} stream - upstream response stream
 * @param {number} maxBytes - maximum bytes to accept
 * @returns {Promise<Buffer>}
 */
function collectToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Manifest exceeds ${maxBytes} byte cap.`));
        if (stream.destroy) stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
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
  const startedProxyTime = Date.now();

  logger.info('[StreamProxy] Incoming request', {
    streamId: streamId.slice(0, 8) + '...',
    requestedUrl: requestedUrl ? requestedUrl.substring(0, 100) + '...' : null,
    range: req.headers.range || 'none',
  });

  // ── Phase 10 (item 21): token gate ───────────────────────
  // /api/stream-proxy/:streamId accepts ONLY a valid short-lived stream token
  // (from POST /api/stream/authorize), bound to userId + episodeId + ip.
  // Child HLS resources (url query) are allowed once the parent token verifies.
  // Child (?url=) requests may alternatively authenticate with the scoped
  // long-lived `ct` token embedded in rewritten HLS child URLs — hls.js
  // segment/playlist/key XHRs cannot mint the 120 s token themselves.
  const authToken = req.query.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1] : null) || (requestedUrl ? (req.query.ct || null) : null);
  if (!authToken) {
    logger.warn('[streamProxy] token missing', { streamId: streamId.slice(0, 8) });
    return res.status(401).json({ error: 'Stream authorization token required.' });
  }
  const { verify } = require('../utils/streamToken');
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  // ── FIX 3 + FIX 5: bind token → streamId + episodeId + userId + session ──
  // Verify against the full expected context (including the in-memory
  // revocation set, which is populated on logout/logout-all/suspend). The
  // sid/tv are checked below against the live DB session + user token_version.
  const tokenCheck = verify(authToken, { streamId, ip });
  if (!tokenCheck.ok) {
    // ── Log the EXACT rejection reason in the same stream as sourceReturned ──
    logger.warn('[streamProxy] token rejected', { streamId: streamId.slice(0, 8), reason: tokenCheck.reason, ip: ip.slice(0, 12) });
    logger.streamAttempt({
      provider: PROXY_PROVIDER_TAG,
      result: 'failure',
      httpStatus: 403,
      streamType: 'mp4',
      error: `token rejected (${tokenCheck.reason})`,
      latencyMs: Date.now() - startedProxyTime,
      streamId: streamId.slice(0, 8),
    });
    return res.status(403).json({ error: `Invalid or expired stream authorization (${tokenCheck.reason}).` });
  }
  const authPayload = tokenCheck.payload;

  // Scoped child tokens (long TTL, embedded in rewritten HLS child URLs) may
  // ONLY fetch child resources (?url=). Parent manifest / MP4 requests still
  // require the short-lived 120 s token from POST /api/stream/authorize.
  if (!requestedUrl && authPayload.scope === 'hls-child') {
    logger.warn('[streamProxy] child-scoped token used for parent request', { streamId: streamId.slice(0, 8) });
    return res.status(403).json({ error: 'Stream authorization scope mismatch.' });
  }

  // ── Security: validate the stream context ────────────────
  // The token must be bound to the SAME userId + episodeId as the store
  // context registered for this path streamId. This prevents a token minted
  // for one user/episode from playing another user's/episode's context.
  const ctx = streamProxyStore.get(streamId);
  if (!ctx) {
    return res.status(404).json({ error: 'Stream context not found or expired.' });
  }

  // ── FIX 5 (P1): Session + token_version freshness ─────────
  // A stream token is only valid while its owning access session is still
  // active (not revoked) AND the user's token_version still matches. This
  // kills in-flight playback (within one segment fetch) after logout,
  // logout-all, suspension, password change, or token_version bump. The
  // 120 s TTL remains as defense in depth.
  try {
    const db = require('../config/db');
    const sid = authPayload.sid;
    const tv = authPayload.tv;
    const userId = authPayload.userId;
    if (userId) {
      const [userRows] = await db.query('SELECT token_version, status FROM users WHERE id = ?', [userId]);
      if (!userRows || userRows.length === 0) {
        return res.status(403).json({ error: 'User not found.' });
      }
      if (userRows[0].status !== 'active') {
        logger.warn('[streamProxy] user not active', { userId: String(userId).slice(0, 8), status: userRows[0].status });
        return res.status(403).json({ error: 'Account is not active.' });
      }
      if (tv !== undefined && tv !== null && Number(userRows[0].token_version) !== Number(tv)) {
        logger.warn('[streamProxy] token_version mismatch', { userId: String(userId).slice(0, 8) });
        return res.status(403).json({ error: 'Session invalidated. Please log in again.' });
      }
    }
    if (sid) {
      const [sessRows] = await db.query(
        'SELECT revoked_at FROM user_sessions WHERE id = ?',
        [sid]
      );
      if (sessRows.length === 0 || (sessRows[0] && sessRows[0].revoked_at)) {
        logger.warn('[streamProxy] session revoked/expired', { sid: String(sid).slice(0, 8) });
        return res.status(403).json({ error: 'Session revoked. Please log in again.' });
      }
    }
  } catch (dbErr) {
    // On a DB hiccup, fail closed (defense in depth) — refuse to serve.
    logger.error('[streamProxy] session freshness check failed (deny)', { error: dbErr.message });
    return res.status(403).json({ error: 'Session verification failed.' });
  }
  const ctxUserId = String(ctx.userId ?? '');
  const ctxEpId = String(ctx.episodeId ?? '');
  const tokUserId = String(authPayload.userId ?? '');
  const tokEpId = String(authPayload.episodeId ?? '');
  if (ctxUserId && tokUserId && ctxUserId !== tokUserId) {
    logger.warn('[streamProxy] user/episode binding mismatch', {
      streamId: streamId.slice(0, 8),
      ctxUserId: ctxUserId.slice(0, 8),
      tokUserId: tokUserId.slice(0, 8),
    });
    return res.status(403).json({ error: 'Stream authorization does not match this stream context.' });
  }
  if (ctxEpId && tokEpId && ctxEpId !== tokEpId) {
    logger.warn('[streamProxy] episode binding mismatch', {
      streamId: streamId.slice(0, 8),
      ctxEpId: String(ctxEpId).slice(0, 12),
      tokEpId: String(tokEpId).slice(0, 12),
    });
    return res.status(403).json({ error: 'Stream authorization does not match this episode.' });
  }

  // Bind the authorized user to the stream context (created by rewriteResultToProxy).
  req.streamAuth = authPayload;

  // Determine the target URL.
  const target = requestedUrl || ctx.targetUrl;
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
  // Correct argument order: buildUpstreamHeaders(playback, req, ctx).
  // The FRESH playback context (referer/origin/cookies from the shared cookie
  // jar) must take precedence over the stored ctx. Passing them swapped made
  // the function prefer the potentially-stale store-time cookies/headers, which
  // broke playback when AnimeHeaven rotated its CDN cookies.
  const upstreamHeaders = buildUpstreamHeaders(playback, req, ctx);
  const started = Date.now();

  try {
    // ── Fetch the upstream as a stream (one retry for transients) ──
    // We fetch as a stream so we can inspect the response Content-Type to
    // decide whether it is an HLS manifest even when the URL has no .m3u8
    // extension (some CDNs serve playlists extension-less).
    let attempt = 0;
    let pipeError = null;
    let upstream = null;
    while (attempt <= 1) {
      try {
        upstream = await pipeStream(target, upstreamHeaders);
        if (!upstream) {
          throw new Error('Upstream did not respond');
        }
        break;
      } catch (err) {
        pipeError = err;
        logger.warn('[StreamProxy] Upstream fetch attempt failed', {
          attempt: attempt + 1,
          target: target.substring(0, 100) + '...',
          error: err.message,
        });
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

    if (!upstream) {
      if (!res.headersSent) {
        const status = pipeError?.response?.status;
        logger.error('[StreamProxy] Upstream final failure', {
          target: target.substring(0, 100) + '...',
          status: status || 'N/A',
          error: pipeError?.message,
        });
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
      return;
    }

    // ── HLS path: manifest rewrite ─────────────────────────
    // A response is a manifest if its Content-Type is an HLS MIME type OR its
    // URL ends in .m3u8. Content-Type is preferred (per the spec) and covers
    // extension-less playlist URLs.
    const contentType = String(upstream.headers?.['content-type'] || '');
    const contentLength = Number(upstream.headers?.['content-length'] || 0);
    const isHls = isHlsContentType(contentType) || (isHlsUri(target) && !/^audio\//i.test(contentType));

    logger.info('[StreamProxy] Upstream response received', {
      status: upstream.status,
      contentType,
      contentLength,
      isHls,
    });

    if (isHls) {
      // Enforce the size cap (pre-check via header, then hard-stop while
      // collecting) so a mislabelled/huge body cannot exhaust memory.
      if (contentLength > MAX_MANIFEST_BYTES) {
        if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy();
        return res.status(502).json({ error: 'Manifest exceeds size cap.' });
      }

      const body = await collectToBuffer(upstream.data, MAX_MANIFEST_BYTES);
      const manifestText = body.toString('utf8');

      // Build the streamId-scoped proxy URL for every child resource. Each
      // child URL carries a scoped long-lived `ct` token so hls.js segment /
      // playlist / key XHRs authenticate without any client-side change
      // (works for already-installed apps). Parent requests refuse `ct`.
      const { mint, CHILD_TTL_MS } = require('../utils/streamToken');
      const childToken = mint({
        userId: authPayload.userId,
        episodeId: authPayload.episodeId,
        streamId,
        ip,
        sid: authPayload.sid,
        tv: authPayload.tv,
        scope: 'hls-child',
        ttlMs: CHILD_TTL_MS,
      });
      const proxyUrlBuilder = (absUrl) =>
        `${PROXY_BASE}/${streamId}?url=${encodeURIComponent(absUrl)}&ct=${encodeURIComponent(childToken)}`;

      const { body: rewritten, rewritten: count } = rewriteHlsManifest(
        manifestText,
        target,
        proxyUrlBuilder
      );

      res.status(upstream.status);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      setCorsHeaders(res);
      res.send(rewritten);

      logger.streamAttempt({
        provider: PROXY_PROVIDER_TAG,
        result: 'success',
        httpStatus: upstream.status,
        streamType: 'hls',
        latencyMs: Date.now() - started,
        streamId: streamId.slice(0, 8),
        rewritten: count,
      });
      return;
    }

    // ── MP4 / direct media path: stream with byte-range ────
    // Copy safe headers (Content-Type, Content-Length, Content-Range,
    // Accept-Ranges, Cache-Control, ETag, Last-Modified). This naturally
    // produces HTTP 206 Partial Content when the client sent a Range header.
    copySafeHeaders(upstream.headers, res);
    res.status(upstream.status);
    setCorsHeaders(res);

    logger.info('[StreamProxy] Streaming started', {
      responseStatus: res.statusCode,
      responseContentType: res.getHeader('Content-Type'),
      responseContentRange: res.getHeader('Content-Range') || 'N/A',
    });

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
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error.' });
    } else {
      res.end();
    }
    logger.streamAttempt({
      level: 'error',
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
