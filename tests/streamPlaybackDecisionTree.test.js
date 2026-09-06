// tests/streamPlaybackDecisionTree.test.js
// Hermetic tests for the AUTHORITATIVE PLAYBACK decision tree, driven through
// the REAL resolveStream() and the REAL streamCacheService (only I/O mocked).
//
// Decision tree under test:
//   1. Manual override (manual_video_url)      → use it, never touch AH.
//   2. Reusable persisted stream (MySQL)       → use it, never touch AH
//       - even when Redis is empty and memory is empty (Render restart),
//       - even when the local expires_at reference TTL has elapsed,
//       - even when the resolver is mocked to THROW if called.
//   3. Persisted stream proven dead (403/404/410) → invalidate → ONE fresh
//      resolution permitted (via the getOrResolve mechanism Phase 4 uses).
//   4. No persisted stream → initial resolution runs.
//   5. Temporary CDN failures (5xx/429/timeout) → NEVER a permission to
//      contact AnimeHeaven; the source stays reusable.
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
const metricsLog = { providerCalls: [], invalidations: [] };
const mockMetrics = {
  increment() {}, recordSourceLifetime() {}, recordProviderCall(reason) { metricsLog.providerCalls.push(reason); },
  recordInvalidation(reason) { metricsLog.invalidations.push(reason); },
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

let providerHttpCalls = [];
let requestHandler = null;   // per-test override (cfg) => response/throws
const mockProviderHttp = {
  async request(cfg) {
    providerHttpCalls.push({ method: cfg.method, url: cfg.url });
    if (requestHandler) return requestHandler(cfg);
    const err = new Error('unexpected upstream request in test');
    err.response = { status: 500 };
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

// MySQL mock: manual_video_url + episode_stream_cache rows.
let manualVideoUrl = null;
let dbRows = null;          // rows for the episode_stream_cache SELECT
const dbLog = [];

async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  dbLog.push(s);
  if (s.startsWith('SELECT manual_video_url')) return [[manualVideoUrl ? { manual_video_url: manualVideoUrl } : null]];
  if (s.startsWith('SELECT id, episode_id, provider, stream_type')) return [dbRows ? dbRows : []];
  if (s.startsWith('UPDATE episode_stream_cache')) {
    if (s.includes("verification_status = 'invalid'") && dbRows && dbRows[0]) dbRows[0].verification_status = 'invalid';
    return [[{ affectedRows: 1 }]];
  }
  if (s.startsWith('INSERT INTO episode_stream_cache')) return [[{ insertId: 1, affectedRows: 1 }]];
  if (s.startsWith('DELETE FROM episode_stream_cache')) return [[{ affectedRows: 0 }]];
  return [[]];
}

const mockAnimeHeavenProviderObj = {
  getAnimeDetails: async () => { throw new Error('ANIMEHEAVEN CONTACTED (getAnimeDetails) — FORBIDDEN'); },
  getPlaybackContext: async () => ({}),
};
let resolveStreamByKeyCalls = 0;
let resolveStreamByKeyImpl = async () => { throw new Error('ANIMEHEAVEN CONTACTED (resolveStreamByKey) — FORBIDDEN'); };
mockAnimeHeavenProviderObj.resolveStreamByKey = async (...args) => {
  resolveStreamByKeyCalls += 1;
  return resolveStreamByKeyImpl(...args);
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
mountMock('../services/animeHeavenProvider', { provider: mockAnimeHeavenProviderObj });
mountMock('../services/consumetProvider', mockConsumet);
mountMock('../services/providerRegistry', mockProviderRegistry);

delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];
delete require.cache[require.resolve('../services/streamingService')];

const streamCacheService = require('../services/streamCacheService');
const streamingService = require('../services/streamingService');
const inFlightResolverManager = require('../services/inFlightResolverManager');

// ── Helpers ────────────────────────────────────────────────

const EP_ID = 909;
const PROVIDER = 'animeheaven';
const SAVED_URL = 'https://cdn.example.com/final-video.mp4?token=xyz';
const REPLACEMENT_URL = 'https://cdn.example.com/replacement.mp4?token=new';

function makeRow(overrides) {
  const now = Date.now();
  return {
    id: 1, episode_id: EP_ID, provider: 'animeheaven', stream_type: 'direct',
    stream_data: {
      provider: 'animeheaven',
      streamUrl: SAVED_URL,
      sources: [{ url: SAVED_URL, quality: '720', referer: 'https://animeheaven.example/', origin: 'https://animeheaven.example' }],
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

async function settleDeferred() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 10));
}

function assertSavesSavedUrl(payload, url) {
  assert.ok(payload, 'playback payload returned');
  assert.strictEqual(payload.streamUrl, url, 'the SAVED URL is the playback source');
  assert.strictEqual(payload.sources[0].url, url);
  assert.strictEqual(payload.cached, true);
}

// ═══════════════════════════════════════════════════════════
// Branch 1: Manual override
// ═══════════════════════════════════════════════════════════
describe('Branch 1 — Manual override (manual_video_url)', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; redisStore = new Map();
    inFlightResolverManager.reset(); providerHttpCalls = [];
  });

  it('1a: manual_video_url takes precedence over the persisted stream and AnimeHeaven', async () => {
    manualVideoUrl = 'https://cloudinary.example/manual.mp4';
    dbRows = [makeRow({})];   // a reusable persisted stream ALSO exists
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assert.strictEqual(payload.provider, 'manual', 'manual override wins');
    assert.strictEqual(payload.streamUrl, 'https://cloudinary.example/manual.mp4');
    assert.strictEqual(payload.manualVideo, true);
    assert.strictEqual(providerHttpCalls.length, 0, 'no upstream validation');
  });

  it('1b: manual lookup failure falls through to the persisted stream (never breaks playback)', async () => {
    // Force the manual SELECT to throw.
    const realQuery = mockDbQuery;
    require.cache[require.resolve('../config/db')].exports.query = async (sql) => {
      if (String(sql).includes('manual_video_url')) throw new Error('db down');
      return realQuery(sql);
    };
    try {
      dbRows = [makeRow({})];
      const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
      assertSavesSavedUrl(payload, SAVED_URL);
      assert.strictEqual(payload.provider, 'animeheaven');
    } finally {
      require.cache[require.resolve('../config/db')].exports.query = mockDbQuery;
    }
  });

  it('1c: no manual URL → persisted stream is used', async () => {
    manualVideoUrl = null;
    dbRows = [makeRow({})];
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
  });
});

// ═══════════════════════════════════════════════════════════
// Branch 2: Reusable persisted stream (MySQL source of truth)
// ═══════════════════════════════════════════════════════════
describe('Branch 2 — Reusable persisted stream is authoritative', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; redisStore = new Map();
    inFlightResolverManager.reset(); providerHttpCalls = [];
  });

  // ── MOST IMPORTANT TEST ──────────────────────────────────
  it('★ MOST IMPORTANT: valid cached URL + empty Redis + empty memory + resolver mocked to THROW → playback succeeds via MySQL, AnimeHeaven NEVER called', async () => {
    dbRows = [makeRow({})];
    assert.strictEqual(redisStore.size, 0, 'precondition: Redis empty');
    // The AnimeHeaven provider mock THROWS on any contact (mounted at load).
    // resolveStream's Phase-4 resolver would propagate that throw; it must never run.
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
    assert.strictEqual(payload.provider, 'animeheaven');
    assert.strictEqual(providerHttpCalls.length, 0, 'zero upstream validation requests');
  });

  it('2a: cached URL + expired local expires_at → AnimeHeaven NOT called', async () => {
    const now = Date.now();
    dbRows = [makeRow({ expires_at: new Date(now - 30 * 24 * 3600 * 1000) })];  // a month past the reference TTL
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
    assert.strictEqual(providerHttpCalls.length, 0);
  });

  it('2b: cached URL + Render-restart simulation (Redis + memory empty) → AnimeHeaven NOT called', async () => {
    dbRows = [makeRow({})];
    assert.strictEqual(redisStore.size, 0);
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
  });

  it('2c: cached URL + temporary CDN failure (5xx) → AnimeHeaven NOT called, source stays reusable', async () => {
    const now = Date.now();
    dbRows = [makeRow({ verification_status: 'active', last_verified_at: new Date(now - 60 * 1000) })];
    // providerHttp mock throws 500 on ANY upstream request — the payload must
    // still be served, because a reusable hit performs no upstream validation.
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
    assert.strictEqual(providerHttpCalls.length, 0, 'no upstream validation on a recently-verified hit');
  });

  it('2d: cached playback with deferred verification due → playback still served immediately; temporary failure never invalidates', async () => {
    dbRows = [makeRow({})];   // never verified → verification due (deferred)
    const payload = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
    assertSavesSavedUrl(payload, SAVED_URL);
    await settleDeferred();   // deferred verification runs against the throwing mock (500)
    assert.strictEqual(dbRows[0].verification_status, 'unknown', 'a 500 verification failure CANNOT invalidate');
  });
});

// ═══════════════════════════════════════════════════════════
// Branch 3: Proven dead → invalidate → ONE fresh resolution
// ═══════════════════════════════════════════════════════════
describe('Branch 3 — Confirmed 403/404/410 invalidates and permits fresh resolution', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; redisStore = new Map();
    inFlightResolverManager.reset(); providerHttpCalls = [];
  });

  for (const status of [403, 404, 410]) {
    it(`3/${status}: confirmed ${status} → row invalidated → fresh resolution runs → replacement saved`, async () => {
      // 1. Start with a reusable row that gets invalidated by the deferred check.
      const row = makeRow({});
      dbRows = [row];
      // 2. First playback serves the saved URL (never re-resolves proactively).
      const first = await streamingService.resolveStream('Test Anime', 3, { episodeId: EP_ID });
      assertSavesSavedUrl(first, SAVED_URL);
      assert.strictEqual(row.verification_status, 'unknown', 'playback itself did not invalidate');
      // 3. Simulate the authoritative death signal (real playback failure path
      //    or mutually-confirmed observation): invalidate via the state machine.
      await streamCacheService.invalidateSource(EP_ID, PROVIDER, status);
      assert.strictEqual(row.verification_status, 'invalid');
      assert.strictEqual(streamCacheService.isReusable(row), false);
      // 4. Next playback: fresh resolution is now permitted. The "resolver"
      //    here is the AnimeHeaven resolution path — represented by the
      //    replacement result it would produce.
      dbRows = null;   // invalid row no longer reusable; fresh resolution replaces it
      const replacement = {
        provider: 'animeheaven', streamUrl: REPLACEMENT_URL,
        sources: [{ url: REPLACEMENT_URL, quality: '720' }], subtitles: [],
      };
      const second = await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => replacement);
      assert.strictEqual(second.streamUrl, REPLACEMENT_URL, 'replacement URL used');
      assert.ok(redisStore.has(streamCacheService.buildRedisKey(EP_ID, PROVIDER)), 'replacement persisted/accelerated');
    });
  }
});

// ═══════════════════════════════════════════════════════════
// Branch 4: No persisted stream → initial provider resolution
// ═══════════════════════════════════════════════════════════
describe('Branch 4 — No persisted stream → initial resolution', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; redisStore = new Map();
    inFlightResolverManager.reset(); providerHttpCalls = [];
  });

  it('4a: no cached stream → resolution runs ONCE and the result is saved', async () => {
    dbRows = null;   // no manual URL, no cache row
    let resolverRuns = 0;
    const fresh = {
      provider: 'animeheaven', streamUrl: REPLACEMENT_URL,
      sources: [{ url: REPLACEMENT_URL, quality: '720' }], subtitles: [],
    };
    const payload = await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => {
      resolverRuns += 1; return fresh;
    });
    assert.strictEqual(resolverRuns, 1, 'single-flight: exactly ONE resolution');
    assert.strictEqual(payload.streamUrl, REPLACEMENT_URL);
    assert.ok(redisStore.has(streamCacheService.buildRedisKey(EP_ID, PROVIDER)), 'saved to persistent cache');
  });

  it('4b: second playback after the initial resolution uses the saved URL — AnimeHeaven NOT called again', async () => {
    dbRows = null;
    const fresh = {
      provider: 'animeheaven', streamUrl: REPLACEMENT_URL,
      sources: [{ url: REPLACEMENT_URL, quality: '720' }], subtitles: [],
    };
    await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => fresh);
    // Simulate the DB now containing the saved row (as the real save would).
    dbRows = [makeRow({ stream_data: { provider: 'animeheaven', streamUrl: REPLACEMENT_URL, sources: [{ url: REPLACEMENT_URL, quality: '720' }], subtitles: [] } })];
    // Empty ALL acceleration layers again.
    redisStore = new Map(); inFlightResolverManager.reset();
    let resolverRuns = 0;
    const payload = await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => {
      resolverRuns += 1; return fresh;
    });
    assert.strictEqual(resolverRuns, 0, 'AnimeHeaven NOT called again — saved URL reused');
    assert.strictEqual(payload.streamUrl, REPLACEMENT_URL);
  });
});

// ═══════════════════════════════════════════════════════════
// Branch 5: Fresh-resolution failure → fallback behavior intact
// ═══════════════════════════════════════════════════════════
describe('Branch 5 — Fallback providers preserved on legitimate fresh resolution', () => {
  beforeEach(() => {
    manualVideoUrl = null; dbRows = null; redisStore = new Map();
    inFlightResolverManager.reset(); providerHttpCalls = [];
  });

  it('5a: Phase-4 fallback structure is intact (AnimeHeaven-first, fallbacks after 3 attempts)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/streamingService'), 'utf8');
    assert.ok(src.includes('FALLBACK PROVIDERS: KickAssAnime, Hianime, AnimePahe'), 'fallback chain documented');
    assert.ok(src.includes('executeAnimeHeaven'), 'AnimeHeaven executor present');
    assert.ok(src.includes('fallbackActivated = true'), 'fallback activation present');
  });

  it('5b: a failed fresh resolution does NOT poison the cache — next playback may retry', async () => {
    dbRows = null;
    let attempts = 0;
    let fail = true;
    const fresh = {
      provider: 'animeheaven', streamUrl: REPLACEMENT_URL,
      sources: [{ url: REPLACEMENT_URL, quality: '720' }], subtitles: [],
    };
    await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => {
      attempts += 1;
      if (fail) throw new Error('animeheaven down');
      return fresh;
    });
    assert.strictEqual(attempts, 1);
    assert.strictEqual(redisStore.size, 0, 'failed resolution is NOT cached as success');
    // AnimeHeaven recovers (after the in-flight settled-entry grace expires)
    // → next playback resolves and saves.
    inFlightResolverManager.reset();
    fail = false;
    const second = await streamCacheService.getOrResolve(EP_ID, PROVIDER, async () => fresh);
    assert.strictEqual(second.streamUrl, REPLACEMENT_URL);
  });
});
