// =============================================================
//  utils/streamDiagnostics.js — READ-ONLY Stream Lifetime Diagnostics
//
//  PURPOSE:
//    Centralised, safe diagnostic helpers for observing the streaming
//    pipeline's URL lifetimes, context lifetimes, cache-probe accuracy,
//    and playback success/failure. NEVER modifies behaviour, NEVER
//    changes TTLs, NEVER changes headers or proxy behaviour.
//
//  DESIGN:
//    • All diagnostic methods are pure logging — no side effects.
//    • URL fingerprints are SAFE: hostname, path-pattern, param-names,
//      URL hash (crypto truncated), URL length. NEVER full URLs.
//    • Cookies, tokens, secrets are NEVER logged.
//    • All output is structured JSON with the [STREAM_DIAG] tag for
//      easy grep:  grep 'STREAM_DIAG' server.log
//    • Gated by STREAM_DIAGNOSTIC env var (default OFF). Set to '1'
//      or 'true' to enable. This prevents production log flood.
// =============================================================
'use strict';

const crypto = require('crypto');
const logger = require('./logger');

// ── Gate ────────────────────────────────────────────────────
const DIAG_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.STREAM_DIAGNOSTIC || '').toLowerCase()
);

const TAG = '[STREAM_DIAG]';
// ── Safe URL Fingerprinting ─────────────────────────────────
// Returns diagnostic-safe fields: NEVER returns the full URL.

/**
 * Extract a safe fingerprint from a URL string.
 * @param {string} urlStr - A URL (may be raw CDN or proxy path)
 * @returns {object|null} { host, path, params, hash, length } or null on parse failure
 */
function fingerprintUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const abs = urlStr.startsWith('http') ? urlStr : `https://placeholder${urlStr}`;
    const u = new URL(abs);
    const params = [...u.searchParams.keys()].sort();
    const shortHash = crypto
      .createHash('sha256')
      .update(urlStr)
      .digest('hex')
      .substring(0, 12);
    return {
      host: u.hostname || null,
      path: u.pathname || null,
      params: params.length > 0 ? params.join(',') : null,
      hash: shortHash,
      length: urlStr.length,
    };
  } catch {
    return null;
  }
}

/**
 * Build a diagnostic event log entry.
 * Only emitted when STREAM_DIAGNOSTIC is enabled.
 * @param {string} event - Event type
 * @param {object} data  - Event-specific fields (must be safe — no secrets)
 */
function diagLog(event, data = {}) {
  if (!DIAG_ENABLED) return;
  logger.info(`${TAG} ${event}`, data);
}

module.exports = {
  DIAG_ENABLED,
  TAG,
  fingerprintUrl,
  diagLog,
  // ── Specialized diagnostic loggers ───────────────────────
  // Each is a thin wrapper over diagLog. They are pure logging helpers
  // (no side effects, no context mutation, never throw into the playback
  // path). Callers across the streaming pipeline (streamingService,
  // streamCacheService, streamProxyController) rely on these being present.
  // Missing methods here surface as "X is not a function" and can break the
  // playback/context-registration flow, so they must stay exported.

  /** Log the result of a fresh (uncached) stream resolution. */
  logFreshResolution(episodeId, provider, result, durationMs, success) {
    diagLog('fresh_resolution', {
      episodeId: episodeId != null ? String(episodeId) : null,
      provider: provider || null,
      success: success !== false,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      sources: result && Array.isArray(result.sources) ? result.sources.length : null,
    });
  },

  /** Log a cache probe (HEAD/alive check) result for a source URL. */
  logCacheProbe(url, reqCtx, result) {
    diagLog('cache_probe', {
      url: fingerprintUrl(url),
      ...(reqCtx || {}),
      alive: !!(result && result.alive),
      status: result && result.status != null ? result.status : null,
      contentType: (result && result.contentType) || null,
      durationMs: (result && result.durationMs) || null,
    });
  },

  /** Log a persistent-cache HIT for an episode/provider. */
  logCacheHit(episodeId, provider, row, result, cacheAge, remaining, playbackCtx) {
    diagLog('cache_hit', {
      episodeId: episodeId != null ? String(episodeId) : null,
      provider: provider || null,
      cacheAgeMs: Number.isFinite(cacheAge) ? cacheAge : null,
      remainingMs: Number.isFinite(remaining) ? remaining : null,
      sources: result && Array.isArray(result.sources) ? result.sources.length : null,
      host: (playbackCtx && playbackCtx.host) || null,
      providerUsed: (row && row.provider) || null,
    });
  },

  /** Log creation of a new persistent-cache entry. */
  logCacheCreation(episodeId, provider, providerResult, ttlMs, expiresAt) {
    diagLog('cache_creation', {
      episodeId: episodeId != null ? String(episodeId) : null,
      provider: provider || null,
      ttlMs: Number.isFinite(ttlMs) ? ttlMs : null,
      expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : (expiresAt || null),
      sources: providerResult && Array.isArray(providerResult.sources)
        ? providerResult.sources.length
        : null,
    });
  },

  /** Log invalidation/removal of a persistent-cache entry. */
  logCacheInvalidation(episodeId, provider, reason, row, result) {
    diagLog('cache_invalidation', {
      episodeId: episodeId != null ? String(episodeId) : null,
      provider: provider || null,
      reason: reason || null,
      removed: !!(row && row.affectedRows),
      sources: result && Array.isArray(result.sources) ? result.sources.length : null,
    });
  },

  /** Log a playback failure observed by the stream proxy. */
  logPlaybackFailure(ctx, http, extra) {
    diagLog('playback_failure', {
      streamId: ctx && ctx.streamId ? String(ctx.streamId).slice(0, 8) : null,
      host: (ctx && ctx.targetUrl && fingerprintUrl(ctx.targetUrl)) || null,
      status: http && http.status != null ? http.status : null,
      error: (http && http.error) || null,
      type: (extra && extra.type) || null,
      detail: (extra && extra.detail) || null,
    });
  },

  /** Log a successful proxy playback upstream result. */
  logProxyPlayback(streamId, ctx, http) {
    diagLog('proxy_playback', {
      streamId: streamId ? String(streamId).slice(0, 8) : null,
      host: (ctx && ctx.targetUrl && fingerprintUrl(ctx.targetUrl)) || null,
      status: http && http.status != null ? http.status : null,
      contentType: (http && http.contentType) || null,
      bytes: (http && http.bytes) || null,
      durationMs: (http && http.durationMs) || null,
    });
  },
};