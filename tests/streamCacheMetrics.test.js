// tests/streamCacheMetrics.test.js
// Tests for the stream cache metrics collector and admin endpoint.
'use strict';

const assert = require('assert');

// ── Helpers: isolate module with fresh mocks ──────────────

function loadMetrics() {
  // Clear cache for the metrics module
  for (const key of ['../config/db', '../utils/logger', '../services/streamCacheMetrics']) {
    try { delete require.cache[require.resolve(key)]; } catch (_) {}
  }

  const mockDb = { query: async () => [[{
    total: 10, active: 6, known_expiry: 3, unknown_expiry: 7
  }]] };
  const mockLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

  const dbPath = require.resolve('../config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
  const loggerPath = require.resolve('../utils/logger');
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: mockLogger };

  return require('../services/streamCacheMetrics');
}

// ── Test Suite ─────────────────────────────────────────────

describe('Stream Cache Metrics', () => {

  describe('counters', () => {
    it('starts at zero', () => {
      const metrics = loadMetrics();
      metrics.reset();
      assert.strictEqual(metrics.counters.redisHits, 0);
      assert.strictEqual(metrics.counters.mysqlHits, 0);
      assert.strictEqual(metrics.counters.cacheMisses, 0);
      assert.strictEqual(metrics.counters.resolverCalls, 0);
      assert.strictEqual(metrics.counters.animeHeavenCalls, 0);
      assert.strictEqual(metrics.counters.consumetCalls, 0);
      assert.strictEqual(metrics.counters.thordataCalls, 0);
      assert.strictEqual(metrics.counters.expiredSources, 0);
      assert.strictEqual(metrics.counters.invalidSources, 0);
      assert.strictEqual(metrics.counters.verificationSuccesses, 0);
      assert.strictEqual(metrics.counters.verificationFailures, 0);
      assert.strictEqual(metrics.counters.playbackReportedFailures, 0);
    });

    it('increment works for all counters', () => {
      const metrics = loadMetrics();
      metrics.reset();
      metrics.increment('redisHits');
      metrics.increment('redisHits');
      metrics.increment('mysqlHits');
      metrics.increment('cacheMisses');
      metrics.increment('resolverCalls');
      metrics.increment('animeHeavenCalls');
      metrics.increment('consumetCalls');
      metrics.increment('thordataCalls');
      metrics.increment('expiredSources');
      metrics.increment('invalidSources');
      metrics.increment('verificationSuccesses');
      metrics.increment('verificationFailures');
      metrics.increment('playbackReportedFailures');

      assert.strictEqual(metrics.counters.redisHits, 2);
      assert.strictEqual(metrics.counters.mysqlHits, 1);
      assert.strictEqual(metrics.counters.cacheMisses, 1);
      assert.strictEqual(metrics.counters.resolverCalls, 1);
      assert.strictEqual(metrics.counters.animeHeavenCalls, 1);
      assert.strictEqual(metrics.counters.consumetCalls, 1);
      assert.strictEqual(metrics.counters.thordataCalls, 1);
      assert.strictEqual(metrics.counters.expiredSources, 1);
      assert.strictEqual(metrics.counters.invalidSources, 1);
      assert.strictEqual(metrics.counters.verificationSuccesses, 1);
      assert.strictEqual(metrics.counters.verificationFailures, 1);
      assert.strictEqual(metrics.counters.playbackReportedFailures, 1);
    });

    it('ignores unknown counter names', () => {
      const metrics = loadMetrics();
      metrics.reset();
      metrics.increment('nonexistent');
      assert.strictEqual(metrics.counters.redisHits, 0);
    });
  });

  describe('source lifetime', () => {
    it('records lifetime samples', () => {
      const metrics = loadMetrics();
      metrics.reset();
      metrics.recordSourceLifetime(3600000); // 1 hour
      metrics.recordSourceLifetime(7200000); // 2 hours
      assert.strictEqual(metrics.sourceLifetimes.length, 2);
    });

    it('caps at 500 samples', () => {
      const metrics = loadMetrics();
      metrics.reset();
      for (let i = 0; i < 600; i++) {
        metrics.recordSourceLifetime(1000);
      }
      assert.strictEqual(metrics.sourceLifetimes.length, 500);
    });

    it('rejects invalid values', () => {
      const metrics = loadMetrics();
      metrics.reset();
      metrics.recordSourceLifetime(-1);
      metrics.recordSourceLifetime(NaN);
      metrics.recordSourceLifetime(0);
      assert.strictEqual(metrics.sourceLifetimes.length, 0);
    });
  });

  describe('snapshot', () => {
    it('returns all 16 metrics fields', async () => {
      const metrics = loadMetrics();
      metrics.reset();
      metrics.increment('redisHits');
      metrics.increment('mysqlHits');
      metrics.increment('cacheMisses');
      metrics.increment('resolverCalls');
      metrics.increment('animeHeavenCalls');
      metrics.increment('consumetCalls');
      metrics.increment('verificationSuccesses');
      metrics.increment('verificationFailures');
      metrics.recordSourceLifetime(3600000);

      const snapshot = await metrics.getSnapshot();

      assert.strictEqual(snapshot.redisHits, 1);
      assert.strictEqual(snapshot.mysqlHits, 1);
      assert.strictEqual(snapshot.cacheMisses, 1);
      assert.strictEqual(snapshot.resolverCalls, 1);
      assert.strictEqual(snapshot.animeHeavenCalls, 1);
      assert.strictEqual(snapshot.consumetCalls, 1);
      assert.strictEqual(snapshot.thordataCalls, 0);
      assert.strictEqual(snapshot.expiredSources, 0);
      assert.strictEqual(snapshot.invalidSources, 0);
      assert.strictEqual(snapshot.verificationSuccesses, 1);
      assert.strictEqual(snapshot.verificationFailures, 1);
      assert.strictEqual(snapshot.playbackReportedFailures, 0);
      assert.strictEqual(snapshot.activeCachedSources, 6);
      assert.strictEqual(snapshot.knownExpirySources, 3);
      assert.strictEqual(snapshot.unknownExpirySources, 7);
      assert.ok(snapshot.averageSourceLifetimeMs > 0);
    });

    it('handles DB failure gracefully', async () => {
      const metrics = loadMetrics();
      metrics.reset();

      // Pass a failing db pool directly to getSnapshot
      const failingDb = {
        query: async () => { throw new Error('DB down'); }
      };

      const snapshot = await metrics.getSnapshot(failingDb);
      // Should return zeros for DB fields but still have in-memory counters
      assert.strictEqual(snapshot.activeCachedSources, 0);
      assert.strictEqual(snapshot.knownExpirySources, 0);
      assert.strictEqual(snapshot.unknownExpirySources, 0);
      assert.strictEqual(snapshot.redisHits, 0);
    });
  });

  describe('reset', () => {
    it('clears all counters and samples', () => {
      const metrics = loadMetrics();
      metrics.increment('redisHits');
      metrics.increment('mysqlHits');
      metrics.recordSourceLifetime(1000);
      metrics.reset();

      assert.strictEqual(metrics.counters.redisHits, 0);
      assert.strictEqual(metrics.counters.mysqlHits, 0);
      assert.strictEqual(metrics.sourceLifetimes.length, 0);
    });
  });
});
