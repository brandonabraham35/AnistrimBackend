'use strict';

/**
 * validation/searchQuality.js
 *
 * Search Quality Validator
 *
 * Runs a curated set of search queries against the AnimeHeaven provider (and
 * any provider exposing a searchAnime method) and measures:
 *   - top-1 accuracy (is the expected title the first result?)
 *   - top-10 recall (is the expected title within the first 10 results?)
 *   - empty-result rate
 *   - average latency
 *
 * Emits:
 *   reports/<run>/search-quality-report.json
 */

const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { SEARCH_QUERIES, SEARCH_RESULT_LIMIT } = require('./testData');
const { writeJson, readPreviousJson } = require('./reporters');

function normalizeTitle(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(expected, candidate) {
  if (!candidate) return false;
  const exp = normalizeTitle(expected);
  const cand = normalizeTitle(
    typeof candidate === 'string' ? candidate : (candidate.title || candidate.name || '')
  );
  if (!exp || !cand) return false;
  return cand === exp || cand.includes(exp) || exp.includes(cand);
}

/**
 * Run one search query against a provider.
 */
async function searchOne(provider, query, limit) {
  const start = Date.now();
  try {
    const results = await provider.searchAnime(query, limit);
    return { results: Array.isArray(results) ? results : [], latencyMs: Date.now() - start, error: null };
  } catch (error) {
    return { results: [], latencyMs: Date.now() - start, error: error && (error.message || String(error)) };
  }
}

/**
 * Run search-quality validation.
 * @param {object} context - shared ValidationContext (used for runId)
 * @param {object} options
 * @param {boolean} options.includeConsumet - also probe the consumet provider's search
 * @returns {Promise<object>} report payload
 */
async function runSearchQuality(context, options = {}) {
  const providers = [];
  const addProvider = (name, instance) => {
    if (instance && typeof instance.searchAnime === 'function') {
      providers.push({ name, instance });
    }
  };
  addProvider('animeheaven', animeHeavenProvider);
  if (options.includeConsumet) {
    let consumet;
    try {
      consumet = require('../services/consumetProvider').provider;
    } catch (e) {
      context && context._recordError && context._recordError('consumet', 'load', e);
    }
    addProvider('consumet', consumet);
  }

  const perProvider = {};
  const allQueries = [];

  for (const { name, instance } of providers) {
    perProvider[name] = {
      total: 0,
      top1Hits: 0,
      top10Hits: 0,
      empty: 0,
      errors: 0,
      latencySum: 0,
      results: [],
    };

    for (const probe of SEARCH_QUERIES) {
      const { results, latencyMs, error } = await searchOne(instance, probe.query, SEARCH_RESULT_LIMIT);
      perProvider[name].total += 1;
      perProvider[name].latencySum += latencyMs;

      let top1 = false;
      let top10 = false;
      if (error) {
        perProvider[name].errors += 1;
      } else if (results.length === 0) {
        perProvider[name].empty += 1;
      } else {
        if (titleMatches(probe.title, results[0])) top1 = true;
        if (results.slice(0, 10).some(r => titleMatches(probe.title, r))) top10 = true;
        if (top1) perProvider[name].top1Hits += 1;
        if (top10) perProvider[name].top10Hits += 1;
      }

      perProvider[name].results.push({
        query: probe.query,
        expectedTitle: probe.title,
        resultCount: error ? 0 : results.length,
        top1,
        top10,
        error,
        latencyMs,
      });
      allQueries.push({
        provider: name,
        query: probe.query,
        expectedTitle: probe.title,
        resultCount: error ? 0 : results.length,
        top1,
        top10,
        error,
        latencyMs,
      });
    }

    const total = perProvider[name].total;
    perProvider[name].top1Accuracy = total ? Number(((perProvider[name].top1Hits / total) * 100).toFixed(2)) : 0;
    perProvider[name].top10Recall = total ? Number(((perProvider[name].top10Hits / total) * 100).toFixed(2)) : 0;
    perProvider[name].emptyRate = total ? Number(((perProvider[name].empty / total) * 100).toFixed(2)) : 0;
    perProvider[name].errorRate = total ? Number(((perProvider[name].errors / total) * 100).toFixed(2)) : 0;
    perProvider[name].avgLatencyMs = total ? Number((perProvider[name].latencySum / total).toFixed(2)) : 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    queryCount: SEARCH_QUERIES.length,
    resultLimit: SEARCH_RESULT_LIMIT,
    perProvider,
    // Flattened for convenience.
    queries: allQueries,
  };

  const prev = readPreviousJson('search-quality-report', context && context.runId);
  if (prev && prev.perProvider) {
    report.trend = {};
    for (const name of Object.keys(perProvider)) {
      const pPrev = prev.perProvider[name];
      if (pPrev) {
        report.trend[name] = {
          previousTop1: pPrev.top1Accuracy ?? null,
          deltaTop1: Number((perProvider[name].top1Accuracy - (pPrev.top1Accuracy || 0)).toFixed(2)),
          previousTop10: pPrev.top10Recall ?? null,
          deltaTop10: Number((perProvider[name].top10Recall - (pPrev.top10Recall || 0)).toFixed(2)),
        };
      }
    }
  }

  writeJson('search-quality-report', report, context && context.runId);
  return report;
}

module.exports = { runSearchQuality, titleMatches, normalizeTitle };
