// tests/streamSingleFlight.test.js
// COLD-START STAMPEDE PROTECTION — hermetic concurrency tests through the REAL
// resolveStream() + REAL streamCacheService.getOrResolve() +
// REAL inFlightResolverManager (only I/O mocked).
//
// Proves, for one (episode_id, provider):
//   • NO saved URL       → N concurrent requests (10/50/100) cause EXACTLY ONE
//                          AnimeHeaven resolution; all callers get the SAME result.
//   • SAVED reusable URL → N concurrent requests cause ZERO resolutions.
//   • SAVED URL PROVEN DEAD → N concurrent requests cause EXACTLY ONE
//                          replacement resolution; all callers get the SAME
//                          replacement URL; no duplicate rows.
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

const mockProviderHttp = {
  async request() { throw new Error('unexpected upstream request in test'); },
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

// MySQL mock. insertCount tracks episode_stream_cache upserts (duplicate-row guard).
let manualVideoUrl = null;
let dbRows = null;
let insertCount = 0;

async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT manual_video_url')) return [[manualVideoUrl ? { manual_video_url: manualVideoUrl } : null]];
  if (s.startsWith('SELECT id, episode_id, provider, stream_type')) return [dbRows ? dbRows : []];
  if (s.startsWith('UPDATE episode_stream_cache')) {
    if (s.includes("verification_status = 'invalid'") && dbRows && dbRows[0]) dbRows[0].verification_status = 'invalid';
    return [[{ affectedRows: 1 }]];
  }
  if (s.startsWith('INSERT INTO episode_stream_cache')) { insertCount += 1; return [[{ insertId: 1, affectedRows: 1 }]]; }
  if (s.startsWith('DELETE FROM episode_stream_cache')) return [[{ affectedRows: 0 }]];
  return [[]];
}

// AnimeHeaven provider mock — resolution counting + configurable latency/failure.
let ahResolveCalls = 0;
let ahLatencyMs = 40;      // widens the race window for concurrent requests
let ahFailFirst = false;   // fail the first resolution attempt (retry semantics)
let ahFailAlways = false;
const mockAH = {
  async resolveStreamByKey() {
    ahResolveCalls += 1;
    if (ahLatencyMs) await new Promise(r => setTimeout(r, ahLatencyMs));
    if (ahFailAlways || (ahFailFirst && ahResolveCalls === 1)) throw new Error('upstream boom');
    return {
      provider: 'animeheaven',
      sources: [{ url: RESOLVED_URL, quality: '720', referer: 'https://animeheaven.example/' }],
      subtitles: [],
    };
  },
  async extractStreams() { throw new Error('ANIMEHEAVEN CONTACTED (extractStreams)'); },
  async resolveStream() { throw new Error('ANIMEHEAVEN CONTACTED (resolveStream)'); },
  async getAnimeDetails() { throw new Error('ANIMEHEAVEN CONTACTED (getAnimeDetails)'); },
  getPlaybackContext: async () => ({}),
};
const mockConsumet = { ConsumetProvider: class { async search() { throw new Error('FORBIDDEN'); } } };
const mockProviderRegistry = { PROVIDER_IDS: { KICKASSANIME: 'kickassanime', HIANIME: 'hianime', ANIMEPAHE: 'animepahe', ANIMEHEAVEN: 'animeheaven' }, toHealthKey: (id) => id };
const mockImportService = { resolvePlaybackIdentifiers: async () => ({ slug: 'test-slug', animeId: 5, episodeId: EP_ID, episodeKey: 'ep-key', episodeUrl: null }) };
const mockObservation = { observeOnCacheHit() {}, processEpisode: async () => ({}), syncAnime: async () => ({}) };

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
mountMock('../services/streamObservationService', mockObservation);
mountMock('../services/animeHeavenImportService', mockImportService);
mountMock('../services/animeHeavenProvider', { provider: mockAH });
mountMock('../services/consumetProvider', mockConsumet);
mountMock('../services/providerRegistry', mockProviderRegistry);

delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];
delete require.cache[require.resolve('../services/streamingService')];

const streamCacheService = require('../services/streamCacheService');
const streamingService = require('../services/streamingService');
const inFlightResolverManager = require('../services/inFlightResolverManager');

// ── Helpers ────────────────────────────────────────────────

const EP_ID = 4242;
const PROVIDER = 'animeheaven';
const SAVED_URL = 'https://cdn.example.com/saved.mp4?token=old';
const RESOLVED_URL = 'https://cdn.example.com/fresh.mp4?token=new';

function makeRow(overrides) {
  const now = Date.now();
  return {
    id: 1, episode_id: EP_ID, provider: 'animeheaven', stream_type: 'direct',
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
    last_direct_check_at: new Date(now),
    url_classification: null, classification_confidence: null, classification_reason: null,
    observed_first_success_at: null, observed_last_success_at: null,
    observed_first_failure_at: null, observed_lifetime_seconds: null,
    ...(overrides || {}),
  };
}

// Fire N concurrent resolveStream() calls for the SAME episode and collect results.
async function concurrentPlays(n) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(streamingService.resolveStream('Test Anime', 1, { episodeId: EP_ID }).catch(e => ({ __error: e.message })));
  }
  return Promise.all(jobs);
}

describe('Cold-start stampede protection — no saved URL', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; insertCount = 0;
    ahResolveCalls = 0; ahLatencyMs = 40; ahFailFirst = false; ahFailAlways = false;
    redisStore = new Map();
    inFlightResolverManager.reset();
  });

  for (const n of [10, 50, 100]) {
    it(`${n} concurrent requests with NO saved URL → exactly ONE AnimeHeaven resolution, identical results`, async () => {
      dbRows = null; // no persisted row — true cold start
      const results = await concurrentPlays(n);

      assert.strictEqual(ahResolveCalls, 1, `${n} concurrent cold requests must trigger exactly ONE resolution (got ${ahResolveCalls})`);
      assert.strictEqual(insertCount, 1, 'exactly ONE persistent row upsert (no duplicate rows)');

      for (const r of results) {
        assert.ok(!r.__error, `no caller failed: ${r.__error || ''}`);
        assert.strictEqual(r.streamUrl, RESOLVED_URL);
        assert.strictEqual(r.providerUsed, 'animeheaven');
        assert.ok(r.sources.length > 0);
      }
      const urls = new Set(results.map(r => r.streamUrl));
      assert.strictEqual(urls.size, 1, 'ALL callers receive the SAME stream result');
      const attempts = new Set(results.map(r => r.attemptCount));
      assert.strictEqual(attempts.size, 1, 'all callers see the same attemptCount');
    });
  }

  it('a resolution failure is shared by all waiters (one pipeline, one outcome)', async () => {
    dbRows = null;
    ahFailAlways = true;
    const results = await concurrentPlays(20);
    assert.strictEqual(ahResolveCalls, 3, 'only the leader runs: 3 AnimeHeaven attempts total');
    for (const r of results) {
      assert.ok(r.__error, 'every caller receives the same failure');
    }
  });
});

describe('Cold-start stampede protection — saved reusable URL', () => {
  beforeEach(() => {
    manualVideoUrl = null; insertCount = 0;
    ahResolveCalls = 0; ahLatencyMs = 40; ahFailFirst = false; ahFailAlways = false;
    redisStore = new Map();
    inFlightResolverManager.reset();
  });

  for (const n of [10, 50, 100]) {
    it(`${n} concurrent requests with a SAVED reusable URL → ZERO AnimeHeaven resolutions`, async () => {
      dbRows = [makeRow({})];       // reusable row in MySQL; Redis/memory empty
      const results = await concurrentPlays(n);

      assert.strictEqual(ahResolveCalls, 0, 'saved URL is the source of truth — no resolution');
      assert.strictEqual(insertCount, 0, 'no re-save when reusing');
      for (const r of results) {
        assert.ok(!r.__error, `no caller failed: ${r.__error || ''}`);
        assert.strictEqual(r.streamUrl, SAVED_URL, 'every caller gets the SAVED URL');
        assert.strictEqual(r.cached, true);
      }
    });
  }
});

describe('Cold-start stampede protection — saved URL proven dead', () => {
  beforeEach(() => {
    manualVideoUrl = null; insertCount = 0;
    ahResolveCalls = 0; ahLatencyMs = 40; ahFailFirst = false; ahFailAlways = false;
    redisStore = new Map();
    inFlightResolverManager.reset();
  });

  for (const n of [10, 50, 100]) {
    it(`${n} concurrent requests with a PROVEN-DEAD saved URL → exactly ONE replacement resolution`, async () => {
      dbRows = [makeRow({ verification_status: 'invalid' })]; // previously confirmed 403/404/410
      const results = await concurrentPlays(n);

      assert.strictEqual(ahResolveCalls, 1, `${n} requests after proven death must trigger exactly ONE replacement resolution (got ${ahResolveCalls})`);
      assert.strictEqual(insertCount, 1, 'exactly ONE replacement row upsert (no duplicates)');
      for (const r of results) {
        assert.ok(!r.__error, `no caller failed: ${r.__error || ''}`);
        assert.strictEqual(r.streamUrl, RESOLVED_URL, 'every caller gets the REPLACEMENT URL');
      }
      const urls = new Set(results.map(r => r.streamUrl));
      assert.strictEqual(urls.size, 1, 'ALL callers receive the SAME replacement result');
    });
  }
});

describe('Single-flight invariants', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; insertCount = 0;
    ahResolveCalls = 0; ahLatencyMs = 40; ahFailFirst = false; ahFailAlways = false;
    redisStore = new Map();
    inFlightResolverManager.reset();
  });

  it('unrelated episodes resolve independently (no global lock)', async () => {
    // Two DIFFERENT episode ids → two independent flights, each resolving once.
    const results = await Promise.all([
      streamingService.resolveStream('Test Anime', 1, { episodeId: EP_ID }).catch(e => ({ __error: e.message })),
      streamingService.resolveStream('Test Anime', 1, { episodeId: 9999 }).catch(e => ({ __error: e.message })),
    ]);
    assert.strictEqual(ahResolveCalls, 2, 'different episodes fly independently');
    assert.ok(!results[0].__error && !results[1].__error);
  });

  it('a mid-flight save is honoured: late requests reuse the persisted URL without resolving', async () => {
    // First wave resolves and persists; second wave (after settle) must hit MySQL.
    dbRows = null;
    await concurrentPlays(25);
    const firstWaveCalls = ahResolveCalls;
    assert.strictEqual(firstWaveCalls, 1);

    // Simulate the persisted row now being visible to findCachedStream.
    dbRows = [makeRow({
      stream_data: {
        provider: 'animeheaven',
        streamUrl: RESOLVED_URL,
        sources: [{ url: RESOLVED_URL, quality: '720' }],
        subtitles: [],
      },
      verification_status: 'unknown',
    })];
    redisStore = new Map();           // even with Redis cold again
    inFlightResolverManager.reset();  // and memory cold again
    const results = await concurrentPlays(25);
    assert.strictEqual(ahResolveCalls, firstWaveCalls, 'second wave: ZERO additional resolutions');
    for (const r of results) {
      assert.ok(!r.__error);
      assert.strictEqual(r.streamUrl, RESOLVED_URL);
    }
  });
});
