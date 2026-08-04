'use strict';

/**
 * validation/readiness.js
 *
 * Production Readiness Aggregator
 *
 * Consumes all the per-subsystem JSON artifacts produced by the suite and
 * aggregates them into a single verdict:
 *   - per-subsystem PASS / PARTIAL / FAIL
 *   - a weighted production-readiness score (0-100)
 *   - recommendations
 *   - trend comparison vs the previous run
 *
 * Emits:
 *   reports/<run>/production-readiness.md
 *   reports/<run>/production-readiness.json
 */

const { writeJson, writeMarkdown, readPreviousJson } = require('./reporters');

// Subsystem definitions: each has a name, a weight for scoring, an optional
// report to read, and a threshold function that returns { status, message }.
const SUBSYSTEMS = [
  {
    name: 'Streams',
    weight: 0.20,
    filename: 'stream-validation',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No stream report' };
      const rate = r.summary.healthyRate || 0;
      if (rate >= 90) return { status: 'PASS', message: `Healthy rate ${rate}%` };
      if (rate >= 70) return { status: 'PARTIAL', message: `Healthy rate ${rate}%` };
      return { status: 'FAIL', message: `Healthy rate ${rate}%` };
    },
  },
  {
    name: 'Search',
    weight: 0.15,
    filename: 'search-quality-report',
    evaluate: (r) => {
      if (!r || !r.perProvider) return { status: 'FAIL', message: 'No search report' };
      const ah = r.perProvider.animeheaven;
      if (!ah) return { status: 'PARTIAL', message: 'No animeheaven search data' };
      const top10 = ah.top10Recall || 0;
      if (top10 >= 95) return { status: 'PASS', message: `Top-10 recall ${top10}%` };
      if (top10 >= 80) return { status: 'PARTIAL', message: `Top-10 recall ${top10}%` };
      return { status: 'FAIL', message: `Top-10 recall ${top10}%` };
    },
  },
  {
    name: 'Metadata',
    weight: 0.10,
    filename: 'metadata-completeness',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No metadata report' };
      const comp = r.summary.overallCompleteness || 0;
      if (comp >= 90) return { status: 'PASS', message: `Completeness ${comp}%` };
      if (comp >= 70) return { status: 'PARTIAL', message: `Completeness ${comp}%` };
      return { status: 'FAIL', message: `Completeness ${comp}%` };
    },
  },
  {
    name: 'Subtitles',
    weight: 0.10,
    filename: 'subtitle-validation',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No subtitle report' };
      const rate = r.summary.coverageRate || 0;
      if (rate >= 80) return { status: 'PASS', message: `Coverage ${rate}%` };
      if (rate >= 50) return { status: 'PARTIAL', message: `Coverage ${rate}%` };
      return { status: 'FAIL', message: `Coverage ${rate}%` };
    },
  },
  {
    name: 'Mirrors',
    weight: 0.05,
    filename: 'mirror-validation',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'PARTIAL', message: 'No mirror data' };
      const hosts = r.summary.mirrorHosts || 0;
      if (hosts >= 3) return { status: 'PASS', message: `${hosts} mirror hosts detected` };
      return { status: 'PARTIAL', message: `${hosts} mirror hosts detected` };
    },
  },
  {
    name: 'Cache',
    weight: 0.10,
    filename: 'cache-validation',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No cache report' };
      const hitRatio = r.summary.hitRatio || 0;
      if (hitRatio >= 40) return { status: 'PASS', message: `Hit ratio ${hitRatio}%` };
      if (hitRatio >= 20) return { status: 'PARTIAL', message: `Hit ratio ${hitRatio}%` };
      return { status: 'FAIL', message: `Hit ratio ${hitRatio}%` };
    },
  },
  {
    name: 'Failure Recovery',
    weight: 0.10,
    filename: 'failure-recovery',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No failure report' };
      const rate = r.summary.recoveryRate || 0;
      if (rate >= 90) return { status: 'PASS', message: `Recovery rate ${rate}%` };
      if (rate >= 70) return { status: 'PARTIAL', message: `Recovery rate ${rate}%` };
      return { status: 'FAIL', message: `Recovery rate ${rate}%` };
    },
  },
  {
    name: 'Concurrency',
    weight: 0.10,
    filename: 'concurrency-report',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'FAIL', message: 'No concurrency report' };
      const realRate = r.summary.realSuccessRate || 0;
      if (realRate >= 90) return { status: 'PASS', message: `Real success rate ${realRate}%` };
      if (realRate >= 70) return { status: 'PARTIAL', message: `Real success rate ${realRate}%` };
      return { status: 'FAIL', message: `Real success rate ${realRate}%` };
    },
  },
  {
    name: 'Cloudflare',
    weight: 0.05,
    filename: 'cloudflare-validation',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'PARTIAL', message: 'No cloudflare report' };
      const rate = r.summary.cloudflareRate || 0;
      if (rate <= 10) return { status: 'PASS', message: `Cloudflare rate ${rate}%` };
      if (rate <= 30) return { status: 'PARTIAL', message: `Cloudflare rate ${rate}%` };
      return { status: 'FAIL', message: `Cloudflare rate ${rate}%` };
    },
  },
  {
    name: 'Health',
    weight: 0.05,
    filename: 'provider-health-report',
    evaluate: (r) => {
      if (!r || !r.summary) return { status: 'PARTIAL', message: 'No health report' };
      const degraded = (r.summary.degradedProviders || []).length;
      if (degraded === 0) return { status: 'PASS', message: 'No degraded providers' };
      return { status: 'PARTIAL', message: `${degraded} degraded provider(s)` };
    },
  },
];

const STATUS_SCORE = { PASS: 100, PARTIAL: 60, FAIL: 0 };

function scoreForStatus(status) {
  return STATUS_SCORE[status] !== undefined ? STATUS_SCORE[status] : 0;
}

/**
 * Read a report artifact from the run dir.
 * @param {string} filename
 * @param {string|null} runId
 */
function readArtifact(filename, runId) {
  const { readJson } = require('./reporters');
  return readJson(filename, runId);
}

/**
 * Aggregate all reports into a readiness verdict.
 * @param {object} context - shared ValidationContext
 * @param {object} reports - map of already-loaded report objects (optional)
 * @returns {Promise<object>} readiness report
 */
async function runReadiness(context, reports = {}) {
  const runId = context && context.runId;

  const subsystems = [];
  let totalScore = 0;

  for (const def of SUBSYSTEMS) {
    const data = reports[def.filename] || readArtifact(def.filename, runId);
    const evalResult = def.evaluate(data);
    const status = evalResult.status;
    const score = scoreForStatus(status);
    totalScore += score * def.weight;
    subsystems.push({
      name: def.name,
      status,
      message: evalResult.message,
      score,
      weight: def.weight,
      weightedContribution: Number((score * def.weight).toFixed(2)),
    });
  }

  const productionScore = Math.round(totalScore);

  // Overall status: FAIL if any critical subsystem (Streams, Search, Metadata,
  // Subtitles, Cache, Concurrency, Failure Recovery, Health) regressed.
  const critical = ['Streams', 'Search', 'Metadata', 'Subtitles', 'Cache', 'Concurrency', 'Failure Recovery', 'Health'];
  const failedCritical = subsystems.filter(s => s.status === 'FAIL' && critical.includes(s.name));
  const partialCount = subsystems.filter(s => s.status === 'PARTIAL').length;
  const failCount = subsystems.filter(s => s.status === 'FAIL').length;

  let overallStatus = 'PASS';
  if (failedCritical.length > 0) overallStatus = 'FAIL';
  else if (partialCount > 0) overallStatus = 'PARTIAL';

  // Recommendations from failed / partial subsystems.
  const recommendations = [];
  for (const s of subsystems.filter(s => s.status !== 'PASS')) {
    recommendations.push(`[${s.name}] ${s.message}`);
  }
  if (!recommendations.length) recommendations.push('All subsystems healthy — no action required.');

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    overallStatus,
    productionScore,
    subsystems,
    counts: { pass: subsystems.filter(s => s.status === 'PASS').length, partial: partialCount, fail: failCount },
    failedCritical: failedCritical.map(s => s.name),
    recommendations,
  };

  // Trend vs previous.
  const prev = readPreviousJson('production-readiness', runId);
  if (prev) {
    const prevSubs = {};
    for (const s of prev.subsystems || []) prevSubs[s.name] = s.status;
    report.trend = {
      previousScore: prev.productionScore ?? null,
      deltaScore: Number((productionScore - (prev.productionScore || 0)).toFixed(2)),
      previousOverallStatus: prev.overallStatus ?? null,
      resolvedFailures: (prev.subsystems || []).filter(s => s.status === 'FAIL' && (!subsystems.find(x => x.name === s.name) || subsystems.find(x => x.name === s.name).status !== 'FAIL')).map(s => s.name),
      newFailures: subsystems.filter(s => s.status === 'FAIL' && (!prevSubs[s.name] || prevSubs[s.name] === 'PASS')).map(s => s.name),
    };
    // Append trend info to report.
    report.trendSummary = {
      improvements: subsystems.filter(s => prevSubs[s.name] === 'FAIL' && s.status !== 'FAIL').map(s => s.name),
      regressions: subsystems.filter(s => prevSubs[s.name] === 'PASS' && s.status !== 'PASS').map(s => s.name),
      newFailures: subsystems.filter(s => s.status === 'FAIL' && (!prevSubs[s.name] || prevSubs[s.name] === 'PASS')).map(s => s.name),
      resolvedFailures: (prev.subsystems || []).filter(s => s.status === 'FAIL' && (!subsystems.find(x => x.name === s.name) || subsystems.find(x => x.name === s.name).status !== 'FAIL')).map(s => s.name),
    };
  }

  // Write JSON + Markdown.
  writeJson('production-readiness', report, runId);

  const md = buildMarkdown(report, context);
  writeMarkdown('production-readiness', md, runId);
  writeMarkdown('nightly-validation-report', md, runId);

  return report;
}

/**
 * Build the human-readable Markdown report.
 */
function buildMarkdown(report, context) {
  const lines = [];
  lines.push('# AnimeHeaven Nightly Validation Report');
  lines.push('');
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(`- **Run ID:** ${report.runId || 'latest'}`);
  lines.push(`- **Overall Status:** \`${report.overallStatus}\``);
  lines.push(`- **Production Score:** ${report.productionScore}/100`);
  lines.push('');

  if (report.trend) {
    lines.push('## Trend vs Previous Run');
    lines.push('');
    lines.push(`- Previous score: **${report.trend.previousScore ?? 'N/A'}** / 100 (delta **${report.trend.deltaScore ?? 0}**)`);
    lines.push(`- Previous overall status: **${report.trend.previousOverallStatus || 'N/A'}**`);
    lines.push('');
    if (report.trendSummary) {
      if (report.trendSummary.improvements.length) lines.push(`- **Improvements:** ${report.trendSummary.improvements.join(', ')}`);
      if (report.trendSummary.regressions.length) lines.push(`- **Regressions:** ${report.trendSummary.regressions.join(', ')}`);
      if (report.trendSummary.newFailures.length) lines.push(`- **New failures:** ${report.trendSummary.newFailures.join(', ')}`);
      if (report.trendSummary.resolvedFailures.length) lines.push(`- **Resolved failures:** ${report.trendSummary.resolvedFailures.join(', ')}`);
      lines.push('');
    }
  }

  lines.push('## Subsystems');
  lines.push('');
  lines.push('| Subsystem | Status | Detail | Weighted |');
  lines.push('|-----------|--------|--------|----------|');
  for (const s of report.subsystems) {
    lines.push(`| ${s.name} | ${s.status} | ${s.message} | ${s.weightedContribution} |`);
  }
  lines.push('');
  lines.push(`## Counts`);
  lines.push(`- **PASS:** ${report.counts.pass}`);
  lines.push(`- **PARTIAL:** ${report.counts.partial}`);
  lines.push(`- **FAIL:** ${report.counts.fail}`);
  lines.push('');

  lines.push('## Recommendations');
  lines.push('');
  for (const rec of report.recommendations) lines.push(`- ${rec}`);
  lines.push('');

  if (context && context.errors && context.errors.length) {
    lines.push('## Errors Encountered During Harvest');
    lines.push('');
    for (const e of context.errors.slice(0, 20)) {
      lines.push(`- ${e.provider || '?'} / ${e.method || '?'}: ${e.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { runReadiness, SUBSYSTEMS, scoreForStatus, buildMarkdown };
