const fs = require('fs');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const ph = require('../utils/providerHttp');
const originalRequest = ph.request;
const als = new AsyncLocalStorage();

let requestDelegate = originalRequest;
ph.request = async function patchedRequest(cfg, opts) {
  return requestDelegate(cfg, opts);
};

const { provider } = require('../services/animeHeavenProvider');

const CONCURRENCY_LEVELS = [10, 25, 50, 100];
const TIMEOUT_RE = /timeout|timed out|etimedout/i;

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pickTargets() {
  const mirror = safeReadJson('mirror-validation.json');
  if (!mirror || !Array.isArray(mirror.episodes)) return [];

  const unique = new Map();
  for (const row of mirror.episodes) {
    if (!row || !row.identifier || row.episodeNumber === undefined || row.episodeNumber === null) continue;
    const key = `${row.identifier}|${row.episodeNumber}`;
    if (unique.has(key)) continue;

    unique.set(key, {
      title: row.title || row.identifier,
      identifier: row.identifier,
      episode: Number(row.episodeNumber) || row.episodeNumber,
      key,
    });

    if (unique.size >= 10) break;
  }

  return [...unique.values()];
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeResponses(rows) {
  const durations = rows.map((r) => r.responseTimeMs);
  return {
    minMs: durations.length ? Math.min(...durations) : 0,
    maxMs: durations.length ? Math.max(...durations) : 0,
    avgMs: Number(mean(durations).toFixed(2)),
    p50Ms: Number(percentile(durations, 50).toFixed(2)),
    p95Ms: Number(percentile(durations, 95).toFixed(2)),
    p99Ms: Number(percentile(durations, 99).toFixed(2)),
  };
}

async function runLevel(level, targets) {
  const requestNetCalls = new Map();
  const requestNetTimeouts = new Map();
  const requestStatuses = new Map();

  requestDelegate = async function wrappedRequest(cfg, opts) {
    const reqId = als.getStore();
    try {
      const res = await originalRequest(cfg, opts);
      if (reqId !== undefined && reqId !== null) {
        requestNetCalls.set(reqId, (requestNetCalls.get(reqId) || 0) + 1);
        const st = Number(res && res.status || 0);
        if (st) {
          const row = requestStatuses.get(reqId) || { '403': 0, '429': 0, '503': 0 };
          if (st === 403) row['403'] += 1;
          if (st === 429) row['429'] += 1;
          if (st === 503) row['503'] += 1;
          requestStatuses.set(reqId, row);
        }
      }
      return res;
    } catch (err) {
      if (reqId !== undefined && reqId !== null) {
        requestNetCalls.set(reqId, (requestNetCalls.get(reqId) || 0) + 1);
        const status = Number(err && err.response && err.response.status || 0);
        const msg = String(err && err.message || '');

        const row = requestStatuses.get(reqId) || { '403': 0, '429': 0, '503': 0 };
        if (status === 403) row['403'] += 1;
        if (status === 429) row['429'] += 1;
        if (status === 503) row['503'] += 1;
        requestStatuses.set(reqId, row);

        if (TIMEOUT_RE.test(msg)) {
          requestNetTimeouts.set(reqId, (requestNetTimeouts.get(reqId) || 0) + 1);
        }
      }
      throw err;
    }
  };

  const workload = [];
  for (let i = 0; i < level; i += 1) {
    workload.push({
      reqId: i,
      ...targets[i % targets.length],
    });
  }

  const memSamples = [];
  const memTicker = setInterval(() => {
    const m = process.memoryUsage();
    memSamples.push({ rss: m.rss, heapUsed: m.heapUsed, external: m.external });
  }, 40);

  const memoryStart = process.memoryUsage();
  const cpuStart = process.cpuUsage();
  const wallStart = process.hrtime.bigint();

  const rows = await Promise.all(workload.map(async (job) => {
    const t0 = process.hrtime.bigint();
    let result;
    let error = null;

    try {
      result = await als.run(job.reqId, async () => {
        return provider.resolveEpisode({
          title: job.title,
          identifier: job.identifier,
          episode: job.episode,
        });
      });
    } catch (e) {
      error = e;
    }

    const t1 = process.hrtime.bigint();
    const responseTimeMs = Number(t1 - t0) / 1e6;

    const reason = error
      ? String(error.message || error)
      : (result && result.reason ? String(result.reason) : null);

    const success = !error && !!(result && result.episode && result.html);
    const timeout = TIMEOUT_RE.test(String(reason || ''));

    return {
      reqId: job.reqId,
      requestKey: job.key,
      title: job.title,
      identifier: job.identifier,
      episode: job.episode,
      success,
      timeout,
      reason,
      responseTimeMs: Number(responseTimeMs.toFixed(2)),
      htmlLength: result && result.html ? String(result.html).length : 0,
      pageUrl: result && result.pageUrl ? result.pageUrl : null,
      netCalls: requestNetCalls.get(job.reqId) || 0,
      netTimeouts: requestNetTimeouts.get(job.reqId) || 0,
      statuses: requestStatuses.get(job.reqId) || { '403': 0, '429': 0, '503': 0 },
    };
  }));

  clearInterval(memTicker);

  const wallEnd = process.hrtime.bigint();
  const cpuUsed = process.cpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();

  const wallMs = Number(wallEnd - wallStart) / 1e6;
  const cpuMs = (cpuUsed.user + cpuUsed.system) / 1000;

  const cpuPercentSingleCoreEquivalent = wallMs > 0
    ? Number(((cpuMs / wallMs) * 100).toFixed(2))
    : 0;

  const allRss = [memoryStart.rss, memoryEnd.rss, ...memSamples.map((s) => s.rss)];
  const allHeap = [memoryStart.heapUsed, memoryEnd.heapUsed, ...memSamples.map((s) => s.heapUsed)];

  const grouped = new Map();
  for (const row of rows) {
    const arr = grouped.get(row.requestKey) || [];
    arr.push(row);
    grouped.set(row.requestKey, arr);
  }

  let duplicateRequests = 0;
  let duplicateRequestKeys = 0;
  let raceConditionKeys = 0;
  let raceConditionEvents = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const arr of grouped.values()) {
    if (arr.length > 1) {
      duplicateRequestKeys += 1;
      duplicateRequests += (arr.length - 1);
    }

    const sigs = new Set(arr.map((r) => `${r.success}|${r.reason || ''}|${r.pageUrl || ''}|${r.htmlLength}`));
    if (sigs.size > 1) {
      raceConditionKeys += 1;
      raceConditionEvents += (sigs.size - 1);
    }

    const baseline = arr[0].netCalls;
    for (let i = 1; i < arr.length; i += 1) {
      if ((baseline === 0 && arr[i].netCalls === 0) || arr[i].netCalls < baseline) {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
      }
    }
  }

  const timeouts = rows.filter((r) => r.timeout).length;

  const statusTotals = rows.reduce((acc, row) => {
    acc['403'] += row.statuses['403'] || 0;
    acc['429'] += row.statuses['429'] || 0;
    acc['503'] += row.statuses['503'] || 0;
    return acc;
  }, { '403': 0, '429': 0, '503': 0 });

  const responseSummary = summarizeResponses(rows);

  return {
    concurrency: level,
    requestsLaunched: rows.length,
    responseTime: responseSummary,
    successCount: rows.filter((r) => r.success).length,
    failureCount: rows.filter((r) => !r.success).length,
    timeouts,
    duplicateRequests,
    duplicateRequestKeys,
    raceConditions: {
      raceConditionKeys,
      raceConditionEvents,
      detected: raceConditionKeys > 0,
    },
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
      hitRate: (cacheHits + cacheMisses) > 0 ? Number((cacheHits / (cacheHits + cacheMisses)).toFixed(4)) : null,
    },
    httpStatusEvents: statusTotals,
    network: {
      requestCallsObserved: rows.reduce((a, r) => a + r.netCalls, 0),
      requestTimeoutEvents: rows.reduce((a, r) => a + r.netTimeouts, 0),
    },
    resources: {
      cpuMs: Number(cpuMs.toFixed(2)),
      cpuPercentSingleCoreEquivalent,
      wallTimeMs: Number(wallMs.toFixed(2)),
      memory: {
        rssStart: memoryStart.rss,
        rssPeak: Math.max(...allRss),
        rssEnd: memoryEnd.rss,
        heapUsedStart: memoryStart.heapUsed,
        heapUsedPeak: Math.max(...allHeap),
        heapUsedEnd: memoryEnd.heapUsed,
      },
    },
    sample: rows.slice(0, 20),
  };
}

async function main() {
  const targets = pickTargets();
  if (!targets.length) {
    console.error('No episode targets found. Expected mirror-validation.json with episodes.');
    process.exit(1);
  }

  const levels = [];
  for (const level of CONCURRENCY_LEVELS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await runLevel(level, targets);
    levels.push(row);
  }

  requestDelegate = originalRequest;

  const total = levels.reduce((acc, row) => {
    acc.totalRequests += row.requestsLaunched;
    acc.totalTimeouts += row.timeouts;
    acc.totalDuplicateRequests += row.duplicateRequests;
    acc.totalRaceConditionKeys += row.raceConditions.raceConditionKeys;
    acc.totalCacheHits += row.cache.hits;
    acc.totalCacheMisses += row.cache.misses;
    acc.totalFailures += row.failureCount;
    acc.totalSuccess += row.successCount;
    return acc;
  }, {
    totalRequests: 0,
    totalTimeouts: 0,
    totalDuplicateRequests: 0,
    totalRaceConditionKeys: 0,
    totalCacheHits: 0,
    totalCacheMisses: 0,
    totalFailures: 0,
    totalSuccess: 0,
  });

  const out = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    plan: {
      concurrencyLevels: CONCURRENCY_LEVELS,
      targetCount: targets.length,
      targets,
      cpuCores: os.cpus().length,
      nodeVersion: process.version,
    },
    totals: {
      ...total,
      cacheHitRate: (total.totalCacheHits + total.totalCacheMisses) > 0
        ? Number((total.totalCacheHits / (total.totalCacheHits + total.totalCacheMisses)).toFixed(4))
        : null,
    },
    levels,
  };

  fs.writeFileSync('concurrency-report.json', JSON.stringify(out, null, 2));

  console.log('WROTE concurrency-report.json');
  for (const row of levels) {
    console.log(
      'LEVEL',
      row.concurrency,
      'SUCCESS', row.successCount,
      'FAIL', row.failureCount,
      'TIMEOUTS', row.timeouts,
      'CPU%', row.resources.cpuPercentSingleCoreEquivalent,
      'RSS_PEAK', row.resources.memory.rssPeak,
      'CACHE_HITS', row.cache.hits,
      'CACHE_MISSES', row.cache.misses,
      'RACE_KEYS', row.raceConditions.raceConditionKeys
    );
  }
}

main().catch((err) => {
  requestDelegate = originalRequest;
  console.error('CONCURRENCY_AUDIT_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
