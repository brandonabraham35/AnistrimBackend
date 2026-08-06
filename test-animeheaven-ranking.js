// =============================================================
//  test-animeheaven-ranking.js
//
//  Regression tests for the AnimeHeaven search-ranking redesign.
//
//  Two layers:
//    1. DETERMINISTIC unit tests of the composite relevance score
//       (computeRelevanceScore) and search confidence
//       (computeSearchConfidence) — no network required.
//    2. LIVE integration tests: run real searches through the
//       AnimeHeaven provider and assert the intended anime is
//       ranked FIRST (or within an accepted set for ambiguous
//       queries such as "Fate" / "Dragon Ball").
//
//  Output: animeheaven-ranking-test-report.json
// =============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const {
  provider,
  computeRelevanceScore,
  computeSearchConfidence,
  normalizeTitle,
} = require('./services/animeHeavenProvider');

const results = { unit: [], live: [] };
let failures = 0;
let passes = 0;

function record(kind, name, ok, detail) {
  const row = { name, ok, detail: detail || null };
  if (kind === 'unit') results.unit.push(row);
  else results.live.push(row);
  if (ok) {
    passes += 1;
    console.log(`   ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`   ❌ ${name} — ${JSON.stringify(detail)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Helpers ────────────────────────────────────────────────
function relTotal(candidate, query, aliases, episode) {
  return computeRelevanceScore(candidate, query, aliases, episode).total;
}

function rankCandidates(candidates, query) {
  // Emulates runSearch's final sort: score DESC → relevance DESC → localeCompare.
  return [...candidates]
    .map(c => Object.assign({}, c, {
      finalRankingScore: Number(c.score || 0) + relTotal(c.title, query, c.aliases || [], c.episode),
    }))
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff) return scoreDiff;
      const relDiff = Number(b.finalRankingScore - (b.score || 0)) - Number(a.finalRankingScore - (a.score || 0));
      if (relDiff) return relDiff;
      return String(a.title).localeCompare(String(b.title));
    });
}

function titleMatchesAny(title, expectedOrSet) {
  const n = normalizeTitle(title);
  const set = Array.isArray(expectedOrSet) ? expectedOrSet : [expectedOrSet];
  return set.some(e => {
    const ne = normalizeTitle(e);
    return n === ne || n.includes(ne) || ne.includes(n);
  });
}

// ═══════════════════════════════════════════════════════════
//  SECTION 1 — DETERMINISTIC UNIT TESTS (no network)
// ═══════════════════════════════════════════════════════════
function runUnitTests() {
  console.log('\n📋 1. DETERMINISTIC UNIT TESTS (computeRelevanceScore)');

  // Exact raw match dominates a prefix match.
  try {
    const exact = relTotal('One Piece', 'One Piece');
    const prefix = relTotal('One Piece Film Red', 'One Piece');
    const substring = relTotal('My Unique Skill Makes Me OP even at Level 1', 'One Piece');
    assert(exact > prefix, `exact(${exact}) should exceed prefix(${prefix})`);
    assert(prefix > substring, `prefix(${prefix}) should exceed substring(${substring})`);
    assert(substring === 0, `unrelated substring score should be 0, got ${substring}`);
    record('unit', 'Exact match ranks above prefix/substring', true);
  } catch (e) {
    record('unit', 'Exact match ranks above prefix/substring', false, e.message);
  }

  // The KEY regression: "OP" must prefer the exact "One Piece" over the
  // tie-scoring "My Unique Skill Makes Me OP even at Level 1".
  try {
    const op = relTotal('One Piece', 'OP', ['ワンピース']);
    const unique = relTotal('My Unique Skill Makes Me OP even at Level 1', 'OP');
    assert(op > unique, `One Piece relevance(${op}) should exceed My Unique Skill(${unique})`);
    record('unit', '"OP" sorts One Piece above "My Unique Skill..."', true);
  } catch (e) {
    record('unit', '"OP" sorts One Piece above "My Unique Skill..."', false, e.message);
  }

  // Alias matching boosts a candidate.
  try {
    const withAlias = relTotal('Attack on Titan', 'AOT', ['Shingeki no Kyojin']);
    const withoutAlias = relTotal('Attack on Titan', 'AOT');
    assert(withAlias > withoutAlias, `withAlias(${withAlias}) > withoutAlias(${withoutAlias})`);
    record('unit', 'Alias match boosts relevance', true);
  } catch (e) {
    record('unit', 'Alias match boosts relevance', false, e.message);
  }

  // Episode availability adds a bonus when the requested episode is in the title.
  try {
    const ep1 = relTotal('JoJo Part 6', 'JoJo', [], 6);
    const noEp = relTotal('JoJo', 'JoJo', [], 6);
    assert(ep1 > noEp, `episode-aware(${ep1}) > no-episode(${noEp})`);
    record('unit', 'Episode-availability bonus applied', true);
  } catch (e) {
    record('unit', 'Episode-availability bonus applied', false, e.message);
  }

  // Japanese query resolves to the correct title.
  try {
    const jp = relTotal('One Piece', 'ワンピース');
    const unrelated = relTotal('Naruto', 'ワンピース');
    assert(jp > 0 && jp > unrelated, `japanese match(${jp}) > unrelated(${unrelated})`);
    record('unit', 'Japanese query maps to correct romaji title', true);
  } catch (e) {
    record('unit', 'Japanese query maps to correct romaji title', false, e.message);
  }

  // Full re-ranking of a synthetic tie set (simulating the One Piece query).
  try {
    const candidates = [
      { title: 'My Unique Skill Makes Me OP even at Level 1', score: 307, aliases: [] },
      { title: 'One Piece', score: 307, aliases: ['ワンピース'] },
      { title: 'One Piece Film Red', score: 291, aliases: [] },
      { title: 'takt op.Destiny', score: 307, aliases: [] },
    ];
    const ranked = rankCandidates(candidates, 'One Piece');
    assert(ranked[0].title === 'One Piece', `top should be One Piece, got ${ranked[0].title}`);
    record('unit', 'Tie-set ranking: "One Piece" wins the 307 tie', true);
  } catch (e) {
    record('unit', 'Tie-set ranking: "One Piece" wins the 307 tie', false, e.message);
  }

  // Confidence: a wide gap yields high confidence; a narrow gap yields low.
  try {
    const high = computeSearchConfidence({ finalRankingScore: 1305 }, { finalRankingScore: 840 });
    const low = computeSearchConfidence({ finalRankingScore: 1012 }, { finalRankingScore: 1006 });
    assert(high > 0.9, `high confidence should be near 1, got ${high}`);
    assert(low > 0 && low < 0.5, `low confidence should be small, got ${low}`);
    record('unit', 'computeSearchConfidence reflects gap between top two', true);
  } catch (e) {
    record('unit', 'computeSearchConfidence reflects gap between top two', false, e.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 2 — LIVE INTEGRATION TESTS (network)
// ═══════════════════════════════════════════════════════════
// Standard queries: unambiguous, expect an exact title first.
const STANDARD_QUERIES = [
  { query: 'One Piece', expected: 'One Piece' },
  { query: 'Naruto', expected: 'Naruto' },
  { query: 'Jujutsu Kaisen', expected: 'Jujutsu Kaisen' },
  { query: 'Demon Slayer', expected: 'Demon Slayer' },
  { query: 'Steins;Gate', expected: 'Steins;Gate' },
  { query: 'Attack on Titan', expected: 'Attack on Titan' },
  { query: 'FMAB', expected: 'Fullmetal Alchemist Brotherhood' },
  { query: 'My Hero Academia', expected: 'My Hero Academia' },
  { query: 'Sword Art Online', expected: 'Sword Art Online' },
  { query: 'Re:Zero', expected: 'Re:Zero' },
];

// Difficult queries: ambiguous or tie-prone. `expected` may be an array of
// accepted titles (any of which is considered a correct #1 result).
const DIFFICULT_QUERIES = [
  { query: 'OP', expected: 'One Piece' }, // must beat "My Unique Skill Makes Me OP..."
  { query: 'AOT', expected: 'Attack on Titan' },
  { query: 'MHA', expected: 'My Hero Academia' },
  { query: 'SAO', expected: 'Sword Art Online' },
  { query: 'FMAB', expected: 'Fullmetal Alchemist Brotherhood' },
  { query: 'Fate', expected: ['Fate/stay night', 'Fate/stay night: Unlimited Blade Works', 'Fate/Zero'] },
  { query: 'Dragon Ball', expected: ['Dragon Ball', 'Dragon Ball Z', 'Dragon Ball Super'] },
  { query: 'Steins Gate', expected: 'Steins;Gate' },
];

async function runLiveTests() {
  console.log('\n📋 2. LIVE INTEGRATION TESTS (searchAnime)');

  const runOne = async (probe, kind) => {
    const name = `${kind}: "${probe.query}" → top result matches ${Array.isArray(probe.expected) ? `[${probe.expected.join(', ')}]` : `"${probe.expected}"`}`;
    try {
      const rows = await provider.searchAnime(probe.query, 10);
      if (!rows.length) {
        record('live', name, false, 'no results returned');
        return;
      }
      const top = rows[0];
      const ok = titleMatchesAny(top.title, probe.expected);
      record('live', name, ok, {
        returned: top.title,
        identifier: top.identifier,
        score: top.score,
        relevance: top.relevance,
        finalRankingScore: top.finalRankingScore,
        confidence: top.searchConfidence,
        aliases: top.aliases,
        totalResults: rows.length,
      });
    } catch (e) {
      record('live', name, false, e.message);
    }
  };

  for (const probe of STANDARD_QUERIES) await runOne(probe, 'standard');
  for (const probe of DIFFICULT_QUERIES) await runOne(probe, 'difficult');
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('   AnimeHeaven Search Ranking Regression Tests');
  console.log('════════════════════════════════════════════════\n');

  runUnitTests();

  // Live tests require network; run them but tolerate total environment
  // failure (e.g., no internet) by reporting each as failed with the reason.
  await runLiveTests();

  const total = passes + failures;
  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS`);
  console.log(`   Passed: ${passes}/${total}`);
  console.log(`   Failed: ${failures}/${total}`);
  console.log('════════════════════════════════════════════════\n');

  const report = {
    generatedAt: new Date().toISOString(),
    summary: { total, passed: passes, failed: failures },
    unit: results.unit,
    live: results.live,
  };
  fs.writeFileSync(
    path.join(__dirname, 'animeheaven-ranking-test-report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log('📄 Report written to animeheaven-ranking-test-report.json');

  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
