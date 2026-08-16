'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const providerPath = path.resolve(__dirname, '../services/animeHeavenProvider.js');
const providerHttpPath = path.resolve(__dirname, '../utils/providerHttp.js');

const CALL_TIMEOUT_MS = 9000;
const ITERATIONS_PER_SCENARIO = 25;

const BASE_HTML = '<html><head><title>AnimeHeaven</title></head><body>ok</body></html>';
const DETAILS_HTML = [
  '<html><head><title>Fault Test Show | AnimeHeaven.Me</title></head><body>',
  '<a href="/gate.php" onclick="gatea(\'abcdefabcdefabcd\')">Episode 1</a>',
  '</body></html>',
].join('');
const GATE_WITH_PLAYER_IFRAME = '<html><body><iframe src="https://player.local/embed/ep1"></iframe></body></html>';
const PLAYER_WITH_STREAM = '<html><body><video><source src="https://cdn.local/stream-ep1-1080.mp4" label="1080p"></video></body></html>';

function createHttpError(status, message, code) {
  const err = new Error(message || `HTTP ${status}`);
  err.response = { status };
  if (code) err.code = code;
  return err;
}

function createNetworkError(code, message) {
  const err = new Error(message || code || 'network error');
  if (code) err.code = code;
  return err;
}

function okResponse(data, status = 200) {
  return { status, data, headers: {} };
}

function createScenarioRequestHandler(scenarioName) {
  return async function request(config) {
    const url = String((config && config.url) || '');

    // Base URL probe
    if (/animeheaven\.(me|ru)/i.test(url) && !/anime\.php\?|gate\.php|player\.local|cdn\.local/i.test(url)) {
      return okResponse(BASE_HTML, 200);
    }

    // Anime details page
    if (/anime\.php\?/i.test(url)) {
      if (scenarioName === 'invalid_html') {
        return okResponse('<<<INVALID_HTML_PAYLOAD>>>', 200);
      }
      return okResponse(DETAILS_HTML, 200);
    }

    // Gate page resolution
    if (/gate\.php/i.test(url)) {
      if (scenarioName === '404') throw createHttpError(404, 'Not Found');
      if (scenarioName === '500') throw createHttpError(500, 'Internal Server Error');
      if (scenarioName === 'timeout') throw createNetworkError('ECONNABORTED', 'timeout of 12000ms exceeded');
      if (scenarioName === 'dns_failure') throw createNetworkError('ENOTFOUND', 'getaddrinfo ENOTFOUND animeheaven.me');
      if (scenarioName === 'missing_iframe') return okResponse('<html><body><div id="player">No iframe present</div></body></html>', 200);
      if (scenarioName === 'broken_player') return okResponse(GATE_WITH_PLAYER_IFRAME, 200);
      if (scenarioName === 'invalid_json') {
        return okResponse('<html><body><script>window.__INITIAL_STATE__={"sources":[{"file":,]</script><div>malformed json without any stream url</div></body></html>', 200);
      }
      return okResponse(GATE_WITH_PLAYER_IFRAME, 200);
    }

    // Broken player: iframe page errors out
    if (/player\.local\/embed/i.test(url)) {
      if (scenarioName === 'broken_player') throw createHttpError(500, 'Player backend failure');
      return okResponse(PLAYER_WITH_STREAM, 200);
    }

    // Media URL (should rarely be needed in this audit)
    if (/cdn\.local\/stream/i.test(url)) {
      return okResponse('', 200);
    }

    return okResponse('<html><body>fallback</body></html>', 200);
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout_guard_${ms}ms`)), ms)),
  ]);
}

function expectedReasonsForScenario(name) {
  const map = {
    '404': ['not_found'],
    '500': ['http_failure'],
    timeout: ['timeout'],
    dns_failure: ['network'],
    invalid_html: ['episode_missing', 'invalid_html'],
    missing_iframe: ['player_missing', 'stream_missing'],
    broken_player: ['player_missing', 'stream_missing', 'http_failure'],
    invalid_json: ['player_missing', 'stream_missing', 'resolve_error'],
  };
  return map[name] || [];
}

async function runScenario(scenarioName) {
  const provider = loadProviderWithMock(createScenarioRequestHandler(scenarioName));

  const reasons = [];
  const durations = [];
  const errors = [];
  let hungCount = 0;
  let crashed = false;

  const rssSamples = [];
  const startRss = process.memoryUsage().rss;

  for (let i = 0; i < ITERATIONS_PER_SCENARIO; i += 1) {
    const t0 = Date.now();
    try {
      const out = await withTimeout(
        provider.extractStreams({ title: 'Fault Test Show', identifier: 'fault1', episode: 1 }),
        CALL_TIMEOUT_MS
      );
      durations.push(Date.now() - t0);
      reasons.push((out && out.reason) || null);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      durations.push(Date.now() - t0);
      errors.push(msg);
      if (/timeout_guard_/i.test(msg)) hungCount += 1;
      else crashed = true;
    }

    if (global.gc) global.gc();
    rssSamples.push(process.memoryUsage().rss);
  }

  const endRss = process.memoryUsage().rss;
  const peakRss = Math.max(...rssSamples, endRss, startRss);
  const deltaRss = endRss - startRss;

  const avgMs = durations.length
    ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2))
    : null;

  const expected = expectedReasonsForScenario(scenarioName);
  const nonNullReasons = reasons.filter((r) => r !== null);
  const dominantReason = nonNullReasons.length
    ? nonNullReasons.sort((a, b) => nonNullReasons.filter((x) => x === b).length - nonNullReasons.filter((x) => x === a).length)[0]
    : null;

  const reasonMatchesExpected = dominantReason ? expected.includes(dominantReason) : false;

  const noCrash = !crashed;
  const noHang = hungCount === 0;

  // Lightweight leak signal: flag only very large sustained growth.
  const memoryLeakSuspected = deltaRss > 64 * 1024 * 1024;

  return {
    scenario: scenarioName,
    injectedFailure: scenarioName,
    iterations: ITERATIONS_PER_SCENARIO,
    expectedReasons: expected,
    observedReasons: Array.from(new Set(reasons.filter(Boolean))),
    dominantReason,
    checks: {
      returnsCorrectError: reasonMatchesExpected,
      doesNotCrash: noCrash,
      doesNotHang: noHang,
      doesNotLeakMemory: !memoryLeakSuspected,
    },
    evidence: {
      avgDurationMs: avgMs,
      maxDurationMs: durations.length ? Math.max(...durations) : null,
      hungCount,
      errorSamples: errors.slice(0, 5),
      memory: {
        rssStart: startRss,
        rssEnd: endRss,
        rssPeak: peakRss,
        rssDelta: deltaRss,
      },
    },
  };
}

async function main() {
  const scenarios = [
    '404',
    '500',
    'timeout',
    'dns_failure',
    'invalid_html',
    'missing_iframe',
    'broken_player',
    'invalid_json',
  ];

  const results = [];
  for (const s of scenarios) {
    results.push(await runScenario(s));
  }

  const summary = {
    scenariosTested: results.length,
    passCount: results.filter((r) => Object.values(r.checks).every(Boolean)).length,
    failCount: results.filter((r) => !Object.values(r.checks).every(Boolean)).length,
    checkTotals: {
      returnsCorrectError: results.filter((r) => r.checks.returnsCorrectError).length,
      doesNotCrash: results.filter((r) => r.checks.doesNotCrash).length,
      doesNotHang: results.filter((r) => r.checks.doesNotHang).length,
      doesNotLeakMemory: results.filter((r) => r.checks.doesNotLeakMemory).length,
    },
    overallStatus: results.every((r) => Object.values(r.checks).every(Boolean)) ? 'PASS' : 'PARTIAL',
  };

  const output = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    method: 'fault injection via mocked utils/providerHttp.request with isolated provider reload per scenario',
    limits: {
      perCallTimeoutMs: CALL_TIMEOUT_MS,
      iterationsPerScenario: ITERATIONS_PER_SCENARIO,
    },
    summary,
    scenarios: results,
  };

  fs.writeFileSync('failure-recovery.json', JSON.stringify(output, null, 2));
  console.log('WROTE failure-recovery.json');
  console.log('OVERALL', summary.overallStatus, 'PASS', summary.passCount, 'FAIL', summary.failCount);
}

main().catch((err) => {
  console.error('FAILURE_RECOVERY_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
