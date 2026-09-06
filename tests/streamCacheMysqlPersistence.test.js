// tests/streamCacheMysqlPersistence.test.js
// Hermetic unit tests for the "persistent-until-proven-dead" contract at the
// getOrResolve() / MySQL source-of-truth layer.
//
// Proves the core requirement end-to-end through the actual cache tier logic:
//   Once an AnimeHeaven URL is saved to MySQL, the saved URL is the SOURCE OF
//   TRUTH. An elapsed local `expires_at` (performance/reference TTL) is NOT
//   proof the upstream URL is dead, so a playable MySQL row is reused even if
//   it is old and even if Redis / the in-memory cache were lost (e.g. after a
//   Render restart). Only genuine upstream expiry (detected_expires_at passed)
//   or proven death (verification_status='invalid') triggers re-resolution.
//
// No real DB, Redis, cache or AnimeHeaven resolution occurs.
'use strict';

const assert = require('assert');

// ── Mocks (must be mounted BEFORE streamCacheService is loaded) ──

const captured = { queries: [] };

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

const mockProviderHttp = {
  request: async () => { throw new Error('mock (fail-open)'); },
  isProviderHealthy: () => true,
  recordSuccess() {}, recordFailure() {}, markTimeout() {},
  classifyError: () => ({ category: 'NETWORK', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}), getHealthStats: () => null,
};

// `dbRows`: array of rows returned for the episode_stream_cache SELECT
// (set per-test). null/[] → cache miss (forces the resolver).
let dbRows = null;

async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  captured.queries.push({ sql: s, params });
  if (s.includes('TIMESTAMPDIFF')) return [[]];                // lifetime probe (resolver path)
  if (s.startsWith('SELECT id, episode_id, provider, stream_type')) return [dbRows ? dbRows : []]; // findCachedStream
  if (s.startsWith('UPDATE episode_stream_cache')) return [[{ affectedRows: 0 }]];
  if (s.startsWith('DELETE FROM episode_stream_cache')) return [[{ affectedRows: 0 }]];
  if (s.startsWith('INSERT INTO episode_stream_cache')) return [[{ insertId: 1, affectedRows: 1 }]];
  return [[]];
}

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

delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];

const streamCacheService = require('../services/streamCacheService');
const inFlightResolverManager = require('../services/inFlightResolverManager');

// ── Helpers ────────────────────────────────────────────────

function makeRow(overrides) {
  const now = Date.now();
  return {
    id: 1,
    episode_id: 33,
    provider: 'animeheaven',
    stream_type: 'direct',
    stream_data: {
      provider: 'animeheaven',
      streamUrl: 'https://cdn.example.com/video.mp4?token=abc',
      sources: [{ url: 'https://cdn.example.com/video.mp4?token=abc', quality: '720' }],
      subtitles: [],
    },
    expires_at: new Date(now + 3600 * 1000),   // AniStrim reference TTL (future)
    detected_expires_at: null,                  // no real upstream expiry known
    expiry_source: 'unknown',
    verification_status: 'unknown',
    last_verified_at: null,
    last_used_at: new Date(now),
    resolved_at: new Date(now - 86400 * 1000),
    url_classification: null, classification_confidence: null, classification_reason: null,
    observed_first_success_at: null, observed_last_success_at: null,
    observed_first_failure_at: null, observed_lifetime_seconds: null,
    ...(overrides || {}),
  };
}

const EP = 33;
const PROVIDER = 'animeheaven';
const REDIS_KEY = streamCacheService.buildRedisKey(EP, PROVIDER);
const SAVED_URL = 'https://cdn.example.com/video.mp4?token=abc';

function makeResolverResult() {
  return {
    provider: 'animeheaven',
    streamUrl: SAVED_URL,
    sources: [{ url: SAVED_URL, quality: '720' }],
    subtitles: [],
  };
}
describe('Stream cache MySQL persistence — permanent-until-proven-dead', () => {
  beforeEach(() => {
    captured.queries.length = 0;
    dbRows = null;
    redisStore = new Map();               // simulate empty Redis / in-memory after a restart
    inFlightResolverManager.reset();      // clear in-memory resolver cache between tests
  });

  // ── A. active URL + expired expires_at = reusable ───────────
  it('A: ACTIVE URL with an elapsed expires_at stays reusable (age is not proof of death)', async () => {
    const now = Date.now();
    dbRows = [makeRow({
      expires_at: new Date(now - 24 * 3600 * 1000), // reference TTL passed a day ago
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    })];
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });
    assert.ok(got, 'should serve the saved URL from MySQL');
    assert.strictEqual(got.streamUrl, SAVED_URL, 'serves the SAVED (source-of-truth) URL');
    assert.strictEqual(resolverCalled, false, 'AnimeHeaven must NOT be contacted on a reusable hit');
  });

  // ── B. unknown URL + expired expires_at = reusable unless death known ─
  it('B: UNKNOWN URL with an elapsed expires_at stays reusable', async () => {
    const now = Date.now();
    dbRows = [makeRow({
      expires_at: new Date(now - 7 * 24 * 3600 * 1000), // a week old reference TTL
      verification_status: 'unknown',
      detected_expires_at: null,
    })];
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });
    assert.ok(got, 'should serve the saved URL from MySQL');
    assert.strictEqual(got.streamUrl, SAVED_URL, 'serves the SAVED URL');
    assert.strictEqual(resolverCalled, false, 'must NOT re-resolve an old but never-dead URL');
  });

  // ── C. detected upstream expiry = not reusable ──────────────
  it('C: a past genuine upstream expiry (detected_expires_at) is NOT reusable → re-resolution', async () => {
    const now = Date.now();
    dbRows = [makeRow({
      expires_at: new Date(now + 3600 * 1000),  // reference TTL still in the future
      detected_expires_at: new Date(now - 60000), // REAL upstream expiry passed
      verification_status: 'active',
      last_verified_at: new Date(now - 60000),
    })];
    let resolverCalled = false;
    await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });
    assert.strictEqual(resolverCalled, true, 'genuine upstream expiry is allowed to re-resolve');
  });

  // ── D. invalid URL = not reusable ───────────────────────────
  it('D: an INVALID (proven-dead) URL is NOT reusable → re-resolution', async () => {
    dbRows = [makeRow({
      expires_at: new Date(Date.now() + 3600 * 1000),
      verification_status: 'invalid',
      detected_expires_at: null,
    })];
    let resolverCalled = false;
    await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });
    assert.strictEqual(resolverCalled, true, 'proven-dead URL may be re-resolved');
  });

  // ── E. MySQL cached URL survives Redis/in-memory cache loss ─
  it('E: MySQL cached URL survives Redis/in-memory cache loss (Render restart) without re-resolution', async () => {
    dbRows = [makeRow({})];   // fresh, reusable row in MySQL only
    assert.strictEqual(redisStore.has(REDIS_KEY), false, 'precondition: Redis/in-memory is empty (restart)');

    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(EP, PROVIDER, async () => {
      resolverCalled = true; return makeResolverResult();
    });

    assert.ok(got, 'served from MySQL source of truth after cache loss');
    assert.strictEqual(got.streamUrl, SAVED_URL);
    assert.strictEqual(resolverCalled, false, 'no AnimeHeaven contact on a MySQL hit after restart');
    assert.ok(redisStore.has(REDIS_KEY), 'Redis repopulated from MySQL for next time');
  });
});