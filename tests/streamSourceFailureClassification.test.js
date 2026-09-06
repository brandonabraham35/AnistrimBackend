// tests/streamSourceFailureClassification.test.js
// Tests for the PERMANENT vs TEMPORARY source-failure classification.
//
// PERMANENT (strong evidence → may invalidate → single-flight re-resolution):
//   403, 404, 410
// TEMPORARY (MUST NOT invalidate → saved URL stays authoritative):
//   timeout, ECONNRESET, ECONNREFUSED, 429, 500, 502, 503, 504, DNS errors
//
// Also proves the HEAD-vs-GET distinction: a permanent GET/range playback
// failure invalidates the source even when a HEAD verification succeeded,
// while client disconnects (ECONNRESET, no status) never mark the source dead,
// and temporary-failure bursts can never cause a re-resolution storm.
//
// No real DB, Redis, upstream or AnimeHeaven resolution occurs.
'use strict';

const assert = require('assert');

// ── Mocks (mounted BEFORE the services load) ───────────────

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

// Configurable upstream behaviour.
let upstream = { mode: 'ok' };   // 'ok' | {status} | {code} | {timeout:true}
let upstreamCalls = [];
const mockProviderHttp = {
  async request(cfg) {
    upstreamCalls.push({ method: cfg.method, url: cfg.url });
    if (upstream.mode === 'ok') return { status: upstream.status || 206, headers: {} };
    const e = new Error(upstream.timeout ? 'timeout of 4000ms exceeded' : (upstream.code || 'upstream error'));
    if (upstream.code) e.code = upstream.code;
    if (upstream.status) e.response = { status: upstream.status };
    throw e;
  },
  isProviderHealthy: () => true,
  recordSuccess() {}, recordFailure() {}, markTimeout() {},
  classifyError: () => ({ category: 'NETWORK', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}), getHealthStats: () => null,
};

let dbRows = null;
const dbLog = [];
async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  dbLog.push(s);
  if (s.startsWith('SELECT id, episode_id, provider, stream_type')) return [dbRows ? dbRows : []];
  if (s.startsWith('UPDATE episode_stream_cache')) {
    if (dbRows && dbRows[0]) {
      if (s.includes("verification_status = 'invalid'")) {
        dbRows[0].verification_status = 'invalid';
        if (params) dbRows[0].last_verified_at = params[0] instanceof Date ? params[0] : new Date();
      } else if (params && (params[1] === 'active' || params[1] === 'invalid')) {
        dbRows[0].verification_status = params[1];
        dbRows[0].last_verified_at = params[0] instanceof Date ? params[0] : new Date();
      }
    }
    return [[{ affectedRows: 1 }]];
  }
  if (s.startsWith('INSERT INTO episode_stream_cache')) return [[{ insertId: 1, affectedRows: 1 }]];
  if (s.startsWith('DELETE FROM episode_stream_cache')) return [[{ affectedRows: 0 }]];
  return [[]];
}

const mockUrlFingerprint = {
  fingerprint: (u) => { try { return { host: new URL(u).host }; } catch (_) { return null; } },
  compareUrls: (a, b) => ({ bothPresent: !!(a && b), sameUrl: a === b, hostChanged: false, tokenChanged: false }),
};
const mockAhp = { getPlaybackContext: async () => ({}) };

// Capture the REAL classifier before the request-mock shadows the module —
// the mock must keep the real death definition while stubbing network I/O.
// IMPORTANT: evict any mock another test file left in the require cache first,
// otherwise (in a full-suite run) this captures a MOCK without the classifier.
// Also evict the full streaming module tree so this file's mocks wire cleanly
// regardless of what prior suites loaded into the cache.
const streamingModules = [
  '../utils/providerHttp',
  '../config/streamCache',
  '../services/streamCacheService',
  '../services/inFlightResolverManager',
  '../services/streamingService',
  '../services/streamObservationService',
  '../utils/urlFingerprint',
  '../services/animeHeavenProvider',
];
for (const mod of streamingModules) {
  const resolved = require.resolve(mod);
  delete require.cache[resolved];
}
const realProviderHttp = require('../utils/providerHttp');

function mountMock(id, exportsObj) {
  const resolved = require.resolve(id);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

mountMock('../config/db', { query: mockDbQuery });
mountMock('../utils/logger', mockLogger);
mountMock('../utils/cacheService', mockCache);
mountMock('../utils/providerHttp', { ...mockProviderHttp, isPermanentSourceFailure: realProviderHttp.isPermanentSourceFailure });
mountMock('../services/streamCacheMetrics', mockMetrics);
mountMock('../utils/streamDiagnostics', mockStreamDiag);
mountMock('../utils/urlFingerprint', mockUrlFingerprint);
mountMock('../services/animeHeavenProvider', mockAhp);

delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];

const streamCacheService = require('../services/streamCacheService');
const inFlightResolverManager = require('../services/inFlightResolverManager');
const { isPermanentSourceFailure } = realProviderHttp;

// ── Helpers ────────────────────────────────────────────────

const EP = 555;
const PROVIDER = 'animeheaven';
const SAVED_URL = 'https://cdn.example.com/v.mp4?token=t';

function makeRow() {
  const now = Date.now();
  return {
    id: 1, episode_id: EP, provider: PROVIDER, stream_type: 'direct',
    stream_data: { provider: PROVIDER, streamUrl: SAVED_URL, sources: [{ url: SAVED_URL, quality: '720' }], subtitles: [] },
    expires_at: new Date(now + 3600 * 1000), detected_expires_at: null, expiry_source: 'unknown',
    verification_status: 'unknown', last_verified_at: null, last_used_at: new Date(now),
    resolved_at: new Date(now - 3600 * 1000), last_direct_check_at: new Date(now),
    url_classification: null, classification_confidence: null, classification_reason: null,
    observed_first_success_at: null, observed_last_success_at: null,
    observed_first_failure_at: null, observed_lifetime_seconds: null,
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 10));
}

describe('central permanent-vs-temporary classifier (providerHttp)', () => {
  it('classifies 403/404/410 as PERMANENT', () => {
    for (const s of [403, 404, 410]) assert.strictEqual(isPermanentSourceFailure(s), true, `${s} must be permanent`);
  });
  it('classifies timeouts / resets / 429 / 5xx / DNS / empty as TEMPORARY', () => {
    for (const s of [0, 408, 429, 500, 502, 503, 504]) assert.strictEqual(isPermanentSourceFailure(s), false, `${s} must be temporary`);
    assert.strictEqual(isPermanentSourceFailure(null), false);
    assert.strictEqual(isPermanentSourceFailure(undefined), false);
  });
});

describe('verification outcomes (HEAD → Range path, verifyAndRecord)', () => {
  beforeEach(() => {
    dbRows = [makeRow()];
    redisStore = new Map();
    inFlightResolverManager.reset();
    upstreamCalls = [];
    upstream = { mode: 'ok' };
  });

  // ── PERMANENT: 403 / 404 / 410 → invalidate, re-resolution permitted ──
  for (const status of [403, 404, 410]) {
    it(`${status} → source invalidated and no longer reusable`, async () => {
      upstream = { mode: 'throw', status };
      const row = dbRows[0];
      const r = await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
      assert.strictEqual(r.alive, false, `${status} must be classified dead`);
      await streamCacheService.invalidateSource(EP, PROVIDER, status);
      assert.strictEqual(streamCacheService.isReusable(row), false, 'source no longer reusable');
      assert.ok(dbLog.some(s => s.startsWith('UPDATE') && s.includes("verification_status = 'invalid'")), 'row preserved via UPDATE (state machine)');
      assert.ok(!dbLog.some(s => s.startsWith('DELETE')), 'never hard-deleted');
    });
  }

  // ── TEMPORARY: 5xx / 429 / timeout / network → keep reusable ──
  const temporary = [
    ['500 keeps the source reusable', { mode: 'throw', status: 500 }],
    ['502 keeps the source reusable', { mode: 'throw', status: 502 }],
    ['503 keeps the source reusable', { mode: 'throw', status: 503 }],
    ['504 keeps the source reusable', { mode: 'throw', status: 504 }],
    ['429 keeps the source reusable', { mode: 'throw', status: 429 }],
    ['timeout keeps the source reusable', { mode: 'throw', timeout: true }],
    ['ECONNRESET keeps the source reusable', { mode: 'throw', code: 'ECONNRESET' }],
    ['ECONNREFUSED keeps the source reusable', { mode: 'throw', code: 'ECONNREFUSED' }],
    ['ENOTFOUND (DNS) keeps the source reusable', { mode: 'throw', code: 'ENOTFOUND' }],
  ];
  for (const [label, behavior] of temporary) {
    it(label, async () => {
      upstream = behavior;
      const row = dbRows[0];
      const r = await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
      assert.strictEqual(r.alive, true, 'temporary failures are fail-open');
      assert.strictEqual(streamCacheService.isReusable(row), true, 'saved URL stays authoritative');
      // And playback still uses the saved URL — no AnimeHeaven resolution.
      let resolverCalled = false;
      const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => { resolverCalled = true; return null; });
      assert.strictEqual(resolverCalled, false, 'temporary failure must NOT cause re-resolution');
      assert.strictEqual(got.streamUrl, SAVED_URL);
    });
  }

  // ── SUCCESS: 200 / 206 range → keep reusable, mark active ──
  for (const status of [200, 206]) {
    it(`successful ${status} (${status === 206 ? 'range' : 'full'}) keeps the source reusable and marks it active`, async () => {
      upstream = { mode: 'ok', status };
      const row = dbRows[0];
      const r = await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
      assert.strictEqual(r.alive, true);
      assert.strictEqual(streamCacheService.isReusable(row), true);
      assert.strictEqual(row.verification_status, 'active');
      assert.strictEqual(streamCacheService.getSourceState(row), 'active');
    });
  }
});

// ─────────────────────────────────────────────────────────────
// HEAD-vs-GET distinction + client disconnect + storm protection
// ─────────────────────────────────────────────────────────────

// Extra mocks needed to load the real streamProxyController.
mountMock('../utils/streamProxyStore', { createStream: () => 'sid', recordByte: () => {}, closeStream: () => {} });
mountMock('../utils/hlsRewriter', { rewriteHlsManifest: (u) => u, isHlsUri: () => false, isHlsContentType: () => false });
const streamDiagMock = {
  ...mockStreamDiag,
  logPlaybackFailure() {},
};
mountMock('../utils/streamDiagnostics', streamDiagMock);
const streamProxyController = require('../controllers/streamProxyController');

describe('HEAD success + real GET playback failure (authoritative signal)', () => {
  beforeEach(() => {
    dbRows = [makeRow()];
    redisStore = new Map();
    inFlightResolverManager.reset();
    upstreamCalls = [];
    upstream = { mode: 'ok' };
    dbLog.length = 0;
  });

  it('a HEAD-verified (active) source is STILL invalidated when the actual GET playback receives a permanent 403', async () => {
    upstream = { mode: 'ok', status: 200 };
    const row = dbRows[0];
    const r = await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
    assert.strictEqual(r.alive, true, 'HEAD succeeded — source marked active');
    assert.strictEqual(row.verification_status, 'active');
    assert.strictEqual(streamCacheService.isReusable(row), true);

    // Actual playback (proxy GET/range with cookies) then hits a hard 403.
    streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, 403);
    await settle();
    assert.strictEqual(dbRows[0].verification_status, 'invalid', 'GET playback failure is authoritative');
    assert.strictEqual(streamCacheService.isReusable(row), false, 'source no longer reusable → next playback re-resolves');
  });

  it('a GET playback 410 after successful HEAD also invalidates (authoritative GET signal)', async () => {
    upstream = { mode: 'ok', status: 206 };
    const row = dbRows[0];
    await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
    assert.strictEqual(row.verification_status, 'active');
    streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, 410);
    await settle();
    assert.strictEqual(streamCacheService.isReusable(row), false);
  });

  it('a client disconnect (ECONNRESET, no status) during playback NEVER marks the source dead', async () => {
    upstream = { mode: 'ok', status: 206 };
    const row = dbRows[0];
    await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
    assert.strictEqual(row.verification_status, 'active');
    streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, 0);      // disconnect → no upstream status
    streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, null);   // defensive: no status at all
    await settle();
    assert.strictEqual(row.verification_status, 'active', 'client disconnect is temporary evidence');
    assert.strictEqual(streamCacheService.isReusable(row), true, 'saved URL stays authoritative');
  });

  it('temporary playback problems (429/503/timeout) NEVER invalidate via the GET signal', async () => {
    upstream = { mode: 'ok', status: 206 };
    const row = dbRows[0];
    await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
    for (const s of [429, 503, 502, 500, 504]) {
      streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, s);
    }
    await settle();
    assert.strictEqual(row.verification_status, 'active', '5xx/429 are temporary evidence');
    assert.strictEqual(streamCacheService.isReusable(row), true);
  });

  it('a temporary-failure burst cannot cause a re-resolution storm; one confirmed 403 invalidates; single-flight caps re-resolution at ONE', async () => {
    const row = dbRows[0];
    // 50 rapid temporary failures through BOTH the verification path and the GET signal.
    const temporary = [429, 500, 502, 503, 504, 0, null];
    for (let i = 0; i < 50; i++) {
      const s = temporary[i % temporary.length];
      streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, s);
      upstream = { mode: 'throw', status: s || 500 };
      await streamCacheService.verifyAndRecord(row.id, SAVED_URL, {});
    }
    await settle();
    upstream = { mode: 'ok' };
    assert.strictEqual(streamCacheService.isReusable(row), true, 'temporary burst never invalidates');

    // The burst must NOT have caused any AnimeHeaven resolution.
    let resolverCalled = 0;
    const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => { resolverCalled++; return null; });
    assert.strictEqual(resolverCalled, 0, 'temporary storm → zero AnimeHeaven resolutions');
    assert.strictEqual(got.streamUrl, SAVED_URL, 'playback continues on the saved URL');

    // ONE confirmed 403 → invalidates → 100 concurrent requests produce EXACTLY ONE re-resolution.
    streamProxyController.noteUpstreamPlaybackFailure({ episodeId: EP }, 403);
    await settle();
    assert.strictEqual(streamCacheService.isReusable(row), false, 'confirmed 403 invalidates');

    let freshResolutions = 0;
    const replacement = { provider: PROVIDER, streamUrl: 'https://cdn.example.com/replacement.mp4', sources: [{ url: 'https://cdn.example.com/replacement.mp4', quality: '720' }], subtitles: [] };
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      streamCacheService.getOrResolve(EP, PROVIDER, async () => { freshResolutions++; return replacement; })
    ));
    assert.strictEqual(freshResolutions, 1, 'single-flight: 100 waiters → exactly ONE fresh AnimeHeaven resolution');
    for (const r2 of results) assert.strictEqual(r2.streamUrl, replacement.streamUrl, 'all callers receive the same replacement result');
  });
});

