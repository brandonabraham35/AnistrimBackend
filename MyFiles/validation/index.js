'use strict';

/**
 * validation/index.js
 *
 * Nightly Validation Suite — Orchestrator
 *
 * Runs the full provider-validation pipeline:
 *   1. Harvest stream data from all providers (shared context)
 *   2. Run per-subsystem validators (streams, subtitles, metadata, search,
 *      health, cache, concurrency, failure recovery, cloudflare, mirror,
 *      health/logging/metrics)
 *   3. Aggregate into a production-readiness verdict
 *   4. Print a concise terminal summary
 *   5. Exit non-zero if critical subsystems failed
 *
 * Each validator is isolated — a failure in one does not stop the others.
 *
 * Usage:
 *   node validation/index.js                       # full run
 *   node validation/index.js --quick               # fewer probes, faster
 *   node validation/index.js --skipConcurrency     # skip the real-provider concurrency probe
 *   node validation/index.js --runId YYYY-MM-DD    # run under a specific id
 */

const { ValidationContext, DEFAULTS } = require('./context');
const { todayStamp, resolveRunDir } = require('./reporters');

// Cache validation must start before anything else so it instruments the
// cacheService across the whole run.
const cacheModule = require('./cache');
cacheModule.startCacheValidation();

const argSet = new Set(process.argv.slice(2));
const QUICK = argSet.has('--quick');
const SKIP_CONCURRENCY_REAL = argSet.has('--skipConcurrency');
const runIdArg = process.argv.find((a) => a.startsWith('--runId='));
const runId = runIdArg ? runIdArg.split('=')[1] : todayStamp();

// Reduce probe counts in quick mode.
const STREAMS_OPTIONS = QUICK ? { maxProbes: 10 } : {};
const CLOUDFLARE_OPTIONS = QUICK ? { maxUrls: 8, maxProbes: 12 } : {};
const CONCURRENCY_OPTIONS = {
  runReal: !SKIP_CONCURRENCY_REAL,
  realConcurrency: QUICK ? 3 : 5,
};

/**
 * Run a validator in isolation, printing its result and quashing errors so a
 * single failure never aborts the suite.
 */
async function runValidator(name, fn, reportName) {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`  ${name} ........ OK (${Date.now() - start}ms)`);
    return { name, ok: true, result, reportName };
  } catch (error) {
    console.error(`  ${name} ........ FAILED (${Date.now() - start}ms)`);
    console.error(`    ${error && error.message}`);
    return { name, ok: false, error: error && error.message, reportName };
  }
}

async function main() {
  const suiteStart = Date.now();
  resolveRunDir(runId); // Ensure the run directory exists up front.

  console.log('==================================================');
  console.log('  AnimeHeaven Nightly Validation Suite');
  console.log(`  Run ID: ${runId}`);
  console.log('==================================================\n');

  // ── 1. Harvest ─────────────────────────────────────────────
  console.log('Harvesting provider data...');
  const context = new ValidationContext({
    runId,
    targets: DEFAULTS.targets,
    episodesPerAnime: QUICK ? 1 : DEFAULTS.episodesPerAnime,
  });
  await context.harvest();
  console.log(`  Harvested ${context.providers.length} provider rows, ${context.streams.length} stream rows.\n`);

  // ── 2. Per-subsystem validators ────────────────────────────
  console.log('Running validators...');
  const results = [];

  results.push(await runValidator('Streams', () => require('./streams').runStreamValidation(context, STREAMS_OPTIONS), 'stream-validation'));
  results.push(await runValidator('Subtitles', () => require('./subtitles').runSubtitleValidation(context), 'subtitle-validation'));
  results.push(await runValidator('Metadata', () => require('./metadata').runMetadataValidation(context), 'metadata-completeness'));
  results.push(await runValidator('Search', () => require('./searchQuality').runSearchQuality(context, { includeConsumet: true }), 'search-quality-report'));
  results.push(await runValidator('Health', () => require('./health').runHealthValidation(context), 'provider-health-report'));
  results.push(await runValidator('Cache', () => require('./cache').runCacheValidation(context), 'cache-validation'));
  results.push(await runValidator('Concurrency', () => require('./concurrency').runConcurrencyValidation(context, CONCURRENCY_OPTIONS), 'concurrency-report'));
  results.push(await runValidator('Failure Recovery', () => require('./failureRecovery').runFailureRecovery(context), 'failure-recovery'));
  results.push(await runValidator('Cloudflare', () => require('./cloudflare').runCloudflareValidation(context, CLOUDFLARE_OPTIONS), 'cloudflare-validation'));
  results.push(await runValidator('Mirrors', () => require('./mirror').runMirrorValidation(context), 'mirror-validation'));
  results.push(await runValidator('Health/Logging/Metrics', () => require('./healthLoggingMetrics').runHealthLoggingMetrics(context), 'health-logging-metrics-check'));

  // ── 3. Prepare reports map for readiness (use written artifacts) ──
  const reports = {};
  for (const r of results) {
    if (r.ok && r.reportName) {
      try {
        reports[r.reportName] = require('./reporters').readJson(r.reportName, runId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // ── 4. Readiness aggregation ───────────────────────────────
  console.log('\nEvaluating production readiness...');
  const readiness = await require('./readiness').runReadiness(context, reports);
  const elapsedSeconds = ((Date.now() - suiteStart) / 1000).toFixed(1);

  // ── 5. Terminal summary ────────────────────────────────────
  console.log('\n==================================================');
  console.log(`  ${readiness.overallStatus}`);
  console.log(`  Production Score: ${readiness.productionScore}/100`);
  console.log('==================================================');
  for (const s of readiness.subsystems) {
    const marker = s.status === 'PASS' ? 'PASS' : s.status === 'PARTIAL' ? 'PARTIAL' : 'FAIL';
    const pad = ' '.repeat(Math.max(0, 18 - s.name.length));
    console.log(`  ${s.name}${pad} ${marker}`);
  }
  console.log('--------------------------------------------------');
  console.log(`  Run completed in ${elapsedSeconds}s`);
  console.log(`  Report: reports/${runId}/production-readiness.md`);
  console.log('==================================================\n');

  // ── 6. Exit code ───────────────────────────────────────────
  const failedCritical = readiness.failedCritical || [];
  if (failedCritical.length > 0) {
    console.error(`[VALIDATION FAIL] Critical subsystems regressed: ${failedCritical.join(', ')}`);
    process.exit(1);
  }
  if (readiness.overallStatus === 'FAIL') {
    console.error('[VALIDATION FAIL] Overall status is FAIL.');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('[VALIDATION ERROR] Unhandled failure in suite:', error);
  process.exit(2);
});
