const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const TARGET = 200;
const OUTPUT_FILE = 'metadata-completeness.json';
const REQUESTED_BASELINE = {
  overallCompleteness: 66.67,
  percentages: {
    studios: 0,
    rating: 0,
    status: 0,
    duration: 0,
  },
};

const queries = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  'anime', 'season', 'movie', 'love', 'hero', 'demon', 'dragon', 'school',
  'attack', 'piece', 'hunter', 'naruto', 'bleach', 'one', 'zero', 'night',
  'girl', 'boy', 'magic', 'war', 'world', 'king', 'sword', 'online', 'dead',
  'black', 'blue', 'red', 'white', 'star', 'moon', 'sun'
];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

function hasValue(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return v !== null && v !== undefined;
}

function readPreviousReport() {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function discoverTitles() {
  const found = new Map();

  for (const q of queries) {
    if (found.size >= TARGET * 2) break;

    try {
      const rows = await provider.searchAnime(q, 12);
      for (const row of rows || []) {
        if (!row || !row.identifier || !row.title) continue;
        if (found.has(row.identifier)) continue;
        found.set(row.identifier, {
          title: row.title,
          identifier: row.identifier,
        });
        if (found.size >= TARGET * 2) break;
      }
    } catch {
      // ignore discovery errors
    }
  }

  return [...found.values()].slice(0, TARGET);
}

function normalizeRecord(details, fallback) {
  const aliases = Array.isArray(details && details.aliases) ? details.aliases.filter((a) => isNonEmptyString(a)) : [];
  const genres = Array.isArray(details && details.genres) ? details.genres.filter((g) => isNonEmptyString(g)) : [];
  const studios = Array.isArray(details && details.studios) ? details.studios.filter((s) => isNonEmptyString(s)) : [];

  const episodeCountRaw = details && (details.episodeCount ?? details.totalEpisodes ?? null);
  const episodeCount = episodeCountRaw === null || episodeCountRaw === undefined || episodeCountRaw === ''
    ? null
    : Number.isFinite(Number(episodeCountRaw)) ? Number(episodeCountRaw) : String(episodeCountRaw);

  return {
    title: (details && details.title) || fallback.title || '',
    identifier: fallback.identifier,
    aliases,
    genres,
    studios,
    synopsis: (details && (details.synopsis || details.description)) || '',
    releaseYear: details && details.releaseYear ? details.releaseYear : null,
    status: details && details.status ? details.status : null,
    duration: details && details.duration ? details.duration : null,
    rating: details && details.rating ? details.rating : null,
    banner: details && details.banner ? details.banner : null,
    cover: details && (details.cover || details.image) ? (details.cover || details.image) : null,
    episodeCount,
  };
}

function computeCompleteness(records) {
  const fields = [
    'title',
    'aliases',
    'genres',
    'studios',
    'synopsis',
    'releaseYear',
    'status',
    'duration',
    'rating',
    'banner',
    'cover',
    'episodeCount',
  ];

  const counts = {};
  for (const f of fields) counts[f] = 0;

  for (const r of records) {
    if (hasValue(r.title)) counts.title += 1;
    if (isNonEmptyArray(r.aliases)) counts.aliases += 1;
    if (isNonEmptyArray(r.genres)) counts.genres += 1;
    if (isNonEmptyArray(r.studios)) counts.studios += 1;
    if (hasValue(r.synopsis)) counts.synopsis += 1;
    if (hasValue(r.releaseYear)) counts.releaseYear += 1;
    if (hasValue(r.status)) counts.status += 1;
    if (hasValue(r.duration)) counts.duration += 1;
    if (hasValue(r.rating)) counts.rating += 1;
    if (hasValue(r.banner)) counts.banner += 1;
    if (hasValue(r.cover)) counts.cover += 1;
    if (hasValue(r.episodeCount)) counts.episodeCount += 1;
  }

  const percentages = {};
  const total = Math.max(1, records.length);
  for (const f of fields) {
    percentages[f] = Number(((counts[f] / total) * 100).toFixed(2));
  }

  const overallCompleteness = Number((Object.values(percentages).reduce((a, b) => a + b, 0) / fields.length).toFixed(2));

  return { counts, percentages, overallCompleteness, totalTitles: records.length };
}

function computeBeforeAfterFromBaseline(currentCompleteness, totalTitles) {
  const previousPercentages = REQUESTED_BASELINE.percentages || {};
  const currentCounts = currentCompleteness.counts || {};
  const currentPercentages = currentCompleteness.percentages || {};

  const fields = ['studios', 'rating', 'status', 'duration'];
  const deltas = {};
  for (const field of fields) {
    const beforePct = Number(previousPercentages[field] || 0);
    const beforeCount = Math.round((beforePct / 100) * Math.max(1, totalTitles));
    const afterCount = Number(currentCounts[field] || 0);
    const afterPct = Number(currentPercentages[field] || 0);
    deltas[field] = {
      before: { count: beforeCount, percentage: beforePct },
      after: { count: afterCount, percentage: afterPct },
      deltaCount: afterCount - beforeCount,
      deltaPercentage: Number((afterPct - beforePct).toFixed(2)),
    };
  }

  const overallBefore = Number(REQUESTED_BASELINE.overallCompleteness || 0);
  const overallAfter = Number(currentCompleteness.overallCompleteness || 0);

  return {
    baseline: 'requested_validation_baseline',
    overall: {
      before: overallBefore,
      after: overallAfter,
      delta: Number((overallAfter - overallBefore).toFixed(2)),
    },
    fields: deltas,
  };
}

function computeComparisonFromPreviousReport(previousReport, currentCompleteness) {
  const previous = previousReport && previousReport.completeness ? previousReport.completeness : null;
  if (!previous) return null;
  const previousCounts = previous.counts || {};
  const previousPercentages = previous.percentages || {};
  const currentCounts = currentCompleteness.counts || {};
  const currentPercentages = currentCompleteness.percentages || {};

  const fields = ['studios', 'rating', 'status', 'duration'];
  const deltas = {};
  for (const field of fields) {
    const beforeCount = Number(previousCounts[field] || 0);
    const beforePct = Number(previousPercentages[field] || 0);
    const afterCount = Number(currentCounts[field] || 0);
    const afterPct = Number(currentPercentages[field] || 0);
    deltas[field] = {
      before: { count: beforeCount, percentage: beforePct },
      after: { count: afterCount, percentage: afterPct },
      deltaCount: afterCount - beforeCount,
      deltaPercentage: Number((afterPct - beforePct).toFixed(2)),
    };
  }

  const overallBefore = Number(previous.overallCompleteness || 0);
  const overallAfter = Number(currentCompleteness.overallCompleteness || 0);

  return {
    overall: {
      before: overallBefore,
      after: overallAfter,
      delta: Number((overallAfter - overallBefore).toFixed(2)),
    },
    fields: deltas,
  };
}

function buildNewlyExtractedExamples(previousReport, currentRecords) {
  const previousRecords = new Map();
  const previousList = Array.isArray(previousReport && previousReport.records) ? previousReport.records : [];
  for (const item of previousList) {
    if (!item || !item.identifier) continue;
    previousRecords.set(item.identifier, item);
  }

  const fields = ['studios', 'rating', 'status', 'duration'];
  const examples = {
    studios: [],
    rating: [],
    status: [],
    duration: [],
  };

  const hasPrevious = previousRecords.size > 0;

  for (const record of currentRecords) {
    if (!record || !record.identifier) continue;
    const before = previousRecords.get(record.identifier) || {};

    for (const field of fields) {
      if (examples[field].length >= 8) continue;
      const beforeHas = hasPrevious ? hasValue(before[field]) : false;
      const afterHas = hasValue(record[field]);
      if (beforeHas || !afterHas) continue;

      examples[field].push({
        identifier: record.identifier,
        title: record.title,
        value: record[field],
      });
    }
  }

  return examples;
}

function buildBaselineExtractedExamples(currentRecords) {
  const fields = ['studios', 'rating', 'status', 'duration'];
  const examples = {
    studios: [],
    rating: [],
    status: [],
    duration: [],
  };

  for (const record of currentRecords) {
    if (!record || !record.identifier) continue;
    for (const field of fields) {
      if (examples[field].length >= 8) continue;
      if (!hasValue(record[field])) continue;
      examples[field].push({
        identifier: record.identifier,
        title: record.title,
        value: record[field],
      });
    }
  }

  return examples;
}

async function run() {
  const previousReport = readPreviousReport();
  const discovered = await discoverTitles();
  if (discovered.length < TARGET) {
    throw new Error(`insufficient_discovered_titles:${discovered.length}`);
  }

  const records = [];
  const errors = [];

  for (const item of discovered) {
    try {
      const details = await provider.getAnimeDetails(item.identifier);
      records.push(normalizeRecord(details, item));
    } catch (err) {
      records.push(normalizeRecord(null, item));
      errors.push({ identifier: item.identifier, title: item.title, error: err.message || String(err) });
    }
  }

  const completeness = computeCompleteness(records);
  const beforeVsAfter = computeBeforeAfterFromBaseline(completeness, records.length);
  const previousRunComparison = computeComparisonFromPreviousReport(previousReport, completeness);
  const newlyExtractedExamples = buildNewlyExtractedExamples(previousReport, records);
  const baselineExtractedExamples = buildBaselineExtractedExamples(records);

  const output = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      requestedTitles: TARGET,
      evaluatedTitles: records.length,
    },
    completeness,
    beforeVsAfter,
    previousRunComparison,
    perFieldStatistics: {
      studios: {
        count: completeness.counts.studios,
        percentage: completeness.percentages.studios,
      },
      rating: {
        count: completeness.counts.rating,
        percentage: completeness.percentages.rating,
      },
      status: {
        count: completeness.counts.status,
        percentage: completeness.percentages.status,
      },
      duration: {
        count: completeness.counts.duration,
        percentage: completeness.percentages.duration,
      },
    },
    newlyExtractedExamples,
    baselineExtractedExamples,
    fieldExamples: {
      synopsis: `${completeness.percentages.synopsis}%`,
      genres: `${completeness.percentages.genres}%`,
      studios: `${completeness.percentages.studios}%`,
      rating: `${completeness.percentages.rating}%`,
      aliases: `${completeness.percentages.aliases}%`,
      duration: `${completeness.percentages.duration}%`,
      status: `${completeness.percentages.status}%`,
      releaseYear: `${completeness.percentages.releaseYear}%`,
      banner: `${completeness.percentages.banner}%`,
      cover: `${completeness.percentages.cover}%`,
      episodeCount: `${completeness.percentages.episodeCount}%`,
    },
    errors,
    records,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('WROTE', OUTPUT_FILE);
  console.log('EVALUATED', records.length, 'OVERALL', completeness.overallCompleteness);
  console.log('SYNOPSIS', `${completeness.percentages.synopsis}%`, 'GENRES', `${completeness.percentages.genres}%`, 'STUDIOS', `${completeness.percentages.studios}%`, 'RATING', `${completeness.percentages.rating}%`);
}

run().catch((err) => {
  console.error('METADATA_COMPLETENESS_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
