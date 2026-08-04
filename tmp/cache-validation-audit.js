'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const providerPath = path.resolve(__dirname, '../services/animeHeavenProvider.js');
const providerHttpPath = path.resolve(__dirname, '../utils/providerHttp.js');

const IDENTICAL_RUNS = 100;
const PAGE_CACHE_TTL_MS = 120 * 1000;

const BASE_HTML = '<html><head><title>AnimeHeaven</title></head><body>ok</body></html>';

function buildDetailsHtml(title, key) {
  return [
    '<html><head>',
    `<title>${title} | AnimeHeaven.Me</title>`,
    '<meta property="og:title" content="' + title + '"/>',
    '</head><body>',
    `<a href="/gate.php" onclick="gatea('${key}')">Episode 1</a>`,
    '<div class="infotags"><a href="/genre/action">Action</a></div>',
    '<div class="infodes">Cache validation synopsis</div>',
    '</body></html>',
  ].join('');
}

function makeMockRequest(state) {
  return async function request(config) {
    const url = String((config && config.url) || '');
    state.netCalls += 1;
    state.urlCounts[url] = (state.urlCounts[url] || 0) + 1;

    if (/animeheaven\.(me|ru)/i.test(url) && !/anime\.php\?/i.test(url)) {
      return { status: 200, data: BASE_HTML, headers: {} };
    }

    if (/anime\.php\?cachetest1/i.test(url)) {
      return { status: 200, data: buildDetailsHtml('Cache Test Show One', 'abcdefabcdefabcd'), headers: {} };
    }

    if (/anime\.php\?cachetest2/i.test(url)) {
      return { status: 200, data: buildDetailsHtml('Cache Test Show Two', 'bcdefabcdefabcde'), headers: {} };
    }

    return { status: 404, data: '<html><body>not found</body></html>', headers: {} };
  };
}

function loadProviderWithMock(mockRequest) {
  const providerHttp = require(providerHttpPath);
  const originalRequest = providerHttp.request;

  providerHttp.request = mockRequest;
  delete require.cache[providerPath];

  let loaded;
  try {
    loaded = require(providerPath);
  } finally {
    providerHttp.request = originalRequest;
  }

  return loaded.provider;
}

async function timedMs(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function avg(arr) {
  if (!arr.length) return 0;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3));
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

async function main() {
  const state = { netCalls: 0, urlCounts: {} };
  const mockRequest = makeMockRequest(state);

  const realDateNow = Date.now;
  const fixedStart = 1_700_000_000_000;
  let nowMs = fixedStart;
  Date.now = () => nowMs;

  try {
    const provider = loadProviderWithMock(mockRequest);

    const startMem = process.memoryUsage();
    let peakRss = startMem.rss;

    const runs = [];
    let cacheHits = 0;
    let cacheMisses = 0;

    for (let i = 0; i < IDENTICAL_RUNS; i += 1) {
      const before = state.netCalls;
      const ms = await timedMs(async () => {
        await provider.getAnimeDetails('cachetest1');
      });
      const after = state.netCalls;
      const delta = after - before;
      const hit = delta === 0;
      if (hit) cacheHits += 1;
      else cacheMisses += 1;

      const mem = process.memoryUsage();
      peakRss = Math.max(peakRss, mem.rss);

      runs.push({
        index: i + 1,
        cacheHit: hit,
        networkCallsDelta: delta,
        responseMs: Number(ms.toFixed(3)),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
      });

      if (global.gc && (i + 1) % 20 === 0) global.gc();
    }

    const endMem = process.memoryUsage();

    // Cache expiration: advance virtual clock past page cache TTL.
    nowMs += PAGE_CACHE_TTL_MS + 1;
    const beforeExpire = state.netCalls;
    const expireMs = await timedMs(async () => {
      await provider.getAnimeDetails('cachetest1');
    });
    const afterExpire = state.netCalls;
    const expirationDelta = afterExpire - beforeExpire;

    // Immediate repeat after re-fill should hit cache again.
    const beforePostExpireRepeat = state.netCalls;
    const postExpireRepeatMs = await timedMs(async () => {
      await provider.getAnimeDetails('cachetest1');
    });
    const postExpireRepeatDelta = state.netCalls - beforePostExpireRepeat;

    // Cache invalidation (different key/identifier should miss).
    const beforeInvalidation = state.netCalls;
    const invalidationMs = await timedMs(async () => {
      await provider.getAnimeDetails('cachetest2');
    });
    const invalidationDelta = state.netCalls - beforeInvalidation;

    // Repeating same invalidation key should hit.
    const beforeInvalidationRepeat = state.netCalls;
    const invalidationRepeatMs = await timedMs(async () => {
      await provider.getAnimeDetails('cachetest2');
    });
    const invalidationRepeatDelta = state.netCalls - beforeInvalidationRepeat;

    const output = {
      generatedAt: new Date(realDateNow()).toISOString(),
      provider: 'services/animeHeavenProvider.js',
      method: 'runtime-only cache audit with mocked providerHttp.request and virtualized Date.now',
      requestUnderTest: {
        type: 'identical_request',
        method: 'provider.getAnimeDetails',
        args: ['cachetest1'],
        runs: IDENTICAL_RUNS,
      },
      metrics: {
        cacheHits,
        cacheMisses,
        hitRate: Number(((cacheHits / IDENTICAL_RUNS) * 100).toFixed(2)),
        missRate: Number(((cacheMisses / IDENTICAL_RUNS) * 100).toFixed(2)),
        averageResponseMs: avg(runs.map((r) => r.responseMs)),
        p95ResponseMs: percentile(runs.map((r) => r.responseMs), 95),
        totalNetworkCallsObserved: state.netCalls,
      },
      memoryUsage: {
        rssStart: startMem.rss,
        rssEnd: endMem.rss,
        rssPeak: peakRss,
        rssDelta: endMem.rss - startMem.rss,
        heapUsedStart: startMem.heapUsed,
        heapUsedEnd: endMem.heapUsed,
        heapUsedDelta: endMem.heapUsed - startMem.heapUsed,
      },
      cacheExpiration: {
        ttlMsTested: PAGE_CACHE_TTL_MS,
        virtualAdvanceMs: PAGE_CACHE_TTL_MS + 1,
        networkCallsDeltaAfterExpiry: expirationDelta,
        responseMsAfterExpiry: Number(expireMs.toFixed(3)),
        networkCallsDeltaImmediateRepeat: postExpireRepeatDelta,
        responseMsImmediateRepeat: Number(postExpireRepeatMs.toFixed(3)),
        expiredAsExpected: expirationDelta > 0,
        recachedAsExpected: postExpireRepeatDelta === 0,
      },
      cacheInvalidation: {
        strategy: 'different cache key by changing identifier from cachetest1 to cachetest2',
        networkCallsDeltaOnNewKey: invalidationDelta,
        responseMsOnNewKey: Number(invalidationMs.toFixed(3)),
        networkCallsDeltaOnRepeatNewKey: invalidationRepeatDelta,
        responseMsOnRepeatNewKey: Number(invalidationRepeatMs.toFixed(3)),
        invalidatedAsExpected: invalidationDelta > 0,
        newKeyRecachedAsExpected: invalidationRepeatDelta === 0,
      },
      validations: {
        noCrash: true,
        noHang: true,
      },
      traces: {
        firstTenRuns: runs.slice(0, 10),
        lastTenRuns: runs.slice(-10),
        networkCallBreakdownByUrl: state.urlCounts,
      },
    };

    fs.writeFileSync('cache-validation.json', JSON.stringify(output, null, 2));
    console.log('WROTE cache-validation.json');
    console.log('HITS', cacheHits, 'MISSES', cacheMisses, 'AVG_MS', output.metrics.averageResponseMs);
  } finally {
    Date.now = realDateNow;
  }
}

main().catch((err) => {
  console.error('CACHE_VALIDATION_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
