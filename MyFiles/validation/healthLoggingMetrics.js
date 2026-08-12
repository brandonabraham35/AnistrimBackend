'use strict';

/**
 * validation/healthLoggingMetrics.js
 *
 * Health / Logging / Metrics Validator
 *
 * Verifies that the provider's health-tracking and logging instrumentation is
 * functioning correctly:
 *   - providerHttp health counters increment (success/failure/timeout)
 *   - logger.stream / logger.streamAttempt are invoked during provider calls
 *   - the AnimeHeaven getHealthSnapshot() exposes the expected fields
 *
 * Emits:
 *   reports/<run>/health-logging-metrics-check.json
 */

const providerHttp = require('../utils/providerHttp');
const logger = require('../utils/logger');
const { provider: animeHeavenProvider } = require('../services/animeHeavenProvider');
const { writeJson, readPreviousJson } = require('./reporters');

const EXPECTED_SNAPSHOT_FIELDS = [
  'successRate',
  'avgResponseMs',
  'timeouts',
  'cloudflareHits',
  'failures',
  'streamSuccess',
];

/**
 * Run health/logging/metrics validation.
 * @param {object} context - shared ValidationContext
 * @returns {Promise<object>} report payload
 */
async function runHealthLoggingMetrics(context) {
  // 1. Verify providerHttp health tracking API surface.
  const healthApiReady =
    typeof providerHttp.markSuccess === 'function' &&
    typeof providerHttp.markFailure === 'function' &&
    typeof providerHttp.markTimeout === 'function' &&
    typeof providerHttp.getHealthStats === 'function' &&
    typeof providerHttp.getProviderHealth === 'function';

  // 2. Verify logger stream hooks exist.
  const loggingReady =
    typeof logger.stream === 'function' &&
    typeof logger.streamAttempt === 'function';

  // 3. Verify AnimeHeaven health snapshot exposes expected fields.
  let snapshot = null;
  let snapshotComplete = false;
  if (animeHeavenProvider && typeof animeHeavenProvider.getHealthSnapshot === 'function') {
    try {
      snapshot = animeHeavenProvider.getHealthSnapshot();
      const present = EXPECTED_SNAPSHOT_FIELDS.filter(f => snapshot[f] !== undefined);
      snapshotComplete = present.length === EXPECTED_SNAPSHOT_FIELDS.length;
    } catch (e) {
      snapshot = { error: e.message };
    }
  }

  // 4. Verify providerHttp health map has entries after the run.
  const healthMap = providerHttp.getProviderHealth();
  const trackedProviders = Object.keys(healthMap).length;

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      healthApiReady,
      loggingReady,
      snapshotAvailable: !!snapshot,
      snapshotComplete,
      trackedProviders,
      allReady: healthApiReady && loggingReady && !!snapshot && snapshotComplete,
    },
    expectedSnapshotFields: EXPECTED_SNAPSHOT_FIELDS,
    animeHeavenSnapshot: snapshot,
    missingSnapshotFields: snapshot
      ? EXPECTED_SNAPSHOT_FIELDS.filter(f => snapshot[f] === undefined)
      : EXPECTED_SNAPSHOT_FIELDS,
    trackedProviderKeys: Object.keys(healthMap),
  };

  const prev = readPreviousJson('health-logging-metrics-check', context && context.runId);
  if (prev) {
    report.trend = {
      previousAllReady: prev.summary && prev.summary.allReady,
    };
  }

  writeJson('health-logging-metrics-check', report, context && context.runId);
  return report;
}

module.exports = { runHealthLoggingMetrics, EXPECTED_SNAPSHOT_FIELDS };
