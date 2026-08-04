const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const TARGET_TITLES = 200;
const RESULT_LIMIT = 10;
const OUTPUT_FILE = 'search-quality-report.json';
const REQUEST_TIMEOUT_MS = 20000;

const seeds = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  'anime', 'season', 'movie', 'love', 'hero', 'demon', 'dragon', 'school',
  'attack', 'piece', 'hunter', 'naruto', 'bleach', 'one', 'zero', 'night',
  'girl', 'boy', 'magic', 'war', 'world', 'king', 'sword', 'online', 'dead',
];

const titleMappings = [
  { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin', japanese: '進撃の巨人', aliases: ['AOT'] },
  { english: 'Demon Slayer: Kimetsu no Yaiba', romaji: 'Kimetsu no Yaiba', japanese: '鬼滅の刃', aliases: ['Demon Slayer'] },
  { english: 'Jujutsu Kaisen', romaji: 'Jujutsu Kaisen', japanese: '呪術廻戦', aliases: ['Sorcery Fight'] },
  { english: 'My Hero Academia', romaji: 'Boku no Hero Academia', japanese: '僕のヒーローアカデミア', aliases: ['MHA'] },
  { english: 'One Piece', romaji: 'Wan Pisu', japanese: 'ワンピース', aliases: ['OP'] },
  { english: 'Naruto', romaji: 'Naruto', japanese: 'ナルト', aliases: ['Naruto Shippuden'] },
  { english: 'Bleach', romaji: 'Bleach', japanese: 'ブリーチ', aliases: [] },
  { english: 'Death Note', romaji: 'Desu Noto', japanese: 'デスノート', aliases: [] },
  { english: 'Fullmetal Alchemist: Brotherhood', romaji: 'Hagane no Renkinjutsushi', japanese: '鋼の錬金術師', aliases: ['FMA Brotherhood'] },
  { english: 'Tokyo Ghoul', romaji: 'Tokyo Ghoul', japanese: '東京喰種', aliases: [] },
  { english: 'Hunter x Hunter', romaji: 'Hunter x Hunter', japanese: 'ハンター×ハンター', aliases: ['HxH'] },
  { english: 'Sword Art Online', romaji: 'Sword Art Online', japanese: 'ソードアート・オンライン', aliases: ['SAO'] },
  { english: 'Steins;Gate', romaji: 'Steins Gate', japanese: 'シュタインズ・ゲート', aliases: [] },
  { english: 'Re:ZERO -Starting Life in Another World-', romaji: 'Re Zero kara Hajimeru Isekai Seikatsu', japanese: 'Re:ゼロから始める異世界生活', aliases: ['Re:Zero'] },
  { english: 'Kaguya-sama: Love is War', romaji: 'Kaguya-sama wa Kokurasetai', japanese: 'かぐや様は告らせたい', aliases: ['Love is War'] },
  { english: 'Your Lie in April', romaji: 'Shigatsu wa Kimi no Uso', japanese: '四月は君の嘘', aliases: [] },
  { english: 'The Rising of the Shield Hero', romaji: 'Tate no Yuusha no Nariagari', japanese: '盾の勇者の成り上がり', aliases: ['Shield Hero'] },
  { english: 'That Time I Got Reincarnated as a Slime', romaji: 'Tensei shitara Slime Datta Ken', japanese: '転生したらスライムだった件', aliases: ['Slime Isekai'] },
  { english: 'The Seven Deadly Sins', romaji: 'Nanatsu no Taizai', japanese: '七つの大罪', aliases: [] },
  { english: 'The Apothecary Diaries', romaji: 'Kusuriya no Hitorigoto', japanese: '薬屋のひとりごと', aliases: [] },
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = normalize(a);
  const t = normalize(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const dp = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) dp[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const temp = dp[j];
      if (s[i - 1] === t[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
  }

  return dp[t.length];
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const d = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  return Math.max(0, 1 - (d / maxLen));
}

function titleMatches(expected, actual) {
  const e = normalize(expected);
  const a = normalize(actual);
  if (!e || !a) return false;
  if (e === a) return true;
  if (a.includes(e) || e.includes(a)) return true;
  return similarity(e, a) >= 0.9;
}

function mutateMisspelling(input) {
  const raw = String(input || '').trim();
  if (!raw) return raw;

  const letters = raw.split('');
  if (letters.length < 5) return `${raw}a`;

  const mid = Math.floor(letters.length / 2);
  if (letters[mid] !== ' ') {
    letters.splice(mid, 1);
    return letters.join('');
  }

  if (mid + 1 < letters.length) {
    const tmp = letters[mid];
    letters[mid] = letters[mid + 1];
    letters[mid + 1] = tmp;
    return letters.join('');
  }

  return raw;
}

function makePartial(input) {
  const words = String(input || '').split(/\s+/).filter(Boolean);
  if (!words.length) return String(input || '');
  if (words.length === 1) return words[0].slice(0, Math.max(3, Math.floor(words[0].length / 2)));
  return words.slice(0, 2).join(' ');
}

function readPreviousReport() {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function buildPreviousComparison(previous, summary) {
  if (!previous || !previous.summary) return null;
  const prev = previous.summary;
  return {
    previousGeneratedAt: previous.generatedAt || null,
    deltas: {
      avgScore: Number((summary.avgScore - Number(prev.avgScore || 0)).toFixed(4)),
      top1Accuracy: Number((summary.top1Accuracy - Number(prev.top1Rate || prev.top1Accuracy || 0)).toFixed(4)),
      top10Recall: Number((summary.top10Recall - Number(prev.top10Recall || 0)).toFixed(4)),
      falsePositives: Number((summary.falsePositives - Number(prev.falsePositiveMentions || prev.falsePositives || 0)).toFixed(0)),
      falseNegatives: Number((summary.falseNegatives - Number(prev.falseNegativeQueries || prev.falseNegatives || 0)).toFixed(0)),
    },
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function discoverTitles() {
  const found = new Map();

  for (const q of seeds) {
    if (found.size >= 260) break;

    try {
      const rows = await withTimeout(provider.searchAnime(q, 12), REQUEST_TIMEOUT_MS, `discover:${q}`);
      for (const row of rows || []) {
        if (!row || !row.identifier || !row.title) continue;
        if (found.has(row.identifier)) continue;
        found.set(row.identifier, {
          identifier: row.identifier,
          title: row.title,
          url: row.url || null,
        });
        if (found.size >= 260) break;
      }
    } catch {
      // ignore discovery errors
    }
  }

  for (const mapped of titleMappings) {
    try {
      const rows = await withTimeout(provider.searchAnime(mapped.english, 8), REQUEST_TIMEOUT_MS, `mapping:${mapped.english}`);
      const match = (rows || []).find((r) => titleMatches(mapped.english, r.title));
      if (match && match.identifier && !found.has(match.identifier)) {
        found.set(match.identifier, {
          identifier: match.identifier,
          title: match.title,
          url: match.url || null,
        });
      }
    } catch {
      // ignore
    }
  }

  return [...found.values()].slice(0, TARGET_TITLES);
}

async function buildAliasMap(titles) {
  const aliasMap = new Map();
  const sample = titles.slice(0, 80);

  for (const t of sample) {
    try {
      const details = await withTimeout(provider.getAnimeDetails(t.identifier), REQUEST_TIMEOUT_MS, `details:${t.identifier}`);
      const aliases = Array.isArray(details && details.aliases) ? details.aliases : [];
      const useful = aliases.filter((a) => a && normalize(a) && normalize(a) !== normalize(t.title));
      if (useful.length) aliasMap.set(t.identifier, useful[0]);
    } catch {
      // ignore
    }
  }

  return aliasMap;
}

function mappingForTitle(title) {
  const n = normalize(title);
  return titleMappings.find((m) => titleMatches(m.english, n) || titleMatches(n, m.english));
}

function buildQueryCases(titles, aliasMap) {
  const quotas = {
    english: 40,
    misspelling: 40,
    alias: 20,
    japanese: 5,
    romaji: 5,
    partial: 90,
  };

  const remaining = new Map(titles.map((t) => [t.identifier, t]));
  const out = [];

  function addCase(t, type, query) {
    out.push({
      type,
      query,
      expectedTitle: t.title,
      expectedIdentifier: t.identifier,
    });
    remaining.delete(t.identifier);
  }

  function take(type, count, predicate, queryFactory) {
    let taken = 0;
    for (const t of titles) {
      if (taken >= count) break;
      if (!remaining.has(t.identifier)) continue;
      if (!predicate(t)) continue;
      addCase(t, type, queryFactory(t));
      taken += 1;
    }
    return taken;
  }

  take(
    'japanese',
    quotas.japanese,
    (t) => {
      const map = mappingForTitle(t.title);
      return !!(map && map.japanese);
    },
    (t) => {
      const map = mappingForTitle(t.title);
      return map.japanese;
    }
  );

  take(
    'romaji',
    quotas.romaji,
    (t) => {
      const map = mappingForTitle(t.title);
      return !!(map && map.romaji);
    },
    (t) => {
      const map = mappingForTitle(t.title);
      return map.romaji;
    }
  );

  take(
    'alias',
    quotas.alias,
    (t) => {
      const map = mappingForTitle(t.title);
      return !!(
        aliasMap.has(t.identifier)
        || (map && Array.isArray(map.aliases) && map.aliases.length)
      );
    },
    (t) => {
      const map = mappingForTitle(t.title);
      return aliasMap.get(t.identifier)
        || (map && map.aliases && map.aliases[0])
        || makePartial(t.title);
    }
  );

  take('misspelling', quotas.misspelling, () => true, (t) => mutateMisspelling(t.title));
  take('english', quotas.english, () => true, (t) => t.title);
  take('partial', quotas.partial, () => true, (t) => makePartial(t.title));

  for (const t of remaining.values()) {
    if (out.length >= TARGET_TITLES) break;
    addCase(t, 'partial', makePartial(t.title));
  }

  return out.slice(0, TARGET_TITLES);
}

async function evaluateCase(c) {
  const started = Date.now();
  let rows = [];
  let error = null;

  try {
    rows = await withTimeout(provider.searchAnime(c.query, RESULT_LIMIT), REQUEST_TIMEOUT_MS, `evaluate:${c.query}`);
  } catch (e) {
    error = e.message || String(e);
    rows = [];
  }

  const results = Array.isArray(rows) ? rows : [];
  const returnedTitle = results[0] ? results[0].title : null;

  let rankingPosition = null;
  for (let i = 0; i < results.length; i += 1) {
    if (titleMatches(c.expectedTitle, results[i].title)) {
      rankingPosition = i + 1;
      break;
    }
  }

  const topSimilarity = similarity(returnedTitle || '', c.expectedTitle || '');
  const rankBonus = rankingPosition ? (1 - ((rankingPosition - 1) / RESULT_LIMIT)) : 0;
  const score = Number(((topSimilarity * 0.7) + (rankBonus * 0.3)).toFixed(4));

  const falsePositives = results
    .filter((r) => !titleMatches(c.expectedTitle, r.title))
    .map((r) => r.title)
    .slice(0, RESULT_LIMIT);

  const falseNegatives = rankingPosition ? [] : [c.expectedTitle];

  return {
    query: c.query,
    queryType: c.type,
    expectedTitle: c.expectedTitle,
    expectedIdentifier: c.expectedIdentifier,
    returnedTitle,
    score,
    rankingPosition,
    falsePositives,
    falseNegatives,
    resultCount: results.length,
    latencyMs: Date.now() - started,
    error,
  };
}

async function run() {
  const previousReport = readPreviousReport();
  const discovered = await discoverTitles();
  if (discovered.length < TARGET_TITLES) {
    throw new Error(`discovered_titles_insufficient:${discovered.length}`);
  }

  const aliasMap = await buildAliasMap(discovered);
  const cases = buildQueryCases(discovered.slice(0, TARGET_TITLES), aliasMap);

  const rows = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    // eslint-disable-next-line no-await-in-loop
    rows.push(await evaluateCase(c));
    if ((i + 1) % 20 === 0) {
      console.log('PROGRESS', i + 1, '/', cases.length);
    }
  }

  const typeSummary = {};
  for (const r of rows) {
    const bucket = typeSummary[r.queryType] || {
      count: 0,
      avgScore: 0,
      foundInTop10: 0,
      top1ExactOrNear: 0,
      falseNegativeCount: 0,
      avgLatencyMs: 0,
    };

    bucket.count += 1;
    bucket.avgScore += r.score;
    bucket.avgLatencyMs += r.latencyMs;
    if (r.rankingPosition !== null) bucket.foundInTop10 += 1;
    if (r.rankingPosition === 1) bucket.top1ExactOrNear += 1;
    if (r.falseNegatives.length) bucket.falseNegativeCount += 1;

    typeSummary[r.queryType] = bucket;
  }

  for (const k of Object.keys(typeSummary)) {
    const b = typeSummary[k];
    b.avgScore = Number((b.avgScore / Math.max(1, b.count)).toFixed(4));
    b.avgLatencyMs = Number((b.avgLatencyMs / Math.max(1, b.count)).toFixed(2));
    b.top10Recall = Number((b.foundInTop10 / Math.max(1, b.count)).toFixed(4));
    b.top1Rate = Number((b.top1ExactOrNear / Math.max(1, b.count)).toFixed(4));
    delete b.top1ExactOrNear;
    delete b.foundInTop10;
  }

  const found = rows.filter((r) => r.rankingPosition !== null).length;
  const top1 = rows.filter((r) => r.rankingPosition === 1).length;
  const avgScore = Number((rows.reduce((a, r) => a + r.score, 0) / Math.max(1, rows.length)).toFixed(4));

  const summary = {
    totalQueries: rows.length,
    avgScore,
    top10Recall: Number((found / Math.max(1, rows.length)).toFixed(4)),
    top1Rate: Number((top1 / Math.max(1, rows.length)).toFixed(4)),
    top1Accuracy: Number((top1 / Math.max(1, rows.length)).toFixed(4)),
    falseNegativeQueries: rows.filter((r) => r.falseNegatives.length).length,
    falseNegatives: rows.filter((r) => r.falseNegatives.length).length,
    falsePositiveMentions: rows.reduce((a, r) => a + r.falsePositives.length, 0),
    falsePositives: rows.reduce((a, r) => a + r.falsePositives.length, 0),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      titlesEvaluated: TARGET_TITLES,
      resultLimit: RESULT_LIMIT,
      queryTypesRequired: ['misspelling', 'aliases', 'japanese', 'english', 'romaji', 'partial'],
    },
    summary,
    comparisonAgainstPreviousAudit: buildPreviousComparison(previousReport, summary),
    typeSummary,
    rows,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  console.log('WROTE', OUTPUT_FILE);
  console.log('TOTAL', rows.length, 'AVG_SCORE', avgScore, 'TOP10_RECALL', out.summary.top10Recall, 'TOP1_RATE', out.summary.top1Rate);
}

run().catch((err) => {
  console.error('SEARCH_QUALITY_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
