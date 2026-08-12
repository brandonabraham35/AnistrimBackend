'use strict';

/**
 * validation/health.js
 *
 * Provider Health Validator
 *
 * Reads the health tracked by utils/providerHttp (getProviderHealth /
 * getHealthStats) plus the AnimeHeaven provider's own health snapshot
 * (getHealthSnapshot) and normalizes them into a single health report.
 *
 * Emits:
 *   reports/<run>/provider-health-report.json
 */

const providerHttp = require('../utils/providerHttp');
const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { writeJson, readPreviousJson } = require('./reporters');

function parseMs(text) {
  const raw = String(text || '');
  const m = raw.match(/(\d+(?:\.\d+)?)\s*ms/i);
  return m ? Number(m[1]) : null;
}

function parsePct(text) {
  const raw = String(text || '');
  const m = raw.match(/(\d+(?:\.\d+)?)\s*%/i) || raw.match(/^(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
}

function normalizeHealthMap(map) {
  const out = [];
  for (const [key, value] of Object.entries(map || {})) {
    const avgMs = parseMs(value.avgResponseTime);
    const successRate = parsePct(value.successRate);
    const uptime = value.uptimePercentage !== undefined && value.uptimePercentage !== null
      ? Number(value.uptimePercentage)
      : null;
    out.push({
      provider: key,
      totalRequests: value.totalRequests || 0,
      successCount: value.successCount || 0,
      failureCount: value.failureCount || 0,
      consecutiveFailures: value.consecutiveFailures || 0,
      avgResponseMs: avgMs,
      successRate,
      uptimePercentage: uptime,
      degraded: !!value.degraded,
      lastSuccessfulRequest: value.lastSuccessfulRequest || null,
      lastFailure: value.lastFailure || null,
    });
  }
  return out;
}

/**
 * Run health validation.
 * @param {object} context - shared ValidationContext
 * @returns {Promise<object>} report payload
 */
async function runHealthValidation(context) {
  const providerHealth = providerHttp.getProviderHealth();
  const normalized = normalizeHealthMap(providerHealth);

  // AnimeHeaven has an additional provider-level snapshot.
  let animeHeavenSnapshot = null;
  if (animeHeavenProvider && typeof animeHeavenProvider.getHealthSnapshot === 'function') {
    try {
      animeHeavenSnapshot = animeHeavenProvider.getHealthSnapshot();
    } catch (e) {
      animeHeavenSnapshot = { error: e.message };
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    providerHttp: normalized,
    animeHeavenSnapshot,
    summary: {
      trackedProviders: normalized.length,
      degradedProviders: normalized.filter(p => p.degraded).map(p => p.provider),
      zeroRequestProviders: normalized.filter(p => p.totalRequests === 0).map(p => p.provider),
    },
  };

  const prev = readPreviousJson('provider-health-report', context && context.runId);
  if (prev) {
    report.trend = {
      previousTrackedProviders: prev.summary && prev.summary.trackedProviders,
      previousDegradedProviders: prev.summary && prev.summary.degradedProviders,
    };
  }

  writeJson('provider-health-report', report, context && context.runId);
  return report;
}

module.exports = { runHealthValidation, normalizeHealthMap, parseMs, parsePct };
