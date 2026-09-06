// tests/streamPlaybackVerification.test.js
// Hermetic tests for the INTERVAL/STATE-BASED cached-source verification model.
//
// Proves:
//   1. Active cached URL          → NO upstream HEAD on playback.
//   2. Recently verified URL      → NO upstream HEAD.
//   3. Verification interval elapsed → verification MAY occur (deferred).
//   4. Temporary 5xx              → URL remains reusable (never marked dead).
//   5. Timeout                    → URL remains reusable.
//   6. 429                        → URL remains reusable.
//   7. Confirmed 403              → source invalidated, fresh resolution permitted.
//   8. Confirmed 404              → source invalidated, fresh resolution permitted.
//   9. Confirmed 410              → source invalidated, fresh resolution permitted.
//  10. Cached reusable playback NEVER invokes the AnimeHeaven resolver.
//  + Observation hardening: a proxy timeout/network failure can no longer let a
//    cookie-less direct 403 invalidate a playable URL (must be mutually confirmed).
//
// No real DB, Redis, upstream or AnimeHeaven resolution occurs.
'use strict';

const assert = require('assert');

// ── Mocks (must be mounted BEFORE the services are loaded) ──

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {}, debugStream() {},
  stream() {}, streamAttempt() {},
};
const mockStreamDiag = { logCacheProbe() {}, logCacheCreation() {}, logFreshResolution() {} };
const mockMetrics = {
  increment() {}, recordSourceLifetime() {}, recordProviderCall() {}, recordInvalidation() {},
  recordProviderAvoided() {},
  getSnapshot: async () => ({}), reset() {}, counters: {}, sourceLifetimes: [],
};

let redisStore = new Map();
const mockCache = {
  async get(key) { return redisStore.get(key) || null; },
  async set(key, value) { redisStore.set(key, value); },
  async del(key) { redisStore.delete(key); },
  async delByPrefix(prefix) { for (const k of [...redisStore.keys()]) if (k.startsWith(prefix)) redisStore.delete(k); },
};

// Configurable upstream behaviour for providerHttp.request.
let requestBehavior = { resolve: true, status: 200 };
let requestHandler = null;   // optional per-test override (cfg) => response
let requestCalls = [];

const mockProviderHttp = {
  async request(cfg) {
    requestCalls.push({ method: cfg.method, url: cfg.url });
    if (requestHandler) return requestHandler(cfg);
    if (requestBehavior.resolve) {
      return { status: requestBehavior.status || 200, headers: requestBehavior.headers || {} };
    }
    const err = new Error(requestBehavior.timeout ? 'timeout' : 'upstream error');
    if (!requestBehavior.timeout) err.response = { status: requestBehavior.status || 0 };
    throw err;
  },
  isPermanentSourceFailure(status) {
    const s = Number(status) || 0;
    return s === 403 || s === 404 || s === 410;
  },
  isProviderHealthy: () => true,
  recordSuccess() {}, recordFailure() {}, markTimeout() {},
  classifyError: () => ({ category: 'NETWORK', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}), getHealthStats: () => null,
};

// dbRows: rows returned for the episode_stream_cache SELECT. The mock applies
// UPDATE effects (verification status changes) so subsequent SELECTs reflect
// invalidation exactly like the real DB would.
let dbRows = null;
const updateLog = [];

async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT id, episode_id, provider, stream_type')) return [dbRows ? dbRows : []];
  if (s.startsWith('UPDATE episode_stream_cache')) {
    updateLog.push({ sql: s, params });
    if (dbRows && dbRows[0]) {
      if (s.includes("verification_status = 'invalid'")) dbRows[0].verification_status = 'invalid';
      else if (params && (params[1] === 'active' || params[1] === 'invalid')) dbRows[0].verification_status = params[1];
    }
    return [[{ affectedRows: 1 }]];
  }
  if (s.startsWith('DELETE FROM episode_stream_cache')) return [[{ affectedRows: 0 }]];
  if (s.startsWith('INSERT INTO episode_stream_cache')) return [[{ insertId: 1, affectedRows: 1 }]];
  return [[]];
}

const mockUrlFingerprint = {
  fingerprint: (u) => { try { return { host: new URL(u).host }; } catch (_) { return null; } },
  compareUrls: (a, b) => ({ bothPresent: !!(a && b), sameUrl: a === b, hostChanged: false, tokenChanged: false }),
};
const mockAnimeHeavenProvider = { getPlaybackContext: async () => ({}) };

function mountMock(id, exportsObj) {
  const resolved = require.resolve(id);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

mountMock('../config/db', { query: mockDbQuery });
mountMock('../utils/logger', mockLogger);
mountMock('../utils/cacheService', mockCache);
mountMock('../utils/providerHttp', mockProviderHttp);
mountMock('../services/streamCacheMetrics', mockMetrics);
mountMock('../utils/streamDiagnostics', mockStreamDiag);
mountMock('../utils/urlFingerprint', mockUrlFingerprint);
mountMock('../services/animeHeavenProvider', mockAnimeHeavenProvider);

delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];
delete require.cache[require.resolve('../services/streamObservationService')];

const streamCacheService = require('../services/streamCacheService');
const streamObservationService = require('../services/streamObservationService');
const inFlightResolverManager = require('../services/inFlightResolverManager');
const { getSourceState, isReusable } = streamCacheService;

// ── Helpers ────────────────────────────────────────────────

function makeRow(overrides) {
  const now = Date.now();
  return {
    id: 1,
    episode_id: 77,
    provider: 'animeheaven',
    stream_type: 'direct',
    stream_data: {
      provider: 'animeheaven',
      streamUrl: SAVED_URL,
      sources: [{ url: SAVED_URL, quality: '720' }],
      subtitles: [],
    },
    expires_at: new Date(now + 3600 * 1000),
    detected_expires_at: null,
    expiry_source: 'unknown',
    verification_status: 'unknown',
    last_verified_at: null,
    last_used_at: new Date(now),
    resolved_at: new Date(now - 3600 * 1000),
    last_direct_check_at: new Date(now),        // observation not due by default
    url_classification: null, classification_confidence: null, classification_reason: null,
    observed_first_success_at: null, observed_last_success_at: null,
    observed_first_failure_at: null, observed_lifetime_seconds: null,
    ...(overrides || {}),
  };
}

const EP = 77;
const PROVIDER = 'animeheaven';
const SAVED_URL = 'https://cdn.example.com/video.mp4?token=abc';

function makeResolverResult() {
  return { provider: 'animeheaven', streamUrl: SAVED_URL, sources: [{ url: SAVED_URL, quality: '720' }], subtitles: [] };
}

async function settleDeferred() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 10));
}

function invalidated() {
  return updateLog.some(u => u.sql.includes("verification_status = 'invalid'"));
}

describe('Interval/state-based cached-source verification', () => {
  beforeEach(() => {
    dbRows = null;
    redisStore = new Map();
    inFlightResolverManager.reset();
    requestCalls = [];
    updateLog.length = 0;
    requestBehavior = { resolve: true, status: 200 };
  });

  // ── 1. Active cached URL → no HEAD on every playback ──────
  it('1: an ACTIVE, recently verified URL is NOT verification-due — no upstream HEAD', async () => {
    const now = Date.now();
    const row = makeRow({ verification_status: 'active', last_verified_at: new Date(now - 5 * 60 * 1000) });
    assert.strictEqual(getSourceState(row), 'active');
    assert.strictEqual(isReusable(row), true);
    assert.strictEqual(streamCacheService.isSourceVerificationDue(row), false, 'recently verified → not due');
    assert.strictEqual(streamCacheService.scheduleVerificationIfNeeded(EP, PROVIDER, row), false, 'nothing scheduled');
    await settleDeferred();
    assert.strictEqual(requestCalls.length, 0, 'NO upstream request of any kind');
  });

  // ── 2. Recently verified URL → no HEAD ─────────────────────
  it('2: an UNKNOWN source verified a minute ago is NOT due — no upstream HEAD', async () => {
    const now = Date.now();
    const row = makeRow({ verification_status: 'unknown', last_verified_at: new Date(now - 60 * 1000) });
    assert.strictEqual(streamCacheService.isSourceVerificationDue(row), false);
    assert.strictEqual(streamCacheService.scheduleVerificationIfNeeded(EP, PROVIDER, row), false);
    await settleDeferred();
    assert.strictEqual(requestCalls.length, 0, 'recently verified URL must not be re-HEADed');
  });

  // ── 3. Verification interval elapsed → verification may occur ─
  it('3: a source whose verification interval elapsed is DUE and one deferred verification runs', async () => {
    const now = Date.now();
    const row = makeRow({ verification_status: 'active', last_verified_at: new Date(now - 31 * 60 * 1000) });
    dbRows = [row];                                // mock DB mutates this row
    assert.strictEqual(streamCacheService.isSourceVerificationDue(row), true, 'interval elapsed → due');
    assert.strictEqual(streamCacheService.scheduleVerificationIfNeeded(EP, PROVIDER, row), true, 'scheduled (deferred)');
    await settleDeferred();
    assert.strictEqual(requestCalls.length, 1, 'exactly ONE deferred upstream check');
    assert.strictEqual(requestCalls[0].url, SAVED_URL);
    assert.ok(!invalidated(), 'a successful verification must not invalidate');
    assert.strictEqual(dbRows[0].verification_status, 'active', 'verification refreshed to active');
  });

  // ── 4/5/6. Temporary failures never mark the URL dead ──────
  for (const [label, behavior] of [
    ['4: a temporary 5xx during verification leaves the URL reusable', { resolve: false, status: 500 }],
    ['5: a timeout during verification leaves the URL reusable', { resolve: false, timeout: true }],
    ['6: a 429 during verification leaves the URL reusable', { resolve: false, status: 429 }],
  ]) {
    it(label, async () => {
      requestBehavior = behavior;
      const row = makeRow({});                       // never verified → due
      dbRows = [row];                                // mock DB mutates this row
      assert.strictEqual(streamCacheService.scheduleVerificationIfNeeded(EP, PROVIDER, row), true);
      await settleDeferred();
      assert.ok(requestCalls.length >= 1, 'verification ran');
      assert.strictEqual(invalidated(), false, 'temporary failure MUST NOT mark the source dead');
      assert.strictEqual(isReusable(row), true, 'row still reusable');
      // Playback continues with the saved URL; no AnimeHeaven resolution.
      let resolverCalled = false;
      const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
        resolverCalled = true; return makeResolverResult();
      });
      assert.ok(got, 'still served from cache');
      assert.strictEqual(got.streamUrl, SAVED_URL);
      assert.strictEqual(resolverCalled, false, 'no AnimeHeaven resolution after a temporary verification failure');
    });
  }

  // ── 7/8/9. Confirmed 403/404/410 → invalidated, fresh resolution permitted ─
  for (const [label, status] of [
    ['7: a confirmed 403 invalidates the source and permits fresh resolution', 403],
    ['8: a confirmed 404 invalidates the source and permits fresh resolution', 404],
    ['9: a confirmed 410 invalidates the source and permits fresh resolution', 410],
  ]) {
    it(label, async () => {
      requestBehavior = { resolve: false, status };
      const row = makeRow({});
      dbRows = [row];                                // mock DB mutates this row
      assert.strictEqual(streamCacheService.scheduleVerificationIfNeeded(EP, PROVIDER, row), true);
      await settleDeferred();
      assert.strictEqual(invalidated(), true, `${status} is strong evidence → source invalidated`);
      assert.strictEqual(isReusable(row), false, 'source no longer reusable');
      // Next playback: fresh resolution is now permitted.
      let resolverCalled = false;
      await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
        resolverCalled = true; return makeResolverResult();
      });
      assert.strictEqual(resolverCalled, true, 'fresh AnimeHeaven resolution after confirmed death');
      // The row is PRESERVED (UPDATE, not DELETE) — state machine, not a hard delete.
      assert.ok(updateLog.some(u => u.sql.startsWith('UPDATE') && u.sql.includes("verification_status = 'invalid'")));
      assert.ok(!updateLog.some(u => u.sql.startsWith('DELETE')), 'no hard delete of the historical row');
    });
  }

  // ── 10. Cached playback never invokes the AnimeHeaven resolver ─
  it('10: reusable cached playback serves the saved URL with ZERO upstream requests and NO resolver call', async () => {
    const now = Date.now();
    dbRows = [makeRow({ verification_status: 'active', last_verified_at: new Date(now - 60 * 1000) })];
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });
    assert.ok(got, 'served from cache');
    assert.strictEqual(got.streamUrl, SAVED_URL, 'the SAVED URL is the source of truth');
    assert.strictEqual(resolverCalled, false, 'AnimeHeaven resolver NEVER invoked while source is reusable');
    assert.strictEqual(requestCalls.length, 0, 'zero upstream validation on normal playback');
  });
});

describe('Observation invalidation hardening (mutual confirmation required)', () => {
  beforeEach(() => {
    redisStore = new Map();
    inFlightResolverManager.reset();
    requestCalls = [];
    updateLog.length = 0;
    // streamObservationService resolves streamCacheService LAZILY inside
    // observeOnCacheHit (require at call time). Other spec files re-mount
    // require.cache entries for that module, so pin OUR instance here to keep
    // this suite hermetic regardless of file load order.
    const resolvedCache = require.resolve('../services/streamCacheService');
    require.cache[resolvedCache] = {
      id: resolvedCache, filename: resolvedCache, loaded: true, exports: streamCacheService,
    };
  });

  function obsRow(overrides) {
    return makeRow({
      last_direct_check_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // observation due
      ...(overrides || {}),
    });
  }

  it('a cookie-less direct 403 with a proxy TIMEOUT does NOT invalidate the URL', async () => {
    requestHandler = async (cfg) => {
      if (cfg.method === 'head') { const e = new Error('403'); e.response = { status: 403 }; throw e; }
      const e = new Error('timeout'); throw e;   // proxy GET: network/timeout, no status
    };
    try {
      await streamObservationService.observeOnCacheHit(EP, PROVIDER, obsRow(), {});
      await settleDeferred();
      assert.strictEqual(invalidated(), false, 'proxy timeout is temporary evidence only — URL stays reusable');
    } finally { requestHandler = null; }
  });

  it('a direct 403 CONFIRMED by a playback-faithful proxy 403 invalidates via the state machine (row preserved)', async () => {
    requestHandler = async () => {
      const e = new Error('403');
      e.response = { status: 403 };
      throw e;
    };
    try {
      await streamObservationService.observeOnCacheHit(EP, PROVIDER, obsRow(), {});
      await settleDeferred();
      assert.strictEqual(invalidated(), true, 'mutually confirmed 403 → invalidated');
      assert.ok(!updateLog.some(u => u.sql.startsWith('DELETE')), 'row preserved via invalidateSource, not hard-deleted');
    } finally { requestHandler = null; }
  });
});
