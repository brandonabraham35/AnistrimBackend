// tests/streamCacheSweeper.test.js
// Unit tests for the persistent-until-proven-dead cache sweeper.
//
// Proves the core requirement: the sweeper must NEVER delete a reusable
// (unknown/active) source merely because the old AniStrim TTL (expires_at)
// elapsed. Only PROVEN-DEAD rows and rows with a passed real upstream expiry
// (detected_expires_at) are eligible for deletion.
//
// Hermetic: config/db is mocked so no real database is contacted.
'use strict';

const assert = require('assert');

// ── Mock infrastructure (same pattern as zzStreamCacheReuse.test.js) ──

const captured = { queries: [] };

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {}, debugStream() {},
  stream() {}, streamAttempt() {},
};

const mockStreamDiag = { logCacheProbe() {}, logCacheCreation() {}, logFreshResolution() {} };

const mockMetrics = {
  increment() {}, recordSourceLifetime() {}, recordProviderCall() {}, recordInvalidation() {},
  getSnapshot: async () => ({}), reset() {}, counters: {}, sourceLifetimes: [],
};

const mockCache = {
  store: new Map(),
  async get(key) { return this.store.get(key) || null; },
  async set(key, value) { this.store.set(key, value); },
  async del(key) { this.store.delete(key); },
  async delByPrefix(prefix) { for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k); },
};

const mockProviderHttp = {
  request: async () => { throw new Error('mock (fail-open)'); },
  isProviderHealthy: () => true,
  recordSuccess() {}, recordFailure() {}, markTimeout() {},
  classifyError: () => ({ category: 'NETWORK', description: 'mock' }),
  isTimeoutError: () => false,
  getProviderHealth: () => ({}), getHealthStats: () => null,
};

function mountMock(id, exportsObj) {
  const resolved = require.resolve(id);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Sweeper DB mock ──
// For sweepExpired() we simply return affectedRows and capture the SQL.
async function mockDbQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  captured.queries.push({ sql: s, params });
  return [{ affectedRows: captured.deletedRows }];
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

// ── Tests ─────────────────────────────────────────────────

describe('Stream cache sweeper — persistent-until-proven-dead', () => {
  beforeEach(() => {
    captured.queries.length = 0;
    captured.deletedRows = 0;
  });

  it('does NOT delete old-but-reusable rows merely because expires_at passed (Prompt #22)', async () => {
    captured.deletedRows = 5;
    const deleted = await streamCacheService.sweepExpired();

    const sweep = captured.queries.find(q => q.sql.includes('DELETE FROM episode_stream_cache'));
    assert.ok(sweep, 'a DELETE sweep must run');

    // The sweep must only target rows that are BOTH old (expires_at passed)
    // AND provably non-reusable (invalid, or passed real upstream expiry).
    assert.ok(
      sweep.sql.includes("verification_status = 'invalid'"),
      'DELETE must be gated on verification_status = invalid'
    );
    assert.ok(
      sweep.sql.includes('detected_expires_at <= '),
      'DELETE must also target rows with a passed real upstream expiry'
    );

    // Most importantly: it must NOT be a blanket "expires_at <= NOW()" delete —
    // it must be gated on non-reusability via an AND clause, not age alone.
    assert.ok(
      sweep.sql.includes('AND ('),
      'the age condition must be gated on non-reusability, not used alone'
    );
    const blanket = /DELETE FROM episode_stream_cache\s+WHERE expires_at\s*<=\s*\?\s*$/.test(sweep.sql);
    assert.strictEqual(blanket, false, 'the sweeper must never delete by age alone');

    assert.strictEqual(deleted, 5);
  });

  it('deletes only proven-dead / known-upstream-expired rows (both gating conditions present)', async () => {
    await streamCacheService.sweepExpired();
    const sweep = captured.queries.find(q => q.sql.includes('DELETE FROM episode_stream_cache'));
    assert.ok(sweep);

    // Two params: now (expires_at <= now) + now (detected_expires_at <= now).
    assert.ok(Array.isArray(sweep.params) && sweep.params.length === 2, 'sweep needs two timestamp params');
    // Both are Date instances (the same "now").
    assert.ok(sweep.params.every(p => p instanceof Date), 'sweep params are timestamps');
  });
});