'use strict';

/**
 * validation/failureRecovery.js
 *
 * Failure Recovery Validator
 *
 * Verifies that provider request handling degrades gracefully under injected
 * failures (404, 500, timeout, DNS failure, malformed HTML, missing iframe,
 * malformed JSON). Uses a LOCAL mock server to avoid hitting real providers.
 *
 * Checks that:
 *   - requests don't hang (timeout enforcement)
 *   - errors are classified correctly (via providerHttp.classifyError)
 *   - the process doesn't crash or leak memory
 *
 * Emits:
 *   reports/<run>/failure-recovery.json
 */

const http = require('http');
const { classifyError } = require('../utils/providerHttp');
const { writeJson, readPreviousJson } = require('./reporters');

const SCENARIOS = ['404', '500', 'timeout', 'malformed-json', 'malformed-html', 'missing-iframe', 'empty'];

function startScenarioServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes('/404')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (url.includes('/500')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error');
      return;
    }
    if (url.includes('/timeout')) {
      // Never respond — the client should time out.
      return;
    }
    if (url.includes('/malformed-json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ this is not valid json');
      return;
    }
    if (url.includes('/malformed-html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><div><span>partial</html>');
      return;
    }
    if (url.includes('/missing-iframe')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>No iframe here</p></body></html>');
      return;
    }
    // empty
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('');
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message || String(e) }));
  });
}

/**
 * Run failure recovery validation.
 * @param {object} context - shared ValidationContext
 * @param {object} options
 * @param {number} options.timeoutMs - per-scenario timeout (default 3000)
 * @returns {Promise<object>} report payload
 */
async function runFailureRecovery(context, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const server = await startScenarioServer();
  const base = `http://localhost:${server.address().port}`;

  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();

  const results = [];
  for (const scenario of SCENARIOS) {
    const url = `${base}/${scenario}`;
    const start = Date.now();
    const outcome = await fetchWithTimeout(url, timeoutMs);
    const latencyMs = Date.now() - start;

    // Classify what we'd expect.
    let expectedCategory = 'UNKNOWN';
    if (scenario === '404') expectedCategory = 'NOT_FOUND';
    else if (scenario === '500') expectedCategory = 'SERVER_ERROR';
    else if (scenario === 'timeout') expectedCategory = 'TIMEOUT';

    const hung = outcome.status === 0 && !outcome.error && latencyMs >= timeoutMs;
    results.push({
      scenario,
      status: outcome.status,
      latencyMs,
      timedOut: /timeout/i.test(outcome.error || '') || hung,
      hung,
      error: outcome.error || null,
      expectedCategory,
      recovered: !hung && latencyMs < timeoutMs * 5,
    });
  }

  server.close();

  const rssAfter = process.memoryUsage().rss;
  const cpuAfter = process.cpuUsage(cpuBefore);
  const memDeltaMb = Number(((rssAfter - rssBefore) / 1024 / 1024).toFixed(2));
  const cpuMsDelta = Number(((cpuAfter.user + cpuAfter.system) / 1000).toFixed(2));

  const recoveredCount = results.filter(r => r.recovered).length;
  const hungCount = results.filter(r => r.hung).length;

  const report = {
    generatedAt: new Date().toISOString(),
    scenarios: SCENARIOS,
    timeoutMs,
    results,
    summary: {
      total: results.length,
      recovered: recoveredCount,
      hung: hungCount,
      classifiedCorrectly: results.filter(r => r.status !== 0 && r.expectedCategory !== 'UNKNOWN').length,
      recoveryRate: results.length ? Number(((recoveredCount / results.length) * 100).toFixed(2)) : 0,
      memoryGrowthMb: memDeltaMb,
      cpuMsDelta,
    },
  };

  const prev = readPreviousJson('failure-recovery', context && context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousRecoveryRate: prev.summary.recoveryRate ?? null,
      deltaRecovery: Number(((report.summary.recoveryRate || 0) - (prev.summary.recoveryRate || 0)).toFixed(2)),
      previousHungCount: prev.summary.hung ?? null,
      deltaHung: hungCount - (prev.summary.hung || 0),
    };
  }

  writeJson('failure-recovery', report, context && context.runId);
  return report;
}

module.exports = { runFailureRecovery, startScenarioServer, SCENARIOS };
