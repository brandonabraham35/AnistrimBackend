'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const monitor = require('../services/providerHealthMonitor');
const { provider } = require('../services/animeHeavenProvider');

['stream', 'streamAttempt', 'debugStream', 'debug', 'error', 'warn'].forEach((k) => {
  if (typeof logger[k] === 'function') logger[k] = () => {};
});

const TOTAL_REQUESTS = 100;
const REQUEST_TIMEOUT_MS = 12000;
const OUTPUT_FILE = 'provider-health-report.json';

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout:${label}:${timeoutMs}`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function loadSeedRows() {
  const file = path.join(process.cwd(), 'tmp', 'subtitle-validation.json');
  if (!fs.existsSync(file)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const out = [];
    for (const row of rows) {
      if (!row || !row.identifier) continue;
      out.push({ identifier: row.identifier, title: row.title || row.identifier });
      if (out.length >= 80) break;
    }
    return out;
  } catch {
    return [];
  }
}

function buildSearchQueries() {
  const chars = [...'abcdefghijklmnopqrstuvwxyz'];
  const words = [
    'anime', 'season', 'movie', 'love', 'hero', 'demon', 'dragon', 'school',
    'attack', 'piece', 'hunter', 'naruto', 'bleach', 'one', 'zero', 'night',
    'girl', 'boy', 'magic', 'war', 'world', 'king', 'sword', 'online', 'dead',
  ];

  const all = [...chars, ...words, ...chars.slice(0, 9)];
  return all.slice(0, 60);
}

async function run() {
  monitor.reset();
  monitor.initialize();

  const startedAt = new Date().toISOString();

  const traces = [];
  const discovered = new Map();
  const seedRows = loadSeedRows();

  const queries = buildSearchQueries();
  let requestCount = 0;

  for (const q of queries) {
    if (requestCount >= 60) break;
    const row = { kind: 'search', query: q, ok: false, error: null, resultCount: 0 };
    try {
      const results = await withTimeout(provider.searchAnime(q, 8), REQUEST_TIMEOUT_MS, `search:${q}`);
      row.resultCount = Array.isArray(results) ? results.length : 0;
      row.ok = row.resultCount > 0;
      for (const item of results || []) {
        if (!item || !item.identifier || discovered.has(item.identifier)) continue;
        discovered.set(item.identifier, { identifier: item.identifier, title: item.title || item.identifier });
      }
    } catch (error) {
      row.error = error && error.message ? error.message : String(error);
    }
    traces.push(row);
    requestCount += 1;
  }

  const detailsTargets = [];
  for (const item of discovered.values()) {
    detailsTargets.push(item);
    if (detailsTargets.length >= 20) break;
  }
  for (const seed of seedRows) {
    if (detailsTargets.length >= 20) break;
    if (detailsTargets.some((x) => x.identifier === seed.identifier)) continue;
    detailsTargets.push(seed);
  }

  for (const target of detailsTargets.slice(0, 20)) {
    const row = {
      kind: 'details',
      identifier: target.identifier,
      title: target.title,
      ok: false,
      error: null,
      hasTitle: false,
    };
    try {
      const details = await withTimeout(
        provider.getAnimeDetails(target.identifier),
        REQUEST_TIMEOUT_MS,
        `details:${target.identifier}`
      );
      row.hasTitle = !!(details && details.title);
      row.ok = !!details;
    } catch (error) {
      row.error = error && error.message ? error.message : String(error);
    }
    traces.push(row);
    requestCount += 1;
  }

  const streamTargets = [];
  for (const seed of seedRows) {
    streamTargets.push(seed);
    if (streamTargets.length >= 20) break;
  }
  for (const item of discovered.values()) {
    if (streamTargets.length >= 20) break;
    if (streamTargets.some((x) => x.identifier === item.identifier)) continue;
    streamTargets.push(item);
  }

  for (const target of streamTargets.slice(0, 20)) {
    const row = {
      kind: 'stream',
      identifier: target.identifier,
      title: target.title,
      episode: 1,
      ok: false,
      error: null,
      sourceCount: 0,
      subtitleCount: 0,
    };

    try {
      const result = await withTimeout(
        provider.extractStreams({
          title: target.title,
          identifier: target.identifier,
          episode: 1,
        }),
        REQUEST_TIMEOUT_MS,
        `stream:${target.identifier}`
      );

      const sources = Array.isArray(result && result.sources) ? result.sources : [];
      const subtitles = Array.isArray(result && result.subtitles) ? result.subtitles : [];
      row.sourceCount = sources.length;
      row.subtitleCount = subtitles.length;
      row.ok = sources.length > 0;
    } catch (error) {
      row.error = error && error.message ? error.message : String(error);
    }

    traces.push(row);
    requestCount += 1;
  }

  if (requestCount !== TOTAL_REQUESTS) {
    throw new Error(`request_count_mismatch:${requestCount}`);
  }

  const snapshot = monitor.getSnapshot();

  const output = {
    generatedAt: new Date().toISOString(),
    startedAt,
    constraints: {
      totalLiveRequests: TOTAL_REQUESTS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
    endpoint: '/health/provider',
    providerStatus: snapshot.status,
    healthSnapshot: snapshot,
    requestMix: {
      searchRequests: traces.filter((t) => t.kind === 'search').length,
      detailRequests: traces.filter((t) => t.kind === 'details').length,
      streamRequests: traces.filter((t) => t.kind === 'stream').length,
    },
    traces,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  logger.info('[ProviderMonitor] Health audit complete', {
    outputFile: OUTPUT_FILE,
    totalRequests: TOTAL_REQUESTS,
    status: snapshot.status,
    successRate: snapshot.successRate,
    failureRate: snapshot.failureRate,
  });

  console.log('WROTE', OUTPUT_FILE);
  console.log('REQUESTS', TOTAL_REQUESTS);
  console.log('STATUS', snapshot.status);
}

run().catch((error) => {
  console.error('PROVIDER_HEALTH_AUDIT_FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
