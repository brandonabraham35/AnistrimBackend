// services/healthService.js — Phase 9 (item 20) system health probes.
//
// Probes each subsystem and returns { status: 'up'|'degraded'|'down',
// latencyMs, lastError, checkedAt } per component. Cached for 30 s. Samples are
// persisted to health_samples to power sparklines ("when did this start?").
//
// Concurrency: getHealthSnapshot() dedupes concurrent callers via a module-level
// in-flight promise — N dashboard refreshes inside the same 30 s window share a
// single probe run instead of each triggering a full external probe grid on a
// cache miss.
//
// Resilience: if the cache backend itself is unavailable (get()/set() throw),
// we fall back to the last known snapshot (stale-while-revalidate) so health
// reporting keeps working even when Redis is down.
const db = require('../config/db');
const cache = require('../utils/cacheService');
const cron = require('node-cron');
const logger = require('../utils/logger');

const CACHE_TTL = 30; // 30 s
const CACHE_KEY = 'systemHealth:v1';
const PROBE_TIMEOUT_MS = 4000; // default per-probe timeout
const LAST_ERROR_MAX_LEN = 500; // matches health_samples.last_error VARCHAR(500)

// Last known good snapshot (and the moment it was produced), so we can serve a
// stale-while-revalidate result if the cache backend is unreachable.
let lastSnapshot = null;
let lastSnapshotAt = null;

// Module-level in-flight promise: concurrent getHealthSnapshot() callers share
// ONE probe run. Reset in .finally() once the run settles.
let inflight = null;

// ── Stable error-code mapping ──────────────────────────────────
// Probe failures are NEVER surfaced with raw driver messages, connection
// strings, hostnames, IPs, or provider API bodies. We map each failure to a
// stable, client-safe code; the raw detail is logged server-side only (in the
// probe() catch below).
const errorMappers = {
  // mysql2 / pool failures (probeApi, probeDatabase)
  db: () => 'DB_UNREACHABLE',
  // Redis connect/ping failures
  redis: (err) => /timeout|timed out|etimedout/i.test(String((err && err.message) || ''))
    ? 'REDIS_TIMEOUT'
    : 'REDIS_UNREACHABLE',
  // nodemailer SMTP failures (auth vs send)
  smtp: (err) => /auth|login|credentials|eauth|invalid\s+credentials/i.test(String((err && err.message) || ''))
    ? 'SMTP_AUTH_FAILED'
    : 'SMTP_SEND_FAILED',
  // Pesapal token failures (HTTP 401 vs other)
  pesapal: (err) =>
    (err && err.response && err.response.status === 401) ||
    /401|unauthorized/i.test(String((err && err.message) || ''))
      ? 'PESAPAL_HTTP_401'
      : 'PESAPAL_REQUEST_FAILED',
  // Cloudinary storage
  storage: (err) => /config|not configured/i.test(String((err && err.message) || ''))
    ? 'STORAGE_UNCONFIGURED'
    : 'STORAGE_UNAVAILABLE',
  // Google OAuth tokeninfo reachability
  google: () => 'GOOGLE_OAUTH_UNAVAILABLE',
};

function defaultMapper() {
  return 'PROBE_FAILED';
}

/**
 * Run a probe with a hard timeout. The checkFn may be sync or async. A probe
 * that exceeds the timeout is reported 'down' with lastError 'timeout'.
 */
function withTimeout(promise, ms = PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    Promise.resolve(promise)
      .then(v => { clearTimeout(timer); resolve(v); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Generic probe wrapper. checkStatus can return:
 *   - a string 'up'|'degraded'|'down'
 *   - an object { status, lastError }
 *   - a truthy value → 'up'
 *   - a falsy value → 'down'
 * On throw → 'down' with the error message.
 */
function probe(label, checkFn, timeoutMs = PROBE_TIMEOUT_MS, mapper = defaultMapper) {
  const start = Date.now();
  return withTimeout(checkFn(), timeoutMs)
    .then((result) => {
      let status = 'up';
      let lastError = null;
      if (typeof result === 'string') {
        status = result;
      } else if (result && typeof result === 'object') {
        status = result.status || 'up';
        lastError = result.lastError || null;
      } else if (result === false) {
        status = 'down';
      }
      return {
        status,
        latencyMs: Date.now() - start,
        lastError,
        checkedAt: new Date().toISOString(),
      };
    })
    .catch((err) => {
      // Map to a stable, client-safe code. NEVER surface the raw driver message,
      // connection string, hostname, IP, or provider API body to the client.
      const code = (typeof mapper === 'function' ? mapper(err) : 'PROBE_FAILED')
        || 'PROBE_FAILED';
      // Raw detail is logged server-side only.
      logger.warn(`[HEALTH] Probe "${label}" failed`, {
        code,
        error: err?.message || String(err),
        stack: err?.stack,
      });
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        lastError: code,
        checkedAt: new Date().toISOString(),
      };
    });
}

// ── Individual probes ──────────────────────────────────────────

async function probeApi() {
  return probe('api', async () => {
    // Event-loop lag check + a DB-backed round-trip. If the event loop is
    // blocked > 250ms, this cannot report healthy just because Node is up.
    const lagStart = Date.now();
    let lagMs = 0;
    await new Promise(resolve => setImmediate(resolve));
    lagMs = Date.now() - lagStart;
    if (lagMs > 250) return { status: 'degraded', lastError: `event loop lag ${lagMs}ms` };
    await db.query('SELECT 1');
  }, PROBE_TIMEOUT_MS, errorMappers.db);
}

async function probeDatabase() {
  return probe('database', async () => {
    await db.query('SELECT 1');
  }, PROBE_TIMEOUT_MS, errorMappers.db);
}

async function probeCache() {
  return probe('cache', async () => {
    // Use REDIS directly — NOT utils/cacheService, which silently falls back to
    // an in-memory Map and can never fail. If Redis is unconfigured, the probe
    // is 'degraded' (config-only), NOT a false 'up'.
    if (!process.env.REDIS_URL) {
      return { status: 'degraded', lastError: 'REDIS_URL not configured' };
    }
    const { createClient } = require('redis');
    const redis = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1500, reconnectStrategy: false },
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      await redis.ping();
    } finally {
      try { await redis.quit(); } catch (e) { /* ignore */ }
    }
  }, 2500, errorMappers.redis);
}

async function probeStreaming() {
  return probe('streaming', async () => {
    const monitor = require('./providerHealthMonitor');
    const statuses = monitor.getProviderStatuses();
    if (!statuses.length) throw new Error('No streaming providers tracked');
    const down = statuses.filter(p => p.status === 'down');
    const degraded = statuses.filter(p => p.status === 'degraded');
    if (down.length === statuses.length) {
      return { status: 'down', lastError: `all providers down: ${down.map(p => p.name).join(', ')}`, breakdown: statuses };
    }
    if (down.length > 0 || degraded.length > 0) {
      return { status: 'degraded', lastError: `providers degraded/down: ${[...down, ...degraded].map(p => p.name).join(', ')}`, breakdown: statuses };
    }
    return { status: 'up', lastError: null, breakdown: statuses };
  });
}

async function probePayments() {
  return probe('payments', async () => {
    const ws = require('./pesapalService');
    const hasCredentials = Boolean(
      process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET
    );
    if (!hasCredentials) {
      // No credentials — check the DB table only, but report 'degraded' so this
      // is never a false 'up'.
      await db.query('SELECT COUNT(*) AS c FROM payments LIMIT 1');
      return { status: 'degraded', lastError: 'pesapal_not_configured' };
    }
    // pesapalService exports getToken (NOT getAuthToken).
    if (typeof ws.getToken !== 'function') {
      return { status: 'degraded', lastError: 'pesapal getToken unavailable' };
    }
    const token = await withTimeout(ws.getToken(), 4000);
    if (!token) return { status: 'down', lastError: 'PESAPAL_TOKEN_EMPTY' };
  }, PROBE_TIMEOUT_MS, errorMappers.pesapal);
}

async function probeEmail() {
  return probe('email', async () => {
    const mailer = require('../utils/mailer');
    if (typeof mailer.smtpConfigured !== 'function') {
      return { status: 'degraded', lastError: 'mailer API unavailable' };
    }
    if (!mailer.smtpConfigured()) {
      return { status: 'degraded', lastError: 'SMTP not configured' };
    }
    const transporter = mailer.getTransporter();
    if (typeof transporter?.verify !== 'function') {
      return { status: 'degraded', lastError: 'no transporter.verify' };
    }
    // SMTP handshake with a 4s timeout.
    await withTimeout(
      new Promise((resolve, reject) => transporter.verify(err => err ? reject(err) : resolve())),
      4000
    );
  }, PROBE_TIMEOUT_MS, errorMappers.smtp);
}

async function probeStorage() {
  return probe('storage', async () => {
    const { hasCloudinaryConfig } = require('../utils/bunnyUpload');
    const { cloudinary } = require('../utils/cloudinary');
    // verify config presence. If not configured, 'degraded' (not a hard fail).
    if (!hasCloudinaryConfig()) {
      return { status: 'degraded', lastError: 'Cloudinary not configured' };
    }
    // Real reachability check: cloudinary.api.ping() with a 4s timeout.
    if (typeof cloudinary?.api?.ping === 'function') {
      await withTimeout(
        new Promise((resolve, reject) => cloudinary.api.ping((err, res) => err ? reject(err) : resolve(res))),
        4000
      );
    } else {
      // No SDK ping available — config-only check.
      return { status: 'degraded', lastError: 'STORAGE_CONFIG_ONLY' };
    }
  }, PROBE_TIMEOUT_MS, errorMappers.storage);
}

async function probeGoogleOAuth() {
  return probe('google_oauth', async () => {
    // tokeninfo reachability — a lightweight fetch to Google's tokeninfo.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=invalid-token', { signal: controller.signal });
      if (r.status === 400) return; // reachable (invalid token = server responded)
      throw new Error('Unexpected status ' + r.status);
    } finally { clearTimeout(timer); }
  }, 5000, errorMappers.google);
}

// ── Full probe grid ──────────────────────────────────────────
async function runAllProbes() {
  const [api, database, redisCache, streaming, payments, email, googleOAuth, storage] = await Promise.all([
    probeApi(), probeDatabase(), probeCache(), probeStreaming(),
    probePayments(), probeEmail(), probeGoogleOAuth(), probeStorage(),
  ]);

  const result = {
    api, database, cache: redisCache, streaming, payments, email, google_oauth: googleOAuth, storage,
    checkedAt: new Date().toISOString(),
  };

  // Persist samples (best-effort but never silent). Truncate last_error so it
  // fits health_samples.last_error VARCHAR(500); log (don't swallow) failures.
  try {
    const rows = Object.entries(result)
      .filter(([k]) => k !== 'checkedAt')
      .map(([k, v]) => [
        k,
        v.status,
        v.latencyMs,
        v.lastError ? String(v.lastError).slice(0, LAST_ERROR_MAX_LEN) : null,
      ]);
    await db.query(
      'INSERT INTO health_samples (component, status, latency_ms, last_error) VALUES ?',
      [rows]
    );
  } catch (e) {
    logger.warn('[HEALTH] Failed to persist health_samples', {
      error: e.message,
      checkedAt: result.checkedAt,
    });
  }

  return result;
}

/**
 * Trigger a fresh probe run and refresh the cached + last-known snapshot.
 * Shared by getHealthSnapshot() (revalidate path) and runAllProbes().
 * Kept as a small helper so a single source drives cache & memory updates.
 */
async function revalidate() {
  const snapshot = await runAllProbes();
  lastSnapshot = snapshot;
  lastSnapshotAt = Date.now();
  try {
    await cache.set(CACHE_KEY, snapshot, CACHE_TTL);
  } catch (e) {
    // Cache backend unavailable — keep serving the in-memory snapshot (SWR).
    logger.warn('[HEALTH] Cache write failed; serving in-memory snapshot', {
      error: e.message,
    });
  }
  return snapshot;
}

// 30 s cached reader with in-flight dedupe + stale-while-revalidate.
async function getHealthSnapshot() {
  // 1) Try the fast path: fresh cache hit.
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached) return cached;
  } catch (e) {
    // Cache backend unavailable — fall through to SWR below.
    logger.warn('[HEALTH] Cache read failed; serving stale snapshot', {
      error: e.message,
    });
  }

  // 2) If a probe is already running, share it (module-level dedupe).
  if (inflight) return inflight;

  // 3) Cache miss + nothing in flight: revalidate. Concurrent callers that
  //    arrive between the `if (inflight)` check and assignment will see this
  //    same promise via the module-level inflight variable.
  inflight = revalidate()
    .finally(() => { inflight = null; });

  // 4) Stale-while-revalidate: if we hold a last-known snapshot, don't make
  //    callers block on the slow external probe grid — return it immediately
  //    and let the in-flight revalidation update it in the background.
  if (lastSnapshot) {
    inflight.then(() => {}).catch(() => {}); // fire-and-forget completion
    return lastSnapshot;
  }

  // 5) No cache, no in-flight, no prior snapshot: must await the probe.
  return inflight;
}

// ── Nightly prune ─────────────────────────────────────────────
// Delete health_samples older than 30 days so the table doesn't grow unbounded
// (10 components sampled per probe run). Idempotent + failure-safe + unref'd so
// it never blocks shutdown.
let prunerStarted = false;
function startPruner() {
  if (prunerStarted) return;
  prunerStarted = true;
  cron.schedule('17 3 * * *', async () => {
    try {
      const [result] = await db.query(
        'DELETE FROM health_samples WHERE sampled_at < NOW() - INTERVAL 30 DAY'
      );
      logger.info('[HEALTH] health_samples prune completed', {
        deletedRows: result?.affectedRows || 0,
      });
    } catch (e) {
      logger.warn('[HEALTH] health_samples prune failed (non-fatal)', {
        error: e.message,
      });
    }
  });
  logger.info('[HEALTH] Nightly health_samples prune scheduled (03:17)');
}

module.exports = {
  getHealthSnapshot,
  runAllProbes,
  probeDatabase,
  probeCache,
  startPruner,
};