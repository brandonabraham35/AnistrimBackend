// ===========================================================
//  tests/zzStreamCacheReuse.test.js
//
//  Audit Step 1 — persistent save after NOT_REUSABLE.
//
//  Proves the primary cache-reuse defect is fixed:
//    • First request on an `invalid` MySQL row → NOT_REUSABLE →
//      Phase 4 AnimeHeaven resolution → saveStream() repairs the row.
//    • Second request (general cache expired) → the persistent row is now
//      reusable → served from cache → AnimeHeaven is NOT called again.
//
//  Hermetic: all heavy dependencies are mocked; no network, DB, or Redis.
// ===========================================================
'use strict';
const assert = require('assert');

// ── Environment (must be set before config/streamCache is loaded) ──
process.env.STREAM_CACHE_ENABLED = 'true';
process.env.STREAM_CACHE_PROVIDER = 'animeheaven';
process.env.STREAM_CACHE_TTL_MINUTES = '360';

// ── Shared observable state ─────────────────────────────────
const state = { cacheValid: false, providerCalls: 0, providerLog: [], queryLog: [] };

// ── Mocks ────────────────────────────────────────────────────
const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  debugStream() {}, stream() {}, streamAttempt() {},
};

const mockCache = {
  store: new Map(),
  async get(key) { return this.store.get(key) || null; },
  async set(key, value) { this.store.set(key, value); },
  async del(key) { this.store.delete(key); },
  async delByPrefix(prefix) {
    for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k);
  },
};

function makeRow(verificationStatus) {
  return {
    id: 1,
    episode_id: 123,
    provider: 'animeheaven',
    stream_type: 'direct',
    stream_data: {
      provider: 'animeheaven',
      streamUrl: 'https://cdn.example.com/phase4.mp4',
      sources: [{ url: 'https://cdn.example.com/phase4.mp4', quality: '720', sourceType: 'video', referer: 'https://animeheaven.me', origin: 'https://animeheaven.me', cookies: null, headers: null }],
      subtitles: [],
      downloadSources: [],
    },
    expires_at: new Date(Date.now() + 3600 * 1000),
    detected_expires_at: null,
    expiry_source: 'unknown',
    verification_status: verificationStatus,
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

const mockDb = {
  async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.queryLog.push({ sql: s, params });
    if (s.includes('TIMESTAMPDIFF')) return [[{ lifetime_sec: 30 }]];
    if (s.includes('FROM episode_stream_cache')) {
      return state.cacheValid ? [[makeRow('unknown')], []] : [[makeRow('invalid')], []];
    }
    if (s.includes('INSERT INTO episode_stream_cache') || s.includes('ON DUPLICATE KEY UPDATE')) {
      state.cacheValid = true;
      return [{ affectedRows: 1 }];
    }
    return [{ affectedRows: 1 }];
  },
};
const mockProviderHttp = {
  request: async () => { throw new Error('mock network error (fail-open)'); },
  isProviderHealthy: () => true,
  recordSuccess() {}, recordFailure() {}, markTimeout() {},
  classifyError: () => ({ category: 'NETWORK', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}),
  getHealthStats: () => null,
};

const mockAnimeHeavenProvider = {
  provider: {
    resolveStreamByKey: async ({ slug, episodeKey } = {}) => {
      state.providerCalls += 1;
      state.providerLog.push({ episodeKey: episodeKey || null });
      return {
        provider: 'animeheaven',
        streamUrl: 'https://cdn.example.com/phase4.mp4',
        sources: [{ url: 'https://cdn.example.com/phase4.mp4', quality: '720', sourceType: 'video', referer: 'https://animeheaven.me', origin: 'https://animeheaven.me', cookies: null, headers: null }],
        subtitles: [],
        downloadSources: [],
      };
    },
    extractStreams: async () => null,
    resolveStream: async () => null,
    getAnimeDetails: async () => ({ episodes: [] }),
    getPlaybackContext: () => null,
  },
};

const mockConsumetProvider = {
  ConsumetProvider: class { async resolveStreamUrl() { return null; } },
};

const mockAnimeHeavenImportService = {
  resolvePlaybackIdentifiers: async (animeTitle, episodeNumber) => ({
    slug: 'test-slug',
    episodeKey: 'ep-' + String(episodeNumber),
    episodeUrl: 'https://animeheaven.me/watch/test-slug/ep-' + String(episodeNumber),
    episodeId: 123,
    animeId: 1,
  }),
};

const mockStreamCacheMetrics = {
  increment() {}, reset() {}, getSnapshot: async () => ({}),
  recordSourceLifetime() {}, counters: {},
};

const mockStreamDiagnostics = {
  logFreshResolution() {}, logCacheHit() {}, logCacheProbe() {},
  logCacheCreation() {}, logCacheInvalidation() {}, logPlaybackFailure() {},
  logProxyPlayback() {}, diagLog() {}, fingerprintUrl() {},
};

const mockStreamObservationService = {
  observeOnCacheHit: async () => {},
};

// ── Module wiring ────────────────────────────────────────────
function mountMock(id, exportsObj) {
  const resolved = require.resolve(id);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
mountMock('../config/db', mockDb);
mountMock('../utils/cacheService', mockCache);
mountMock('../utils/logger', mockLogger);
mountMock('../utils/providerHttp', mockProviderHttp);
mountMock('../services/animeHeavenProvider', mockAnimeHeavenProvider);
mountMock('../services/consumetProvider', mockConsumetProvider);
mountMock('../services/animeHeavenImportService', mockAnimeHeavenImportService);
mountMock('../services/streamCacheMetrics', mockStreamCacheMetrics);
mountMock('../utils/streamDiagnostics', mockStreamDiagnostics);
mountMock('../services/streamObservationService', mockStreamObservationService);

// Fresh reload so env + mocks apply.
delete require.cache[require.resolve('../config/streamCache')];
delete require.cache[require.resolve('../services/streamCacheService')];
delete require.cache[require.resolve('../services/streamingService')];

// Load it once (fresh, with mocks applied). streamingService shares the same
// instance, so we can assert the persistent save via the wiring below.
require('../services/streamCacheService');
const streamingService = require('../services/streamingService');
// ── Tests ────────────────────────────────────────────────────
describe('Stream cache reuse after NOT_REUSABLE (audit Step 1)', () => {
  beforeEach(() => {
    state.cacheValid = false;
    state.providerCalls = 0;
    state.providerLog.length = 0;
    state.queryLog.length = 0;
    mockCache.store.clear();
  });

  function saveUpserts() {
    return state.queryLog.filter(q => q.sql.includes('ON DUPLICATE KEY UPDATE') && q.sql.includes('episode_stream_cache'));
  }

  function callsForEpisode(episodeKey) {
    return state.providerLog.filter(c => c.episodeKey === episodeKey).length;
  }

  it('first play: invalid persistent row → AnimeHeaven resolves → saveStream() persists it', async () => {
    const result = await streamingService.resolveStream('Test Anime', 1, { isPremium: true, episodeId: 123 });

    assert.ok(result && Array.isArray(result.sources) && result.sources.length > 0, 'playable source returned');
    // resolveStream() also prefetches the NEXT episode in the background, so we
    // count only the resolution for the requested episode (ep-1).
    assert.strictEqual(callsForEpisode('ep-1'), 1, 'first play resolves the requested episode exactly once');
    assert.ok(saveUpserts().length >= 1, 'saveStream() (INSERT ... ON DUPLICATE KEY UPDATE) must execute');
  });

  it('second play (general cache expired): persistent row is reusable → provider NOT called again', async () => {
    // First play repairs the invalid row via saveStream().
    await streamingService.resolveStream('Test Anime', 1, { isPremium: true, episodeId: 123 });
    assert.strictEqual(callsForEpisode('ep-1'), 1);
    assert.strictEqual(saveUpserts().length >= 1, true, 'saveStream must have run');
    assert.strictEqual(state.cacheValid, true, 'saveStream must flip the persistent row to valid');

    // Simulate the general-cache TTL expiring — the ROOT CAUSE scenario —
    // while the persistent MySQL row stays intact.
    mockCache.store.clear();

    const second = await streamingService.resolveStream('Test Anime', 1, { isPremium: true, episodeId: 123 });

    assert.strictEqual(second.cached, true, 'second play must be served from the persistent cache');
    assert.strictEqual(callsForEpisode('ep-1'), 1, 'AnimeHeaven must NOT be called again for the same episode');
    assert.ok(
      state.queryLog.some(q => q.sql.includes('FROM episode_stream_cache')),
      'second play must read the persistent cache'
    );
  });
});