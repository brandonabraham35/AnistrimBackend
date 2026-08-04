const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const TARGET = 200;

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

async function run() {
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

  const output = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      requestedTitles: TARGET,
      evaluatedTitles: records.length,
    },
    completeness,
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

  fs.writeFileSync('metadata-completeness.json', JSON.stringify(output, null, 2));

  console.log('WROTE metadata-completeness.json');
  console.log('EVALUATED', records.length, 'OVERALL', completeness.overallCompleteness);
  console.log('SYNOPSIS', `${completeness.percentages.synopsis}%`, 'GENRES', `${completeness.percentages.genres}%`, 'STUDIOS', `${completeness.percentages.studios}%`, 'RATING', `${completeness.percentages.rating}%`);
}

run().catch((err) => {
  console.error('METADATA_COMPLETENESS_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
