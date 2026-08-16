'use strict';

/**
 * validation/concurrency.js
 *
 * Concurrency / Stress Validator
 *
 * Exercises the provider's stream resolution under concurrent load to catch
 * race conditions, hangs, and resource spikes. To avoid hammering the real
 * providers (and being rate-limited), this validator runs its load against a
 * LOCAL mock HTTP server that mimics the streaming pipeline's output shape.
 *
 * It also runs a small concurrent batch against the real AnimeHeaven provider
 * (configurable, default a modest concurrency) to verify the real pipeline
 * doesn't deadlock under parallel requests.
 *
 * Emits:
 *   reports/<run>/concurrency-report.json
 */

const http = require('http');
const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { writeJson, readPreviousJson } = require('./reporters');

const CONCURRENCY_LEVELS = [5, 10, 25, 50];

function startMockServer() {
  const server = http.createServer((req, res) => {
    // Simulate a realistic streaming endpoint response.
    const delay = 20 + Math.floor(Math.random() * 60);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        streamUrl: `http://localhost:${server.address().port}/stream.m3u8`,
        sources: [
          { url: `http://localhost:${server.address().port}/media/1080p.m3u8`, quality: '1080p' },
          { url: `http://localhost:${server.address().port}/media/720p.m3u8`, quality: '720p' },
        ],
        subtitles: [
          { lang: 'English', url: `http://localhost:${server.address().port}/subs/en.vtt` },
          { lang: 'Japanese', url: `http://localhost:${server.address().port}/subs/ja.vtt` },
        ],
      }));
    }, delay);
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

async function runMockLoad(server, concurrencyLevels) {
  const baseUrl = `http://localhost:${server.address().port}`;
  const results = {};

  for (const level of concurrencyLevels) {
    const tasks = Array.from({ length: level }, (_, i) => {
      const url = `${baseUrl}/anime/virtual-episode-${i}`;
      return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(url, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (_) { /* ignore */ }
            resolve({
              ok: res.statusCode === 200 && !!parsed,
              statusCode: res.statusCode,
              latencyMs: Date.now() - start,
              hasStream: !!(parsed && parsed.streamUrl),
            });
          });
        });
        req.on('error', (e) => resolve({ ok: false, statusCode: 0, error: e.message, latencyMs: Date.now() - start }));
        req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, statusCode: 0, error: 'timeout', latencyMs: Date.now() - start }); });
      });
    });

    const outcomes = await Promise.all(tasks);
    const ok = outcomes.filter(o => o.ok).length;
    const failed = outcomes.length - ok;
    const latencies = outcomes.map(o => o.latencyMs).filter(l => l > 0);
    results[level] = {
      total: outcomes.length,
      ok,
      failed,
      successRate: outcomes.length ? Number(((ok / outcomes.length) * 100).toFixed(2)) : 0,
      avgLatencyMs: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
      errors: outcomes.filter(o => o.error).slice(0, 5).map(o => o.error),
    };
  }
  return results;
}

/**
 * Run a small real concurrent batch against AnimeHeaven.
 */
async function runRealConcurrency(targets, concurrency) {
  const batch = targets.slice(0, concurrency);
  const results = await Promise.all(batch.map(async (t) => {
    const start = Date.now();
    try {
      const res = await animeHeavenProvider.resolveStream({ title: t.title, episode: t.episode });
      return { ok: !!(res && (res.streamUrl || (Array.isArray(res.sources) && res.sources.length))), latencyMs: Date.now() - start, error: null };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: e.message };
    }
  }));
  const ok = results.filter(r => r.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    successRate: results.length ? Number(((ok / results.length) * 100).toFixed(2)) : 0,
    avgLatencyMs: results.length ? Number((results.reduce((a, b) => a + b.latencyMs, 0) / results.length).toFixed(2)) : 0,
    results,
  };
}

/**
 * Run concurrency validation.
 * @param {object} context - shared ValidationContext (for targets + runId)
 * @param {object} options
 * @param {boolean} options.runReal - also probe real AnimeHeaven (default true)
 * @param {number} options.realConcurrency - concurrent real requests (default 5)
 * @returns {Promise<object>} report payload
 */
async function runConcurrencyValidation(context, options = {}) {
  const runReal = options.runReal !== false;
  const realConcurrency = options.realConcurrency ?? 5;

  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();

  const mockServer = await startMockServer();
  const mockResults = await runMockLoad(mockServer, CONCURRENCY_LEVELS);
  mockServer.close();

  const realResults = runReal
    ? await runRealConcurrency(context.targets, realConcurrency)
    : { total: 0, ok: 0, failed: 0, successRate: 0, avgLatencyMs: 0, results: [] };

  const rssAfter = process.memoryUsage().rss;
  const cpuAfter = process.cpuUsage(cpuBefore);
  const memDeltaMb = Number(((rssAfter - rssBefore) / 1024 / 1024).toFixed(2));
  const cpuMsDelta = Number(((cpuAfter.user + cpuAfter.system) / 1000).toFixed(2));

  const report = {
    generatedAt: new Date().toISOString(),
    concurrencyLevels: CONCURRENCY_LEVELS,
    mockServer: mockResults,
    realProvider: realResults,
    resources: {
      memDeltaMb,
      cpuMsDelta,
    },
    summary: {
      mockHighestSuccessRate: Math.max(...Object.values(mockResults).map(r => r.successRate)),
      mockLowestSuccessRate: Math.min(...Object.values(mockResults).map(r => r.successRate)),
      realSuccessRate: realResults.successRate,
      realTotalRequests: realResults.total,
      memoryGrowthMb: memDeltaMb,
    },
  };

  const prev = readPreviousJson('concurrency-report', context && context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousRealSuccessRate: prev.summary.realSuccessRate ?? null,
      deltaRealSuccessRate: Number((realResults.successRate - (prev.summary.realSuccessRate || 0)).toFixed(2)),
      previousMemoryGrowthMb: prev.summary.memoryGrowthMb ?? null,
      deltaMemoryGrowthMb: Number((memDeltaMb - (prev.summary.memoryGrowthMb || 0)).toFixed(2)),
    };
  }

  writeJson('concurrency-report', report, context && context.runId);
  return report;
}

module.exports = { runConcurrencyValidation, startMockServer, runMockLoad, runRealConcurrency, CONCURRENCY_LEVELS };
