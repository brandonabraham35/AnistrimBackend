const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const MAX_TITLES = 100;
const TARGET_POSITIVE = 10;

const seedChars = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789'];
const extraQueries = [
  'anime', 'movie', 'season', 'the', 'a', 'no', 'one', 'two', 'hero',
  'demon', 'dragon', 'naruto', 'bleach', 'attack', 'piece', 'hunter',
  'love', 'school', 'magic', 'war', 'zero', 'night', 'world', 'king',
  'girl', 'boy'
];

const discoveryQueries = [...new Set([...seedChars, ...extraQueries])];

function detectFormat(url) {
  const value = String(url || '').toLowerCase();
  if (/\.vtt(\?|$)/.test(value)) return 'vtt';
  if (/\.srt(\?|$)/.test(value)) return 'srt';
  if (/\.ass(\?|$)/.test(value)) return 'ass';
  if (/\.ssa(\?|$)/.test(value)) return 'ssa';
  return 'unknown';
}

function classifyZeroSubtitleCase(player, streams) {
  const html = String((player && player.html) || '');
  const lower = html.toLowerCase();
  const sources = (streams && Array.isArray(streams.sources)) ? streams.sources : [];

  const hasIframeHints = /(<iframe|<embed|<object|param\s+name=["']movie["'])/i.test(html);
  const hasDirectSubtitleHints = /(<track|subtitles?|captions?|webvtt|\.vtt|\.srt|\.ass|\.ssa|tracks\s*:|subtitles\s*:)/i.test(html);
  const hasDynamicHints = /(fetch\(|xmlhttprequest|axios\.|graphql|\/api\/|loadsubtitle|subtitleapi|captions?\?)/i.test(lower);
  const hasManifest = sources.some((s) => /\.m3u8(\?|$)|\.mpd(\?|$)/i.test(String((s && s.url) || '')));

  if (hasDirectSubtitleHints) return 'subtitles_exist_parser_miss';
  if (hasIframeHints) return 'subtitles_maybe_in_nested_iframe';
  if (hasDynamicHints || hasManifest) return 'subtitles_likely_dynamic_or_api';
  return 'genuinely_unavailable';
}

function getOffendingLine(stack) {
  const text = String(stack || '');
  const m = text.match(/services[\\/]animeHeavenProvider\.js:\d+:\d+/);
  return m ? m[0] : null;
}

async function discoverTitles() {
  const found = new Map();
  const discoveryLog = [];

  for (const q of discoveryQueries) {
    if (found.size >= MAX_TITLES * 2) break;

    try {
      const rows = await provider.searchAnime(q, 12);
      discoveryLog.push({ query: q, count: Array.isArray(rows) ? rows.length : 0 });

      for (const item of (rows || [])) {
        if (!item || !item.identifier) continue;
        if (found.has(item.identifier)) continue;

        found.set(item.identifier, {
          title: item.title || item.identifier,
          identifier: item.identifier,
          sourceQuery: q,
        });

        if (found.size >= MAX_TITLES * 2) break;
      }
    } catch (error) {
      discoveryLog.push({ query: q, error: error.message || String(error) });
    }
  }

  return {
    list: [...found.values()].slice(0, MAX_TITLES),
    discoveryLog,
    totalUnique: found.size,
  };
}

async function run() {
  const startedAt = new Date().toISOString();
  const discovery = await discoverTitles();

  const rows = [];
  let subtitlePositiveCount = 0;

  for (const anime of discovery.list) {
    const row = {
      title: anime.title,
      identifier: anime.identifier,
      subtitleCount: 0,
      subtitleLanguages: [],
      subtitleUrls: [],
      subtitleFormats: [],
      why: null,
      methodStatus: {
        resolveEpisode: 'not_run',
        extractStreams: 'not_run',
      },
      error: null,
      offendingLine: null,
    };

    try {
      const episodeResult = await provider.resolveEpisode({
        title: anime.title,
        identifier: anime.identifier,
        episode: 1,
      });

      row.methodStatus.resolveEpisode = 'pass';

      if (!episodeResult || !episodeResult.episode) {
        row.why = 'episode_1_not_resolved';
        rows.push(row);
        continue;
      }

      const playerResult = await provider.resolvePlayer({
        title: anime.title,
        identifier: anime.identifier,
        episode: 1,
      });

      const streamResult = await provider.extractStreams({
        title: anime.title,
        identifier: anime.identifier,
        episode: 1,
      });

      row.methodStatus.extractStreams = 'pass';

      const subtitles = Array.isArray(streamResult && streamResult.subtitles)
        ? streamResult.subtitles
        : [];

      row.subtitleCount = subtitles.length;
      row.subtitleLanguages = [...new Set(subtitles.map((s) => String(s.lang || s.language || 'Unknown').trim() || 'Unknown'))];
      row.subtitleUrls = [...new Set(subtitles.map((s) => s.url).filter(Boolean))];
      row.subtitleFormats = [...new Set(row.subtitleUrls.map(detectFormat))];

      if (row.subtitleCount > 0) {
        row.why = 'subtitle_found';
        subtitlePositiveCount += 1;
      } else {
        row.why = classifyZeroSubtitleCase(playerResult, streamResult);
      }
    } catch (error) {
      row.why = 'runtime_error';
      row.error = {
        message: error.message || String(error),
        stack: error.stack || null,
      };
      row.offendingLine = getOffendingLine(error.stack);
    }

    rows.push(row);

    if (subtitlePositiveCount >= TARGET_POSITIVE) {
      break;
    }
  }

  const zeroRows = rows.filter((r) => r.subtitleCount === 0);
  const positiveRows = rows.filter((r) => r.subtitleCount > 0);

  const reasonCounts = zeroRows.reduce((acc, r) => {
    const k = r.why || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const parserMissCount = reasonCounts.subtitles_exist_parser_miss || 0;
  const finalStatus = parserMissCount > 0 ? 'FAIL' : 'PASS';

  const output = {
    generatedAt: new Date().toISOString(),
    startedAt,
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      maxTitles: MAX_TITLES,
      targetPositiveTitles: TARGET_POSITIVE,
    },
    discovery: {
      queriesTried: discoveryQueries.length,
      totalUniqueFound: discovery.totalUnique,
      selectedForAudit: discovery.list.length,
      queryLog: discovery.discoveryLog,
    },
    execution: {
      testedTitles: rows.length,
      subtitlePositiveTitles: positiveRows.length,
      stoppedOnPositiveTarget: positiveRows.length >= TARGET_POSITIVE,
      exhaustedSelection: rows.length >= discovery.list.length,
    },
    determination: {
      passFail: finalStatus,
      rationale:
        finalStatus === 'PASS'
          ? 'No direct subtitle hints were found where subtitleCount was zero; subtitles appear genuinely unavailable or loaded dynamically/external to static parser scope in tested titles.'
          : 'Subtitle hints were present in HTML while subtitleCount was zero, indicating parser miss.',
      parserMissCount,
      reasonCounts,
    },
    rows,
  };

  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/subtitle-validation.json', JSON.stringify(output, null, 2));

  console.log('WROTE tmp/subtitle-validation.json');
  console.log('TESTED', rows.length, 'POSITIVE', positiveRows.length, 'STATUS', finalStatus);
}

run().catch((error) => {
  console.error('SUBTITLE_AUDIT_FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
