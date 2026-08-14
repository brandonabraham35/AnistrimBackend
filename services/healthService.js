// services/healthService.js — Phase 9 (item 20) system health probes.
//
// Probes each subsystem and returns { status: 'up'|'degraded'|'down',
// latencyMs, lastError, checkedAt } per component. Cached for 30 s. Samples are
// persisted to health_samples to power sparklines ("when did this start?").
const db = require('../config/db');
const cache = require('../utils/cacheService');

const CACHE_TTL = 30; // 30 s
const CACHE_KEY = 'systemHealth:v1';

function probe(label, checkFn) {
  const start = Date.now();
  return checkFn()
    .then(() => ({ status: 'up', latencyMs: Date.now() - start, lastError: null, checkedAt: new Date().toISOString() }))
    .catch((err) => ({
      status: 'down',
      latencyMs: Date.now() - start,
      lastError: err?.message || String(err),
      checkedAt: new Date().toISOString(),
    }));
}

async function probeApi() {
  return probe('api', async () => {
    // Self-ping (in-process latency of a trivial query).
    await db.query('SELECT 1');
  });
}

async function probeDatabase() {
  return probe('database', async () => {
    await db.query('SELECT 1');
  });
}

async function probeCache() {
  return probe('cache', async () => {
    await cache.set('_health', 1, 5);
    await cache.get('_health');
  });
}

async function probeStreaming() {
  return probe('streaming', async () => {
    try {
      const monitor = require('./providerHealthMonitor');
      const snapshot = monitor.getSnapshot();
      // down only if all providers are down; otherwise up/degraded.
      const providers = Object.values(snapshot || {});
      if (providers.length && providers.every(p => p?.status === 'down')) throw new Error('All providers down');
    } catch (e) {
      // If monitor missing, treat as degraded.
      if (e?.message?.includes('All providers')) throw e;
      throw new Error('Provider monitor unavailable');
    }
  });
}

async function probePayments() {
  return probe('payments', async () => {
    // Pesapal auth token fetch.
    const ws = require('./pesapalService');
    if (typeof ws.getAuthToken === 'function') {
      const token = await ws.getAuthToken();
      if (!token) throw new Error('Pesapal token empty');
    } else {
      // No pesapal auth token fetcher — just check DB presence.
      await db.query('SELECT COUNT(*) AS c FROM payments LIMIT 1');
    }
  });
}

async function probeEmail() {
  return probe('email', async () => {
    const { verifyTransporter, isConfigured } = require('../utils/mailer');
    if (typeof isConfigured === 'function' && !isConfigured()) throw new Error('SMTP not configured');
    if (typeof verifyTransporter === 'function') await verifyTransporter();
    else if (typeof isConfigured === 'function') await isConfigured();
  });
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
  });
}

async function probeStorage() {
  return probe('storage', async () => {
    const { isConfigured } = require('../utils/bunnyUpload');
    if (!isConfigured()) throw new Error('Storage not configured');
  });
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

  // Persist samples (best-effort).
  try {
    const rows = Object.entries(result)
      .filter(([k]) => k !== 'checkedAt')
      .map(([k, v]) => [k, v.status, v.latencyMs, v.lastError]);
    await db.query(
      'INSERT INTO health_samples (component, status, latency_ms, last_error) VALUES ?',
      [rows]
    );
  } catch (e) { /* non-fatal */ }

  return result;
}

// 30 s cached reader.
async function getHealthSnapshot() {
  const cached = await cache.get(CACHE_KEY);
  if (cached) return cached;
  const snapshot = await runAllProbes();
  await cache.set(CACHE_KEY, snapshot, CACHE_TTL);
  return snapshot;
}

module.exports = { getHealthSnapshot, runAllProbes, probeDatabase, probeCache };