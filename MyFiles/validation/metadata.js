'use strict';

/**
 * validation/metadata.js
 *
 * Metadata Completeness Validator
 *
 * Analyzes how complete the metadata is for each harvested anime. Since the
 * lightweight harvest captures stream-level data, this validator focuses on
 * the fields we can reliably derive and also lets callers pass richer
 * metadata via context.metadata (which may be populated by a dedicated
 * details pass in the future).
 *
 * Emits:
 *   reports/<run>/metadata-completeness.json
 */

const { writeJson, readPreviousJson } = require('./reporters');

// Fields we consider "core" for production-readiness.
const CORE_FIELDS = [
  'title',
  'hasStream',
  'hasSubtitles',
  'sourceCount',
];

// Optional fields that are nice-to-have but not required for readiness.
const OPTIONAL_FIELDS = [
  'description',
  'synopsis',
  'genres',
  'studios',
  'cover',
  'banner',
  'releaseYear',
  'status',
  'rating',
  'duration',
  'episodeCount',
];

/**
 * Compute completeness for a single metadata row.
 * Returns { score, missing, present, weighted }.
 */
function completenessOf(row) {
  const present = [];
  const missing = [];

  for (const field of CORE_FIELDS) {
    const presentVal = row[field] !== undefined && row[field] !== null && row[field] !== '' && row[field] !== 0;
    if (presentVal) present.push(field);
    else missing.push(field);
  }

  // Optional fields only count as "present" if actually populated.
  for (const field of OPTIONAL_FIELDS) {
    const val = row[field];
    const presentVal = Array.isArray(val) ? val.length > 0 : (val !== undefined && val !== null && val !== '');
    // Only count optional fields; they're not required for the core score.
    if (presentVal) present.push(field);
  }

  const coreScore = CORE_FIELDS.length
    ? Number(((present.filter(f => CORE_FIELDS.includes(f)).length / CORE_FIELDS.length) * 100).toFixed(2))
    : 0;

  return { coreScore, corePresent: present, coreMissing: missing };
}

/**
 * Run metadata completeness validation.
 * @param {object} context - shared ValidationContext
 * @returns {Promise<object>} report payload
 */
async function runMetadataValidation(context) {
  const rows = context.metadata && context.metadata.length
    ? context.metadata
    : context.streams.map(s => ({
        provider: s.provider,
        title: s.title,
        episode: s.episode,
        ok: s.ok,
        hasStream: Boolean(s.stream && (s.stream.streamUrl || (Array.isArray(s.stream.sources) && s.stream.sources.length))),
        hasSubtitles: Array.isArray(s.stream && s.stream.subtitles) && s.stream.subtitles.length > 0,
        sourceCount: Array.isArray(s.stream && s.stream.sources) ? s.stream.sources.length : 0,
      }));

  const analyzed = rows.map(row => {
    const comp = completenessOf(row);
    return {
      provider: row.provider,
      title: row.title,
      episode: row.episode || null,
      coreScore: comp.coreScore,
      present: comp.corePresent,
      missing: comp.coreMissing,
      sourceCount: row.sourceCount || 0,
      hasStream: !!row.hasStream,
      hasSubtitles: !!row.hasSubtitles,
    };
  });

  const perProvider = {};
  for (const row of analyzed) {
    const key = row.provider || 'unknown';
    perProvider[key] = perProvider[key] || { rows: 0, scoreSum: 0, missing: new Set() };
    perProvider[key].rows += 1;
    perProvider[key].scoreSum += Number(row.coreScore || 0);
    for (const m of row.missing) perProvider[key].missing.add(m);
  }

  const perProviderSummary = {};
  for (const key of Object.keys(perProvider)) {
    const p = perProvider[key];
    perProviderSummary[key] = {
      rows: p.rows,
      avgCompleteness: p.rows ? Number((p.scoreSum / p.rows).toFixed(2)) : 0,
      missingFields: [...p.missing],
    };
  }

  const overallScore = analyzed.length
    ? Number((analyzed.reduce((a, b) => a + Number(b.coreScore || 0), 0) / analyzed.length).toFixed(2))
    : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalTitles: analyzed.length,
      overallCompleteness: overallScore,
      // Count rows that are missing the most critical field (stream).
      missingStream: analyzed.filter(r => !r.hasStream).length,
      missingSubtitles: analyzed.filter(r => !r.hasSubtitles).length,
    },
    coreFields: CORE_FIELDS,
    optionalFields: OPTIONAL_FIELDS,
    perProvider: perProviderSummary,
    rows: analyzed,
  };

  const prev = readPreviousJson('metadata-completeness', context.runId);
  if (prev && prev.summary) {
    report.trend = {
      previousOverall: prev.summary.overallCompleteness ?? null,
      deltaOverall: Number((overallScore - (prev.summary.overallCompleteness || 0)).toFixed(2)),
    };
  }

  writeJson('metadata-completeness', report, context.runId);
  return report;
}

module.exports = { runMetadataValidation, completenessOf, CORE_FIELDS, OPTIONAL_FIELDS };
