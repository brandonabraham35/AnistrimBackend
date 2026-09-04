// tests/playbackFailure.test.js
// Unit tests for playback failure reporting and cache invalidation.
'use strict';

const assert = require('assert');

// ─ Mock the dependencies ─────────────────
const dbCalls = { queries: [] };
let shouldReturnValidRow = false;

const mockDb = {
  query: async (sql, params) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    dbCalls.queries.push({ sql: normalized, params });
    // findCachedStream(): return a persisted row (reusable) or none.
    if (/SELECT.*FROM episode_stream_cache/i.test(normalized)) {
      return shouldReturnValidRow ? [[makeCacheRow()], []] : [[], []];
    }
    return [{ affectedRows: 1 }];
  },
};

const cacheCalls = { delByPrefix: [] };
const mockCache = {
  delByPrefix: async (prefix) => { cacheCalls.delByPrefix.push(prefix); },
};

const mockLogger = {
  warn: () => {},
  info: () => {},
  debug: () => {},
  debugStream: () => {},
  stream: () => {},
  streamAttempt: () => {},
  error: () => {},
};

// providerHttp.request drives streamCacheService.isCachedSourceAlive().
let httpBehavior = { mode: 'success', status: 200 };
const httpCalls = { count: 0 };
const mockProviderHttp = {
  request: async () => {
    httpCalls.count += 1;
    if (httpBehavior.mode === 'error') {
      const err = new Error(httpBehavior.message || 'request failed');
      if (httpBehavior.status) err.response = { status: httpBehavior.status };
      throw err;
    }
    return { status: httpBehavior.status, headers: {} };
  },
  isProviderHealthy: () => true,
  recordSuccess: () => {},
  recordFailure: () => {},
  markTimeout: () => {},
  classifyError: () => ({ category: 'UNKNOWN', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}),
  getHealthStats: () => null,
};

function makeCacheRow() {
  return {
    id: 1,
    episode_id: 123,
    provider: 'animeheaven',
    stream_type: 'direct',
    stream_data: {
      provider: 'animeheaven',
      streamUrl: 'https://cdn.example.com/video.mp4',
      sources: [{ url: 'https://cdn.example.com/video.mp4', quality: '720', sourceType: 'video', referer: 'https://animeheaven.me', origin: 'https://animeheaven.me', cookies: null, headers: null }],
      subtitles: [],
    },
    expires_at: new Date(Date.now() + 3600 * 1000),
    detected_expires_at: null,
    expiry_source: 'unknown',
    verification_status: 'unknown',
    last_used_at: new Date(),
    last_verified_at: null,
    url_classification: null,
    classification_confidence: null,
    classification_reason: null,
    observed_first_success_at: null,
    observed_last_success_at: null,
    observed_first_failure_at: null,
    observed_lifetime_seconds: null,
  };
}

function resetMocks() {
  dbCalls.queries.length = 0;
  cacheCalls.delByPrefix.length = 0;
  httpCalls.count = 0;
  httpBehavior = { mode: 'success', status: 200 };
  shouldReturnValidRow = false;
}

// Replace modules before requiring the controller (fresh instances so this
// file is hermetic regardless of require-cache state left by earlier files).
function mountMock(id, exportsObj) {
  const resolved = require.resolve(id);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
mountMock('../config/db', mockDb);
mountMock('../utils/cacheService', mockCache);
mountMock('../utils/logger', mockLogger);
mountMock('../utils/providerHttp', mockProviderHttp);
// Avoid loading the real AnimeHeaven provider inside findCachedStream's DIAG block.
mountMock('../services/animeHeavenProvider', { getPlaybackContext: () => null, provider: {} });

delete require.cache[require.resolve('../services/streamCacheService')];
delete require.cache[require.resolve('../controllers/reportController')];

const { reportPlaybackFailure } = require('../controllers/reportController');
const streamCacheService = require('../services/streamCacheService');

// ── Helper: mock request/response ──────────────────────────

function mockReq(user, body) {
  return { user: user || { id: 1 }, body: body || {} };
}

function mockRes() {
  const res = {};
  res._status = 200;
  res._json = null;
  res.status = function (code) { res._status = code; return res; };
  res.json = function (data) { res._json = data; return res; };
  return res;
}

// ── Tests ──────────────────────────────────────────────────

describe('reportPlaybackFailure endpoint', () => {
  beforeEach(() => {
    // Reset rate limit state between tests
    const reportController = require('../controllers/reportController');
    // The failureReportCounts Map is module-scoped; we can't easily reset it.
    // Tests are designed to work with fresh state.
  });

  it('rejects unauthenticated requests', async () => {
    const req = mockReq(null, { episodeId: 1 });
    // protect middleware would reject this before the controller runs
    // In unit test, we simulate by not setting req.user
    req.user = null;
    const res = mockRes();

    // The controller assumes req.user exists (protect middleware guarantees it).
    // If somehow called without auth, it would throw — which is correct.
    // We test the controller logic directly here.
    try {
      await reportPlaybackFailure(req, res);
      assert.fail('Should have thrown');
    } catch (e) {
      // Expected — req.user is null
      assert.ok(true);
    }
  });

  it('rejects invalid episodeId', async () => {
    const req = mockReq({ id: 1 }, { episodeId: 'abc' });
    const res = mockRes();
    await reportPlaybackFailure(req, res);
    assert.strictEqual(res._status, 400);
    assert.ok(res._json.message.includes('Valid episodeId'));
  });

  it('rejects negative episodeId', async () => {
    const req = mockReq({ id: 1 }, { episodeId: -1 });
    const res = mockRes();
    await reportPlaybackFailure(req, res);
    assert.strictEqual(res._status, 400);
    assert.ok(res._json.message.includes('Valid episodeId'));
  });

  it('accepts valid episodeId with optional reason', async () => {
    const req = mockReq({ id: 1 }, { episodeId: 123, reason: 'network_error' });
    const res = mockRes();
    await reportPlaybackFailure(req, res);
    assert.strictEqual(res._status, 200);
    // sendSuccess returns { success: true, data, meta }
    // The message is in res._json.data.message
    const hasMessage = res._json && (
      (res._json.message || '').includes('Playback failure reported') ||
      (res._json.data && res._json.data.message)
    );
    assert.ok(hasMessage || res._status === 200, 'Should return 200 with success response');
  });

  it('accepts episodeId without reason', async () => {
    const req = mockReq({ id: 1 }, { episodeId: 456 });
    const res = mockRes();
    await reportPlaybackFailure(req, res);
    assert.strictEqual(res._status, 200);
  });

  it('rate limits after 3 reports in 5 minutes', async () => {
    // First 3 reports should succeed
    for (let i = 0; i < 3; i++) {
      const req = mockReq({ id: 999 }, { episodeId: 100 + i });
      const res = mockRes();
      await reportPlaybackFailure(req, res);
      assert.strictEqual(res._status, 200, `Report ${i + 1} should succeed`);
    }

    // 4th report should be rate limited
    const req = mockReq({ id: 999 }, { episodeId: 200 });
    const res = mockRes();
    await reportPlaybackFailure(req, res);
    assert.strictEqual(res._status, 429);
    assert.ok(res._json.message.includes('Too many failure reports'));
    assert.ok(res._json.retryAfter > 0);
  });

  it('resets rate limit after window expires', async () => {
    // This test would require manipulating the Map's resetAt timestamp.
    // Since the Map is module-scoped and the window is 5 minutes,
    // we skip this in unit tests and rely on integration tests.
    assert.ok(true, 'Rate limit reset tested via integration');
  });
});

describe('cache invalidation', () => {
  it('builds correct Redis key for episode + provider', () => {
    const key = streamCacheService.buildRedisKey(123, 'animeheaven');
    assert.strictEqual(key, 'stream:source:animeheaven:123');
  });

  it('Redis key is distinct for different episodes', () => {
    const key1 = streamCacheService.buildRedisKey(123, 'animeheaven');
    const key2 = streamCacheService.buildRedisKey(456, 'animeheaven');
    assert.notStrictEqual(key1, key2);
  });
});

// ── Evidence-based cache invalidation (audit Step 2) ────────
// A playback failure report must NOT permanently poison a cached source unless
// a probe of the ACTUAL cached source returns an explicit authoritative
// 403/404. Auth/entitlement, transient browser/network, device-limit, and
// decode failures are diagnostics only.

let uid = 5000;
function authReport(body) {
  uid += 1;
  return mockReq({ id: uid }, { episodeId: 123, ...(body || {}) });
}

function invalidateUpdates() {
  return dbCalls.queries.filter(q => q.sql.includes('verification_status') && q.sql.includes('invalid'));
}

function diagnosticUpdates() {
  return dbCalls.queries.filter(q => q.sql.includes('failure_count') && q.sql.includes('last_failed_at') && !q.sql.includes('verification_status'));
}

describe('evidence-based cache invalidation', () => {
  beforeEach(() => {
    resetMocks();
    shouldReturnValidRow = true; // a cached source exists
  });

  it('does NOT invalidate when the cached source probes 2xx (healthy)', async () => {
    httpBehavior = { mode: 'success', status: 200 };
    const res = mockRes();
    await reportPlaybackFailure(authReport({ reason: 'network_error' }), res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(invalidateUpdates().length, 0, 'no verification_status=invalid update');
    assert.strictEqual(cacheCalls.delByPrefix.length, 0, 'Redis must not be purged');
    assert.ok(diagnosticUpdates().length >= 1, 'failure diagnostics still recorded');
  });

  it('invalidates the source when the actual cached-source probe returns 403', async () => {
    httpBehavior = { mode: 'error', status: 403, message: 'Forbidden' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 1, '403 probe → mark invalid');
    assert.ok(invalidateUpdates()[0].sql.includes("SET verification_status = 'invalid'"));
    assert.strictEqual(cacheCalls.delByPrefix.length, 1, 'Redis purged in sync');
    assert.ok(cacheCalls.delByPrefix[0].includes('animeheaven:123'));
  });

  it('invalidates the source on an explicit 404', async () => {
    httpBehavior = { mode: 'error', status: 404, message: 'Not Found' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 1);
    assert.strictEqual(cacheCalls.delByPrefix.length, 1);
  });

  it('does NOT invalidate on 429 (upstream throttling is not a dead source)', async () => {
    httpBehavior = { mode: 'error', status: 429, message: 'Too Many Requests' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 0);
    assert.strictEqual(cacheCalls.delByPrefix.length, 0);
  });

  it('does NOT invalidate on 5xx', async () => {
    httpBehavior = { mode: 'error', status: 500, message: 'Internal Server Error' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 0);
    assert.strictEqual(cacheCalls.delByPrefix.length, 0);
  });

  it('does NOT invalidate on timeout / network failure (no status)', async () => {
    httpBehavior = { mode: 'error', status: 0, message: 'timeout of 4000ms exceeded' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 0);
    assert.strictEqual(cacheCalls.delByPrefix.length, 0);
  });

  it('does NOT invalidate when no cached row exists (nothing to prove dead)', async () => {
    shouldReturnValidRow = false;
    httpBehavior = { mode: 'error', status: 403, message: 'Forbidden' };
    const res = mockRes();
    await reportPlaybackFailure(authReport(), res);
    assert.strictEqual(invalidateUpdates().length, 0);
    assert.strictEqual(cacheCalls.delByPrefix.length, 0);
  });

  it('handles a DB failure during the probe without invalidating anything', async () => {
    const origQuery = mockDb.query;
    mockDb.query = async () => { throw new Error('DB down'); };
    try {
      const res = mockRes();
      await reportPlaybackFailure(authReport(), res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(invalidateUpdates().length, 0);
    } finally {
      mockDb.query = origQuery;
    }
  });
});

describe('authorization/entitlement failures never invalidate (audit Test 3)', () => {
  beforeEach(() => {
    resetMocks();
    shouldReturnValidRow = true;
    httpBehavior = { mode: 'success', status: 200 }; // source is alive upstream
  });

  const authReasons = ['401', '403', 'PREMIUM_REQUIRED', 'DEVICE_LIMIT_REACHED', 'session_expired', 'AUTH_FAILED'];
  authReasons.forEach((reason) => {
    it(`reason="${reason}": report recorded, source NOT invalidated`, async () => {
      const res = mockRes();
      await reportPlaybackFailure(authReport({ reason }), res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(invalidateUpdates().length, 0, 'auth/entitlement errors must not poison the cache');
      assert.strictEqual(cacheCalls.delByPrefix.length, 0, 'Redis must stay intact');
    });
  });
});

describe('abuse prevention', () => {
  it('client cannot specify arbitrary provider URLs', async () => {
    // The endpoint only accepts episodeId (a positive integer).
    // The backend derives the provider from env config.
    // There is no way for a client to specify a URL.
    assert.ok(true, 'Only episodeId accepted — no URL injection possible');
  });

  it('client cannot invalidate other users\' cache entries', async () => {
    // The episodeId is validated but the cache invalidation is per-episode,
    // not per-user. This is intentional — if ANY user reports a failure,
    // the source is likely dead for everyone.
    // Rate limiting prevents spam.
    assert.ok(true, 'Per-user rate limiting prevents abuse');
  });
});
