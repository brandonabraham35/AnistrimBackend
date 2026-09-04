// services/streamSourceMonitor.js — Conservative Background Source Verification
//
// PURPOSE:
//   Periodically verify cached stream sources in the background to detect
//   expired/invalid sources before users encounter playback failures.
//
// CONSERVATIVE BY DESIGN:
//   - DISABLED BY DEFAULT (STREAM_MONITOR_ENABLED=false)
//   - Never verifies all sources simultaneously
//   - Skips known-expired, invalid, and recently-verified sources
//   - Uses HEAD/Range requests only (never downloads full video)
//   - Does not use residential proxy unless source requires it
//   - Never blocks API requests
//   - Graceful shutdown on process exit
//
// USAGE:
//   const monitor = require('./services/streamSourceMonitor');
//   monitor.start();  // Called from server.js startup
//   monitor.stop();   // Called on graceful shutdown

'use strict';

// ─ Configuration (read at module load time from env) ──────

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONFIG = {
  // Master switch — DISABLED unless explicitly enabled with STREAM_MONITOR_ENABLED=true.
  // undefined / false / "false" → disabled; only the literal "true" enables it.
  enabled: process.env.STREAM_MONITOR_ENABLED === 'true',

  // Interval between monitoring runs (in milliseconds).
  // Default: 1 hour.
  intervalMs: parsePositiveInt(process.env.STREAM_MONITOR_INTERVAL_MINUTES, 60) * 60 * 1000,

  // Number of sources to verify per run.
  // Default: 50.
  batchSize: parsePositiveInt(process.env.STREAM_MONITOR_BATCH_SIZE, 50),

  // Maximum concurrent verifications.
  // Default: 5 (conservative to avoid overwhelming the CDN).
  concurrency: parsePositiveInt(process.env.STREAM_MONITOR_CONCURRENCY, 5),

  // Timeout per verification request (in milliseconds).
  // Default: 5 seconds.
  timeoutMs: parsePositiveInt(process.env.STREAM_MONITOR_TIMEOUT_MS, 5000),

  // Maximum total sources verified per run (hard cap).
  // Default: 100.
  maxSourcesPerRun: parsePositiveInt(process.env.STREAM_MONITOR_MAX_SOURCES, 100),

  // Minimum time between verifications for the same source (in milliseconds).
  // Default: 30 minutes — don't re-verify recently checked sources.
  minVerificationIntervalMs: parsePositiveInt(process.env.STREAM_MONITOR_MIN_INTERVAL_MINUTES, 30) * 60 * 1000,
};

// ─ Factory: creates a monitor instance with injected deps ─

/**
 * Create a monitor with injected dependencies.
 * @param {object} deps
 * @param {object} deps.db — { query: (sql, params) => Promise<[rows, fields]> }
 * @param {object} deps.logger — { info, debug, warn, error }
 * @param {(rowId: number, url: string, context: object) => Promise<{alive: boolean, status: number|null, contentType: string|null}>} deps.verifyAndRecord
 * @returns {object} Monitor instance
 */
function createMonitor(deps = {}) {
  const db = deps.db || null;
  const logger = deps.logger || null;
  const verifyAndRecordFn = deps.verifyAndRecord || null;

  // Lazy resolve defaults only when no injected dep was provided.
  // This avoids loading streamCacheService (heavy transitive deps) in tests.
  let _resolvedDb = db;
  let _resolvedLogger = logger;
  let _resolvedVerifyAndRecord = verifyAndRecordFn;

  function getDb() {
    if (!_resolvedDb) _resolvedDb = require('../config/db');
    return _resolvedDb;
  }

  function getLogger() {
    if (!_resolvedLogger) _resolvedLogger = require('../utils/logger');
    return _resolvedLogger;
  }

  function getVerifyAndRecord() {
    if (!_resolvedVerifyAndRecord) {
      _resolvedVerifyAndRecord = require('./streamCacheService').verifyAndRecord;
    }
    return _resolvedVerifyAndRecord;
  }

  // ─ State ──────────────────────────────────────────────────

  let monitorTimer = null;
  let isRunning = false;
  let isShuttingDown = false;

  // ── Batch Selection ────────────────────────────────────────

  async function selectBatch() {
    const cutoff = new Date(Date.now() - CONFIG.minVerificationIntervalMs);

    const [rows] = await getDb().query(
      `SELECT id, episode_id, provider, stream_data, verification_status,
              detected_expires_at, expires_at, last_verified_at
       FROM episode_stream_cache
       WHERE verification_status != 'invalid'
         AND (detected_expires_at IS NULL OR detected_expires_at > NOW())
         AND expires_at > NOW()
         AND (last_verified_at IS NULL OR last_verified_at < ?)
       ORDER BY
         CASE WHEN verification_status = 'active' AND detected_expires_at IS NULL THEN 0
              WHEN verification_status = 'unknown' THEN 1
              ELSE 2 END,
         last_verified_at ASC
       LIMIT ?`,
      [cutoff, CONFIG.batchSize]
    );

    return rows.slice(0, CONFIG.maxSourcesPerRun);
  }

  // ── Verification ───────────────────────────────────────────

  async function verifySourceAndUpdate(row) {
    const sourceUrl = row.stream_data?.sources?.[0]?.url || row.stream_data?.streamUrl;
    if (!sourceUrl) return { id: row.id, status: 'skipped', reason: 'no_url' };

    // Playback context is persisted by saveStream() at stream_data.sources[i]
    // (referer/origin/cookies) — NOT at the stream_data top level. The monitor
    // must probe the same source URL with the same context the application
    // would use, or context-sensitive CDN URLs can falsely return 403/404.
    // A legacy top-level fallback preserves any older rows that stored context
    // at the stream_data root.
    const sourceCtx = row.stream_data?.sources?.[0] || {};
    const context = {};
    if (sourceCtx.referer) context.referer = sourceCtx.referer;
    else if (row.stream_data?.referer) context.referer = row.stream_data.referer;
    if (sourceCtx.origin) context.origin = sourceCtx.origin;
    else if (row.stream_data?.origin) context.origin = row.stream_data.origin;
    if (sourceCtx.cookies) context.cookies = sourceCtx.cookies;
    else if (row.stream_data?.cookies) context.cookies = row.stream_data.cookies;

    try {
      const result = await getVerifyAndRecord()(row.id, sourceUrl, context);
      return { id: row.id, status: 'verified', alive: result.alive };
    } catch (err) {
      getLogger().warn('[StreamMonitor] Verification error (non-fatal)', {
        id: row.id, episodeId: row.episode_id, error: err.message,
      });
      return { id: row.id, status: 'error', reason: err.message };
    }
  }

  async function runCycle() {
    if (isRunning) {
      getLogger().debug('[StreamMonitor] Cycle already running — skipping');
      return;
    }

    isRunning = true;
    const startTime = Date.now();

    try {
      getLogger().info('[StreamMonitor] Starting verification cycle');

      const batch = await selectBatch();
      if (batch.length === 0) {
        getLogger().info('[StreamMonitor] No sources to verify');
        return;
      }

      getLogger().info('[StreamMonitor] Selected batch', { count: batch.length });

      const results = await verifyWithConcurrency(batch);

      const verified = results.filter(r => r.status === 'verified').length;
      const alive = results.filter(r => r.alive).length;
      const invalid = results.filter(r => r.status === 'verified' && !r.alive).length;
      const errors = results.filter(r => r.status === 'error').length;
      const skipped = results.filter(r => r.status === 'skipped').length;

      getLogger().info('[StreamMonitor] Cycle complete', {
        total: batch.length,
        verified,
        alive,
        invalid,
        errors,
        skipped,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      getLogger().error('[StreamMonitor] Cycle failed', { error: err.message });
    } finally {
      isRunning = false;
    }
  }

  async function verifyWithConcurrency(batch) {
    const results = [];
    const queue = [...batch];
    const active = new Set();

    return new Promise((resolve) => {
      function processNext() {
        if (isShuttingDown || queue.length === 0) {
          if (active.size === 0) resolve(results);
          return;
        }

        while (active.size < CONFIG.concurrency && queue.length > 0) {
          const row = queue.shift();
          active.add(row.id);

          verifySourceAndUpdate(row)
            .then((result) => {
              results.push(result);
              active.delete(row.id);
              processNext();
            })
            .catch((err) => {
              results.push({ id: row.id, status: 'error', reason: err.message });
              active.delete(row.id);
              processNext();
            });
        }

        if (active.size === 0 && queue.length === 0) {
          resolve(results);
        }
      }

      processNext();
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  function start() {
    if (!CONFIG.enabled) {
      getLogger().info('[StreamMonitor] Disabled (set STREAM_MONITOR_ENABLED=true to enable)');
      return;
    }

    getLogger().info('[StreamMonitor] Starting', {
      intervalMs: CONFIG.intervalMs,
      batchSize: CONFIG.batchSize,
      concurrency: CONFIG.concurrency,
      timeoutMs: CONFIG.timeoutMs,
    });

    setTimeout(() => runCycle(), 5000).unref();
    monitorTimer = setInterval(() => runCycle(), CONFIG.intervalMs);
    monitorTimer.unref();
  }

  function stop() {
    isShuttingDown = true;
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    getLogger().info('[StreamMonitor] Stopped');
  }

  return {
    start,
    stop,
    isRunning: () => isRunning,
    getConfig: () => ({ ...CONFIG }),
    selectBatch,
    verifyWithConcurrency,
    runCycle,
  };
}

// ─ Default singleton (lazy — created on first call to a default export) ──

let _defaultMonitor = null;
let _shutdownRegistered = false;

function _default() {
  if (!_defaultMonitor) {
    _defaultMonitor = createMonitor();
    if (!_shutdownRegistered) {
      _shutdownRegistered = true;
      process.on('SIGTERM', () => { _defaultMonitor.stop(); });
      process.on('SIGINT', () => { _defaultMonitor.stop(); });
    }
  }
  return _defaultMonitor;
}

module.exports = {
  start: () => _default().start(),
  stop: () => _default().stop(),
  isRunning: () => _default().isRunning(),
  getConfig: () => _default().getConfig(),
  selectBatch: () => _default().selectBatch(),
  verifyWithConcurrency: (batch) => _default().verifyWithConcurrency(batch),
  runCycle: () => _default().runCycle(),
  // Expose factory for testing with injected dependencies.
  createMonitor,
};
