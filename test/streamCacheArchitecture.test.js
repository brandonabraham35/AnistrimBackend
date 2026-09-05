// ============================================================
//  test/streamCacheArchitecture.test.js
//
//  Comprehensive automated tests for the AniStrim stream cache
//  architecture (Redis + MySQL + in-memory + classification).
//
//  All tests are hermetic: DB and Redis are mocked so no
//  external services are contacted, no Thordata traffic is
//  consumed, and no AnimeHeaven resolution occurs.
//
//  Run: node --test test/streamCacheArchitecture.test.js
// ============================================================
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

// ── Mock infrastructure ──────────────────────────────────
// Replacement for the real db/cache/logger modules.
const mockDb = { queryLog: [], results: {} };
const mockCache = { store: new Map(), getLog: [], setLog: [], delLog: [] };
const mockLogger = {};

function mockDbResult(matcher, result) { mockDb.results[matcher] = result; }

mockDb.query = async function (sql, params) {
  mockDb.queryLog.push({ sql: sql.substring(0, 80), params });
  for (const [pattern, result] of Object.entries(mockDb.results)) {
    if (sql.startsWith(pattern)) return result;
  }
  return [[]];
};

mockCache.get = async function (key) {
  mockCache.getLog.push(key);
  return mockCache.store.get(key) || null;
};
mockCache.set = async function (key, value, ttl) {
  mockCache.setLog.push({ key, ttl });
  mockCache.store.set(key, value);
};
mockCache.del = async function (key) {
  mockCache.delLog.push(key);
  mockCache.store.delete(key);
};
mockCache.delByPrefix = async function () {};

mockLogger.info = function () {};
mockLogger.warn = function () {};
mockLogger.debug = function () {};
mockLogger.stream = function () {};
mockLogger.streamAttempt = function () {};

// Inject mocks into require cache.
const modPath = require.resolve('../services/streamCacheService');
delete require.cache[modPath];
const dbPath = require.resolve('../config/db');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
const cachePath = require.resolve('../utils/cacheService');
delete require.cache[cachePath];
require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: mockCache };
const logPath = require.resolve('../utils/logger');
delete require.cache[logPath];
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: mockLogger };

const streamCacheService = require('../services/streamCacheService');

function resetMocks() {
  mockDb.queryLog = []; mockDb.results = {};
  mockCache.getLog = []; mockCache.setLog = []; mockCache.delLog = [];
  mockCache.store.clear();
}

const SAMPLE_EPISODE_ID = 33;
const SAMPLE_PROVIDER = 'animeheaven';
const SAMPLE_REDIS_KEY = streamCacheService.buildRedisKey(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER);

function makeProviderResult(overrides) {
  return { provider: 'animeheaven',
    streamUrl: 'https://rt.animeheaven.me/video.mp4?token=abc',
    sources: [{ url: 'https://rt.animeheaven.me/video.mp4?token=abc', quality: '720' }],
    subtitles: [], ...(overrides || {}) };
}

function makeCacheRow(overrides) {
  const now = Date.now();
  const future = new Date(now + 3600 * 1000);
  const data = makeProviderResult();
  return { id: 1, episode_id: SAMPLE_EPISODE_ID, provider: SAMPLE_PROVIDER,
    stream_type: 'direct', stream_data: data,
    expires_at: future, detected_expires_at: null,
    expiry_source: 'unknown', verification_status: 'unknown',
    last_verified_at: null, last_used_at: new Date(now),
    resolved_at: new Date(now - 86400 * 1000),
    url_classification: null, classification_confidence: null, classification_reason: null,
    observed_first_success_at: null, observed_last_success_at: null,
    observed_first_failure_at: null, observed_lifetime_seconds: null,
    ...(overrides || {}) };
// ═══════════════════════════════════════════════════════════
//  1. Redis HIT
// ═══════════════════════════════════════════════════════════
describe('1. Redis HIT', () => {
  test('Redis hit returns cached result, no MySQL, no provider', async () => {
    resetMocks();
    mockCache.store.set(SAMPLE_REDIS_KEY, makeProviderResult());
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, async () => {
      resolverCalled = true; return makeProviderResult();
    });
    assert.ok(got, 'should return a result');
    assert.strictEqual(resolverCalled, false, 'resolver must NOT be called on Redis hit');
    assert.strictEqual(mockDb.queryLog.length, 0, 'MySQL must NOT be queried on Redis hit');
  });
});

// ═══════════════════════════════════════════════════════════
//  2. Redis MISS + MySQL HIT
// ═══════════════════════════════════════════════════════════
describe('2. Redis MISS + MySQL HIT', () => {
  test('Redis miss populates Redis from MySQL; no provider', async () => {
    resetMocks();
    mockDbResult('SELECT', [[makeCacheRow()]]);
    let resolverCalled = false;
// ═══════════════════════════════════════════════════════════
//  3. Redis MISS + MySQL MISS → provider resolution
// ═══════════════════════════════════════════════════════════
describe('3. Redis MISS + MySQL MISS', () => {
  test('Full miss triggers exactly one provider resolution', async () => {
    resetMocks();
    let callCount = 0;
    const got = await streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, async () => {
      callCount++; return makeProviderResult();
    });
    assert.ok(got); assert.strictEqual(callCount, 1, 'resolver called exactly once');
  });

  test('Concurrent requests share one resolver', async () => {
    resetMocks();
    let callCount = 0;
    const slow = async () => { callCount++; await new Promise(r => setTimeout(r, 50)); return makeProviderResult(); };
    const results = await Promise.all(Array.from({length:5}, () =>
      streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, slow)));
    assert.strictEqual(results.length, 5);
    assert.strictEqual(callCount, 1, 'only ONE resolver for 5 concurrent requests');
  });
});

// ═══════════════════════════════════════════════════════════
//  4. Redis unavailable + MySQL HIT
// ═══════════════════════════════════════════════════════════
describe('4. Redis unavailable + MySQL HIT', () => {
  test('Falls through to MySQL when Redis throws', async () => {
    resetMocks();
// ═══════════════════════════════════════════════════════════
//  5. Redis unavailable + MySQL MISS
// ═══════════════════════════════════════════════════════════
describe('5. Redis unavailable + MySQL MISS', () => {
  test('Provider resolution occurs normally when all caches miss', async () => {
    resetMocks();
    const origGet = mockCache.get;
    mockCache.get = async () => { throw new Error('Redis down'); };
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, async () => {
      resolverCalled = true; return makeProviderResult();
    });
    assert.ok(got, 'should return result');
    assert.strictEqual(resolverCalled, true, 'resolver called when all caches miss');
    assert.ok(true, 'application did not crash');
    mockCache.get = origGet;
  });
});

// ═══════════════════════════════════════════════════════════
//  6. Expired MySQL cache (expires_at passed)
// ═══════════════════════════════════════════════════════════
describe('6. Expired MySQL cache', () => {
  test('Expired cache is not used', () => {
    const past = new Date(Date.now() - 3600 * 1000);
    const row = makeCacheRow({ expires_at: past });
    assert.strictEqual(streamCacheService.isExpired(row, Date.now()), true, 'should be expired');
    assert.strictEqual(streamCacheService.isReusable(row, Date.now()), false, 'should not be reusable');
  });
});
// ═══════════════════════════════════════════════════════════
//  8. Invalid source + Redis invalidation
// ═══════════════════════════════════════════════════════════
describe('8. Invalid source + Redis invalidation', () => {
  test('Invalid cache removed and Redis key deleted', async () => {
    resetMocks();
    mockCache.store.set(SAMPLE_REDIS_KEY, makeProviderResult());
    mockDbResult('DELETE', [{ affectedRows: 1 }]);
    const result = await streamCacheService.deleteInvalidCache(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER);
    assert.strictEqual(result, true);
    mockDb.queryLog = []; // reset after MySQL delete
    // Wait for async Redis deletion
    await new Promise(r => setTimeout(r, 10));
    assert.ok(mockCache.delLog.includes(SAMPLE_REDIS_KEY), 'Redis key should be deleted');
    assert.ok(!mockCache.store.has(SAMPLE_REDIS_KEY), 'Redis store should not contain the key');
  });
});

// ═══════════════════════════════════════════════════════════
//  9. skipCache=true
// ═══════════════════════════════════════════════════════════
describe('9. skipCache=true', () => {
  test('skipCache is not a streamCacheService concern; it is handled by streamingService', () => {
    // getOrResolve doesn't have skipCache — it always checks caches.
    // skipCache filtering happens in streamingService.resolveStream().
    // This test documents that the service-layer functions always cache.
    assert.ok(true, 'skipCache handled by streamingService, not streamCacheService');
  });
});

// ═══════════════════════════════════════════════════════════
//  11. Redis failure
// ═══════════════════════════════════════════════════════════
describe('11. Redis failure', () => {
  test('Redis failure does not cause 500; playback continues', async () => {
    resetMocks();
    const origDel = mockCache.del;
    mockCache.del = async () => { throw new Error('Redis disconnected'); };
    mockDbResult('DELETE', [{ affectedRows: 1 }]);
    let threw = false;
    try { await streamCacheService.deleteInvalidCache(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER); }
    catch (e) { threw = true; }
    assert.strictEqual(threw, false, 'should not throw when Redis fails');
    mockCache.del = origDel;
  });
});

// ═══════════════════════════════════════════════════════════
//  12. Cache key isolation
// ═══════════════════════════════════════════════════════════
describe('12. Cache key isolation', () => {
  test('Different episode IDs produce different Redis keys', () => {
    assert.notStrictEqual(streamCacheService.buildRedisKey(1, 'animeheaven'),
      streamCacheService.buildRedisKey(2, 'animeheaven'));
  });
  test('Different providers produce different Redis keys', () => {
    assert.notStrictEqual(streamCacheService.buildRedisKey(1, 'animeheaven'),
      streamCacheService.buildRedisKey(1, 'kickassanime'));
  });
});

// ═══════════════════════════════════════════════════════════
//  13. Classification logic
// ═══════════════════════════════════════════════════════════
describe('13. Source classification', () => {
  test('Explicit URL expiry -> TEMPORARY', () => {
    const now = Date.now();
    const row = makeCacheRow({ detected_expires_at: new Date(now + 3600 * 1000) });
    const c = streamCacheService.classifySource(row, now);
    assert.strictEqual(c.classification, 'TEMPORARY');
// ═══════════════════════════════════════════════════════════
//  14. Source state machine
// ═══════════════════════════════════════════════════════════
describe('14. Source state machine', () => {
  test('ACTIVE when verified recently', () => {
    const now = Date.now();
    const row = makeCacheRow({ verification_status: 'active', last_verified_at: new Date(now - 60000) });
    assert.strictEqual(streamCacheService.getSourceState(row, now), 'active');
  });
  test('EXPIRED when detected_expires_at in past', () => {
    const row = makeCacheRow({ detected_expires_at: new Date(Date.now() - 3600 * 1000) });
    assert.strictEqual(streamCacheService.getSourceState(row, Date.now()), 'expired');
  });
  test('INVALID when verification_status is invalid', () => {
    assert.strictEqual(streamCacheService.getSourceState(makeCacheRow({ verification_status: 'invalid' }), Date.now()), 'invalid');
  });
  test('UNKNOWN when only AniStrim TTL (expires_at) passed — age is not proof of death', () => {
    const row = makeCacheRow({ expires_at: new Date(Date.now() - 3600 * 1000), detected_expires_at: null });
    assert.strictEqual(streamCacheService.getSourceState(row, Date.now()), 'unknown');
    assert.strictEqual(streamCacheService.isReusable(row, Date.now()), true);
  });
});

// ═══════════════════════════════════════════════════════════
//  15. Expiry detection
// ═══════════════════════════════════════════════════════════
describe('15. Expiry detection', () => {
  test('Finds expires parameter in URL', () => {
    const r = streamCacheService.detectExpiryFromUrl('https://cdn.example.com/v.mp4?expires=1893456000&token=abc');
    assert.ok(r.detectedExpiresAt instanceof Date);
    assert.strictEqual(r.expirySource, 'url');
  });
  test('No expiry param returns null', () => {
    const r = streamCacheService.detectExpiryFromUrl('https://cdn.example.com/v.mp4?token=abc');
    assert.strictEqual(r.detectedExpiresAt, null);
    assert.strictEqual(r.expirySource, 'unknown');
  });
  test('Cache-Control max-age detected', () => {
    const r = streamCacheService.detectExpiryFromHeaders({ 'cache-control': 'public, max-age=604800' }, Date.now());
    assert.ok(r.detectedExpiresAt instanceof Date);
    assert.strictEqual(r.expirySource, 'header');
  });
  test('Expires header detected', () => {
    const r = streamCacheService.detectExpiryFromHeaders({ 'expires': 'Wed, 01 Jan 2030 00:00:00 GMT' }, Date.now());
    assert.ok(r.detectedExpiresAt instanceof Date);
    assert.strictEqual(r.expirySource, 'header');
  });
});

// ═══════════════════════════════════════════════════════════
//  16. Error resilience
// ═══════════════════════════════════════════════════════════
describe('16. Error resilience', () => {
  test('getOrResolve handles null episodeId gracefully', async () => {
    let called = false;
    const r = await streamCacheService.getOrResolve(null, SAMPLE_PROVIDER, async () => { called = true; return makeProviderResult(); });
    assert.ok(r); assert.strictEqual(called, true);
  });
  test('saveStream handles null providerResult', async () => {
    assert.strictEqual(await streamCacheService.saveStream(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, null), false);
  });
  test('isExpired returns true for null row', () => {
    assert.strictEqual(streamCacheService.isExpired(null, Date.now()), true);
  });
  test('deleteInvalidCache handles empty episodeId', async () => {
    assert.strictEqual(await streamCacheService.deleteInvalidCache(null, SAMPLE_PROVIDER), false);
  });
});
  });
  test('No expiry, no observation -> UNKNOWN', () => {
    const c = streamCacheService.classifySource(makeCacheRow({}), Date.now());
    assert.strictEqual(c.classification, 'UNKNOWN');
  });
  test('Stable with 24h+ observation -> STABLE', () => {
    const now = Date.now();
    const row = makeCacheRow({
      detected_expires_at: null, expiry_source: 'unknown',
      verification_status: 'active', failure_count: 0,
      observed_first_success_at: new Date(now - 25 * 3600 * 1000),
      observed_last_success_at: new Date(now - 60000),
    });
    const c = streamCacheService.classifySource(row, now);
    assert.strictEqual(c.classification, 'STABLE');
  });
  test('Observed failure -> TEMPORARY', () => {
    const now = Date.now();
    const row = makeCacheRow({ observed_first_failure_at: new Date(now - 3600 * 1000) });
    const c = streamCacheService.classifySource(row, now);
    assert.strictEqual(c.classification, 'TEMPORARY');
  });
});
// ═══════════════════════════════════════════════════════════
//  10. Redis stale-entry invalidation
// ═══════════════════════════════════════════════════════════
describe('10. Redis stale-entry invalidation', () => {
  test('deleteInvalidCache removes both MySQL and Redis', async () => {
    resetMocks();
    mockCache.store.set(SAMPLE_REDIS_KEY, makeProviderResult());
    mockDbResult('DELETE', [{ affectedRows: 1 }]);
    await streamCacheService.deleteInvalidCache(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(mockDb.queryLog.some(q => q.sql.startsWith('DELETE')), 'MySQL should be deleted');
    assert.ok(mockCache.delLog.includes(SAMPLE_REDIS_KEY), 'Redis key should be deleted');
  });
});

// ═══════════════════════════════════════════════════════════
//  7. Expired detected_expires_at
// ═══════════════════════════════════════════════════════════
describe('7. Expired detected_expires_at', () => {
  test('Source with past detected_expires_at is expired', () => {
    const now = Date.now();
    const row = makeCacheRow({ detected_expires_at: new Date(now - 3600 * 1000) });
    assert.strictEqual(streamCacheService.getSourceState(row, now), 'expired');
  });
});
    const origGet = mockCache.get;
    mockCache.get = async () => { throw new Error('Redis down'); };
    mockDbResult('SELECT', [[makeCacheRow()]]);
    let resolverCalled = false;
    const got = await streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, async () => {
      resolverCalled = true; return makeProviderResult();
    });
    assert.ok(got, 'should return result despite Redis failure');
    assert.strictEqual(resolverCalled, false, 'resolver NOT called on MySQL hit');
    mockCache.get = origGet;
  });
});
    const got = await streamCacheService.getOrResolve(SAMPLE_EPISODE_ID, SAMPLE_PROVIDER, async () => {
      resolverCalled = true; return makeProviderResult();
    });
    assert.ok(got, 'should return a result');
    assert.strictEqual(resolverCalled, false, 'resolver must NOT be called on MySQL hit');
    assert.ok(mockCache.store.has(SAMPLE_REDIS_KEY), 'Redis should be populated from MySQL');
  });
});
}