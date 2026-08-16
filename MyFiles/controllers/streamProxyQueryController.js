// =============================================================
//  controllers/streamProxyQueryController.js — Stateless Query-Based Playback Proxy
//
//  WHY:
//    The AnimeHeaven provider now emits every stream URL in the stateless,
//    query-based proxy format:
//      /api/stream/proxy?provider=animeheaven&url=<encoded>&referer=<encoded>
//    The browser never talks to the AnimeHeaven CDNs directly. This controller
//    receives the encoded target URL + referer, injects the server-side playback
//    context (Cookie/Referer/Origin/UA) that hotlink-protected CDNs require, and
//    streams the media back to the client.
//
//  FEATURES:
//    • Only `provider=animeheaven` is accepted (proxy mode). Any other provider
//      is rejected — OTHER PROVIDERS ARE UNAFFECTED.
//    • MP4/direct media: full byte-range (Range/Content-Range/Accept-Ranges).
//    • HLS manifest rewriting is delegated to utils/hlsRewriter.js — the
//      single source of truth shared with streamProxyController.js. A response
//      is treated as a manifest when the upstream Content-Type is
//      application/vnd.apple.mpegurl / application/x-mpegURL / ... OR the URL
//      ends in .m3u8. Every child URI (variant playlists, media playlists,
//      TS/fMP4 segments, audio/subtitle playlists, key URIs, init segments,
//      LL-HLS parts/preload-hints, I-frame playlists, byte-range segments) is
//      rewritten to the SAME /api/stream/proxy format via buildProxyUrl() —
//      with the manifest URL as the referer. Supports relative + absolute +
//      query/tokenized URLs (data:/blob: pass through untouched).
//    • Builds upstream headers via getPlaybackContext() — the SINGLE source of
//      truth for the provider's cookie jar + browser-like UA.
//    • Low-memory streaming — upstream response is piped, never buffered whole
//      (except small HLS manifests, buffered under a hard cap).
//    • Reuses utils/providerHttp.request() for a unified HTTP/proxy layer.
//
//  SECURITY (NOT an open proxy):
//    • provider must equal 'animeheaven' (else 403).
//    • url must be an absolute http(s) URL (else 400).
//    • Only http/https targets are ever fetched; the query is stateless so no
//      stream context is stored — cookies/referers/origins never reach the client.
// =============================================================
'use strict';

const { request } = require('../utils/providerHttp');
const logger = require('../utils/logger');
// SSRF protection: rejects targets that resolve to private/loopback/link-local
// addresses before the upstream request is made.
const { assertSafeTargetHost } = require('../utils/ssrfGuard');
// Single source of truth for playback headers + the proxy URL shape.
const {
  getPlaybackContext,
  buildProxyUrl,
} = require('../services/animeHeavenProvider');
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
const PROXY_PROVIDER_TAG = 'animeheaven-proxy';
const ALLOWED_PROVIDER = 'animeheaven';

/**
 * Perform the upstream fetch as a stream and pipe it to the client.
 * Used for MP4/segment/direct media (non-manifest) requests.
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
 * GET /api/stream/proxy
 * Query params:
 *   provider — must be 'animeheaven' (only AnimeHeaven uses proxy mode).
 *   url      — encoded absolute http(s) target URL.
 *   referer  — encoded referer page (the AnimeHeaven gate/embed/mirror).
 */
exports.streamMedia = async (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase();
  const target = String(req.query.url || '').trim();
  const referer = req.query.referer ? String(req.query.referer).trim() : null;

  // ── Only AnimeHeaven uses proxy mode ────────────────────
  if (provider !== ALLOWED_PROVIDER) {
    logger.warn('[streamProxyQuery] Unsupported provider rejected', { provider: provider || '(missing)' });
    return res.status(403).json({ error: 'Proxy mode is only available for animeheaven.' });
  }

  // ── Validate the target URL ─────────────────────────────
  if (!target) {
    return res.status(400).json({ error: 'Missing url query parameter.' });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL.' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) targets are allowed.' });
  }

  // ── SSRF protection ────────────────────────────────────
  // Reject any target whose resolved destination is loopback, link-local,
  // private, or otherwise internal (preventing the proxy from being used to
  // reach cloud metadata endpoints, localhost, internal networks, etc.).
  // This runs BEFORE the upstream request is made. The AnimeHeaven media/CDN,
  // HLS playlist, segment, subtitle, and mirror hosts all resolve to public
  // IPs, so legitimate playback is unaffected.
  const ssrfError = await assertSafeTargetHost(parsed);
  if (ssrfError) {
    logger.warn('[streamProxyQuery] SSRF target rejected', {
      target: target.substring(0, 160),
      reason: ssrfError,
    });
    return res.status(400).json({ error: 'Target host is not a permitted public address.' });
  }

  // Derive the authoritative playback context (UA + fresh cookies from the
  // shared cookie jar) via the provider — no duplicate cookie logic.
  const playback = getPlaybackContext(target, referer);
  const upstreamHeaders = buildUpstreamHeaders(playback, req);
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
        attempt += 1;
        const transient = !err.response || err.response.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        if (attempt <= 1 && transient) {
          logger.warn('[streamProxyQuery] Retrying upstream', { attempt, error: err.message });
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        break;
      }
    }

    if (!upstream) {
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

    if (isHls) {
      // Enforce the size cap (pre-check via header, then hard-stop while
      // collecting) so a mislabelled/huge body cannot exhaust memory.
      if (contentLength > MAX_MANIFEST_BYTES) {
        if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy();
        return res.status(502).json({ error: 'Manifest exceeds size cap.' });
      }

      const body = await collectToBuffer(upstream.data, MAX_MANIFEST_BYTES);
      const manifestText = body.toString('utf8');

      // Rewrite every child URI to the SAME stateless proxy format, using the
      // manifest URL as the referer so the CDN authorizes each child request.
      const proxyUrlBuilder = (absUrl) => buildProxyUrl(absUrl, target);

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
        rewritten: count,
      });
      return;
    }

    // ── MP4 / direct media path: stream with byte-range ────
    copySafeHeaders(upstream.headers, res);
    res.status(upstream.status);
    setCorsHeaders(res);

    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      logger.warn('[streamProxyQuery] Upstream stream error', { error: err.message });
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream stream error.' });
      } else {
        res.end();
      }
    });

    res.on('close', () => {
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
    });
  }
};

/**
 * Preflight handler for the proxy route (CORS).
 */
exports.preflight = (req, res) => {
  setCorsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
};
