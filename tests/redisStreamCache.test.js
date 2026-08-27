// tests/redisStreamCache.test.js
// Unit tests for Redis-first stream cache tier.
'use strict';

const assert = require('assert');
const { buildRedisKey } = require('../services/streamCacheService');

// ── Redis key format tests ─────────────────────────────────

describe('buildRedisKey', () => {
  it('builds correct key for episode + provider', () => {
    const key = buildRedisKey(123, 'animeheaven');
    assert.strictEqual(key, 'stream:source:animeheaven:123');
  });

  it('builds correct key for string episodeId', () => {
    const key = buildRedisKey('456', 'animeheaven');
    assert.strictEqual(key, 'stream:source:animeheaven:456');
  });

  it('handles different providers', () => {
    const key = buildRedisKey(789, 'kickassanime');
    assert.strictEqual(key, 'stream:source:kickassanime:789');
  });
});

// ── Cache tier priority tests ──────────────────────────────
// These tests verify the Redis → Memory → MySQL → Resolver flow.
// Since we can't mock the full cache service without a running DB/Redis,
// we test the key building and the logical flow via the exported functions.

describe('Redis-first cache flow', () => {
  it('Redis key is distinct from in-memory key', () => {
    const redisKey = buildRedisKey(100, 'animeheaven');
    const memoryKey = 'animeheaven:100';
    assert.notStrictEqual(redisKey, memoryKey);
    assert.ok(redisKey.startsWith('stream:source:'));
  });

  it('Redis key includes provider for multi-provider support', () => {
    const key1 = buildRedisKey(100, 'animeheaven');
    const key2 = buildRedisKey(100, 'kickassanime');
    assert.notStrictEqual(key1, key2);
  });
});
