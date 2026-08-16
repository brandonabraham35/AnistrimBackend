'use strict';

/**
 * validation/cache.js
 *
 * Cache Validator
 *
 * Monkey-patches the shared cacheService during the validation run to measure
 * cache efficiency (hits, misses, sets, expiration, invalidation) and end-to-end
 * lookup latency. The patch is active only while the suite runs and is restored
 * afterwards.
 *
 * Emits:
 *   reports/<run>/cache-validation.json
 */

const cacheService = require('../utils/cacheService');
const { writeJson, readPreviousJson, todayStamp } = require('./reporters');

const metrics = {
  enabled: false,
  gets: 0,
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
  lookupMs: [],
  errors: 0,
  keysSeen: new Set(),
  hitKeys: new Set(),
  missKeys: new Set(),
};

const originalGet = cacheService.get ? cacheService.get.bind(cacheService) : null;
const originalSet = cacheService.set ? cacheService.set.bind(cacheService) : null;
const originalDelByPrefix = cacheService.delByPrefix ? cacheService.delByPrefix.bind(cacheService) : null;

let active = false;

/**
 * Activate cache instrumentation. Must be called before validators run.
 */
function startCacheValidation() {
  if (active || !originalGet || !originalSet) return;
  active = true;
  metrics.enabled = true;

  cacheService.get = async (key) => {
    metrics.gets += 1;
    const start = Date.now();
    try {
      const value = await originalGet(key);
      const latency = Date.now() - start;
      metrics.lookupMs.push(latency);
      if (value !== null && value !== undefined) {
        metrics.hits += 1;
        metrics.hitKeys.add(String(key));
      } else {
        metrics.misses += 1;
        metrics.missKeys.add(String(key));
      }
      metrics.keysSeen.add(String(key));
      return value;
    } catch (e) {
      metrics.errors += 1;
      throw e;
    }
  };

  cacheService.set = async (key, value, ttl) => {
    metrics.sets += 1;
    try {
      return await originalSet(key, value, ttl);
    } catch (e) {
      metrics.errors += 1;
      throw e;
    }
  };

  cacheService.delByPrefix = async (prefix) => {
    metrics.deletes += 1;
    try {
      return await originalDelByPrefix(prefix);
    } catch (e) {
      metrics.errors += 1;
      throw e;
    }
  };
}

/**
 * Deactivate cache instrumentation and restore original methods.
 */
function stopCacheValidation() {
  if (!active) return;
  active = false;
  metrics.enabled = false;
  if (originalGet) cacheService.get = originalGet;
  if (originalSet) cacheService.set = originalSet;
  if (originalDelByPrefix) cacheService.delByPrefix = originalDelByPrefix;
}

function avg(nums) {
  if (!nums.length) return 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Number((sum / nums.length).toFixed(2));
}

/**
 * Run cache validation summary over the gathered metrics.
 * @param {object} context - shared ValidationContext
 * @returns {Promise<object>} report payload
 */
async function runCacheValidation(context) {
  const hitRatio = metrics.gets ? Number(((metrics.hits / metrics.gets) * 100).toFixed(2)) : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    enabled: metrics.enabled,
    summary: {
      gets: metrics.gets,
      hits: metrics.hits,
      misses: metrics.misses,
      sets: metrics.sets,
      deletes: metrics.deletes,
      hitRatio,
      missRatio: metrics.gets ? Number(((metrics.misses / metrics.gets) * 100).toFixed(2)) : 0,
      avgLookupMs: avg(metrics.lookupMs),
      errors: metrics.errors,
      uniqueKeys: metrics.keysSeen.size,
    },
    // Recent lookups (trimmed) for the report.
    recentKeys: [...metrics.keysSeen].slice(-50),
  };

  const prev = readPreviousJson('cache-validation', context && context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousHitRatio: prev.summary.hitRatio ?? null,
      deltaHitRatio: Number((hitRatio - (prev.summary.hitRatio || 0)).toFixed(2)),
      previousAvgLookupMs: prev.summary.avgLookupMs ?? null,
      deltaAvgLookupMs: Number((avg(metrics.lookupMs) - (prev.summary.avgLookupMs || 0)).toFixed(2)),
    };
  }

  writeJson('cache-validation', report, context && context.runId);
  return report;
}

module.exports = { startCacheValidation, stopCacheValidation, runCacheValidation, metrics };
