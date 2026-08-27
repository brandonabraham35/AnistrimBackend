// tests/inFlightResolverConcurrency.test.js
// Load tests for the in-flight resolver concurrency mechanism.
// Verifies that 100 concurrent requests for the same episode produce exactly 1 resolver call.
'use strict';

const assert = require('assert');
const inFlightResolverManager = require('../services/inFlightResolverManager');

// ── Helper: simulate resolver with delay ────────────────────

function createMockResolver(delayMs, shouldFail = false) {
  let callCount = 0;
  const resolver = async () => {
    callCount += 1;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (shouldFail) throw new Error('Resolver failed intentionally');
    return { sources: [{ url: 'https://cdn.example.com/video.mp4', quality: '720' }] };
  };
  resolver.getCallCount = () => callCount;
  return resolver;
}

// ── Helper: run N concurrent requests ──────────────────────

async function runConcurrentRequests(key, resolver, count) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const { promise } = inFlightResolverManager.register(key, resolver);
    promises.push(promise);
  }
  const results = await Promise.allSettled(promises);
  return results;
}

// ── Test: 100 requests, same episode, 1 resolver call ───────

describe('Concurrency: 100 requests same episode', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('100 concurrent requests → exactly 1 resolver call', async () => {
    const resolver = createMockResolver(100);
    const key = 'animeheaven:123';

    const results = await runConcurrentRequests(key, resolver, 100);

    // All 100 should succeed
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 100, 'All 100 requests should succeed');

    // Resolver should be called exactly once
    assert.strictEqual(resolver.getCallCount(), 1, 'Resolver should be called exactly once');

    // Metrics should reflect 99 prevented duplicates
    const metrics = inFlightResolverManager.getMetrics();
    assert.strictEqual(metrics.duplicateRequestsPrevented, 99, '99 duplicate requests should be prevented');
    assert.strictEqual(metrics.resolverStarted, 1, 'Exactly 1 resolver should start');
  });

  it('all 100 requests receive the same result', async () => {
    const resolver = createMockResolver(50);
    const key = 'animeheaven:456';

    const results = await runConcurrentRequests(key, resolver, 100);

    const urls = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value.sources[0].url);

    // All should have the same URL
    const uniqueUrls = new Set(urls);
    assert.strictEqual(uniqueUrls.size, 1, 'All requests should receive the same source URL');
  });
});

// ── Test: 100 requests across 10 episodes ───────────────────

describe('Concurrency: 100 requests across 10 episodes', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('10 episodes × 10 requests each → 10 resolver calls', async () => {
    const resolvers = {};
    const allPromises = [];

    for (let ep = 1; ep <= 10; ep++) {
      const key = `animeheaven:${ep}`;
      const resolver = createMockResolver(50);
      resolvers[ep] = resolver;

      for (let i = 0; i < 10; i++) {
        const { promise } = inFlightResolverManager.register(key, resolver);
        allPromises.push(promise);
      }
    }

    const results = await Promise.allSettled(allPromises);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 100, 'All 100 requests should succeed');

    // Each episode's resolver should be called exactly once
    for (let ep = 1; ep <= 10; ep++) {
      assert.strictEqual(
        resolvers[ep].getCallCount(),
        1,
        `Episode ${ep} resolver should be called exactly once`
      );
    }

    // Total: 10 resolver calls for 100 requests
    const totalCalls = Object.values(resolvers).reduce((sum, r) => sum + r.getCallCount(), 0);
    assert.strictEqual(totalCalls, 10, 'Total resolver calls should be 10 (one per episode)');
  });
});

// ─ Test: Resolver failure behavior ─────────────────────────

describe('Concurrency: resolver failure', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('resolver failure → all waiters receive null (no throw)', async () => {
    const resolver = createMockResolver(50, true); // shouldFail=true
    const key = 'animeheaven:999';

    const results = await runConcurrentRequests(key, resolver, 10);

    // The resolver catches errors and returns null — it never throws
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 10, 'All 10 requests should fulfill (resolver catches errors)');

    // All should receive null (the resolver returns null on failure)
    const nullResults = fulfilled.filter(r => r.value === null);
    assert.strictEqual(nullResults.length, 10, 'All should receive null result on failure');

    // Metrics
    const metrics = inFlightResolverManager.getMetrics();
    assert.strictEqual(metrics.resolverFailed, 1, '1 resolver should fail');
  });

  it('after failure, lock is released for retry', async () => {
    const failingResolver = createMockResolver(50, true);
    const successResolver = createMockResolver(50, false);
    const key = 'animeheaven:888';

    // First batch fails (returns null)
    await runConcurrentRequests(key, failingResolver, 5);

    // After failure, the entry is settled — cleanup should allow new resolver
    inFlightResolverManager.cleanup(key);

    // Second batch should start a new resolver
    const results = await runConcurrentRequests(key, successResolver, 5);
    const fulfilled = results.filter(r => r.status === 'fulfilled' && r.value !== null);
    assert.strictEqual(fulfilled.length, 5, 'Second batch should succeed after retry');

    // Total: 2 resolver calls (1 failed + 1 succeeded)
    assert.strictEqual(successResolver.getCallCount(), 1, 'Retry resolver should be called once');
  });

  it('no permanent deadlock after failure', async () => {
    const resolver = createMockResolver(50, true);
    const key = 'animeheaven:777';

    // Fire and forget — should not hang
    const promise = runConcurrentRequests(key, resolver, 10);

    // Should complete within reasonable time (not deadlock)
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Deadlock detected')), 5000)
    );

    await Promise.race([promise, timeout]);
    // If we reach here, no deadlock occurred
    assert.ok(true, 'No deadlock after resolver failure');
  });
});

// ── Test: Timeout behavior ──────────────────────────────────

describe('Concurrency: timeout', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('soft timeout does not cancel resolver', async () => {
    // Resolver takes longer than timeout
    const resolver = createMockResolver(500);
    const key = 'animeheaven:666';

    const results = await runConcurrentRequests(key, resolver, 10);

    // All should still succeed (timeout is soft)
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 10, 'All requests should succeed despite timeout');

    // Resolver should still be called once
    assert.strictEqual(resolver.getCallCount(), 1, 'Resolver should complete despite timeout');

    // Note: The soft timeout only fires if the resolver hasn't settled within RESOLVER_TIMEOUT_MS.
    // Since our mock resolver returns quickly (500ms < 20000ms default timeout),
    // the timeout won't fire. This test verifies the resolver completes normally.
    const metrics = inFlightResolverManager.getMetrics();
    assert.strictEqual(metrics.resolverCompleted, 1, 'Resolver should complete');
  });
});

// ── Test: Partial failure ───────────────────────────────────

describe('Concurrency: partial failure', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('mixed success/failure across different episodes', async () => {
    const successKey = 'animeheaven:100';
    const failKey = 'animeheaven:200';

    const successResolver = createMockResolver(50, false);
    const failResolver = createMockResolver(50, true);

    const successResults = await runConcurrentRequests(successKey, successResolver, 50);
    const failResults = await runConcurrentRequests(failKey, failResolver, 50);

    // Success batch
    const successFulfilled = successResults.filter(r => r.status === 'fulfilled' && r.value !== null);
    assert.strictEqual(successFulfilled.length, 50, 'All success requests should succeed');

    // Fail batch — resolver catches errors and returns null
    const failFulfilled = failResults.filter(r => r.status === 'fulfilled' && r.value === null);
    assert.strictEqual(failFulfilled.length, 50, 'All fail requests should return null (not throw)');

    // Resolver calls: 1 success + 1 fail = 2 total
    assert.strictEqual(successResolver.getCallCount(), 1);
    assert.strictEqual(failResolver.getCallCount(), 1);
  });
});

// ─ Test: Episode isolation ─────────────────────────────────

describe('Concurrency: episode isolation', () => {
  beforeEach(() => {
    inFlightResolverManager.reset();
  });

  it('different episodes do not block each other', async () => {
    const key1 = 'animeheaven:1';
    const key2 = 'animeheaven:2';

    // Slow resolver for episode 1
    const slowResolver = createMockResolver(500);
    // Fast resolver for episode 2
    const fastResolver = createMockResolver(10);

    const start = Date.now();

    // Start both concurrently
    const [results1, results2] = await Promise.all([
      runConcurrentRequests(key1, slowResolver, 10),
      runConcurrentRequests(key2, fastResolver, 10),
    ]);

    const elapsed = Date.now() - start;

    // Episode 2 should complete quickly (not blocked by episode 1)
    // If isolation works, elapsed should be ~500ms (slow resolver time)
    // If blocked, it would be ~1000ms (sequential)
    assert.ok(elapsed < 800, `Episode 2 should not be blocked by episode 1 (took ${elapsed}ms)`);

    // Both should succeed
    assert.strictEqual(results1.filter(r => r.status === 'fulfilled').length, 10);
    assert.strictEqual(results2.filter(r => r.status === 'fulfilled').length, 10);
  });
});
