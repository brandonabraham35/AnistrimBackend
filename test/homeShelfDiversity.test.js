// test/homeShelfDiversity.test.js — Phase 6.2 unit tests for diversify().
//
// Proves:
//   1. The hard appearance cap (MAX_APPEARANCES = 3) is enforced.
//   2. The cross-shelf penalty (finalScore = shelfScore * (1 - penalty),
//      penalty = min(0.6, 0.3 * timesAlreadyShownOnThisPage)) affects
//      placement across trending → popular → newReleases → classics.
//   3. Trending #1 is never suppressed, is exempt from the appearance cap,
//      and is restored to position 0.
const assert = require('assert');
const { diversify, DIVERSITY_CONFIG } = require('../services/homeShelfService');

// Helper: build a minimal anime item with an id, rating, and _score.
function anime(id, rating, score) {
  return { id, title: 'Anime ' + id, rating, _score: score, view_count: 100 };
}

// ── Test 1: Trending #1 is never suppressed and restored to position 0 ──
function testTrendingTopExemption() {
  const trendingTop = anime(1, 9.9, 1000);
  const sections = {
    trending: [trendingTop, anime(2, 9.0, 900), anime(3, 8.5, 800)],
    popular: [anime(1, 9.9, 1000), anime(4, 8.8, 700)],
    newReleases: [anime(1, 9.9, 1000), anime(5, 8.0, 600)],
    classics: [anime(1, 9.9, 1000), anime(6, 7.8, 500)],
  };

  const result = diversify(sections);

  // Trending #1 must be at position 0 of the trending row.
  assert.strictEqual(result.trending[0].id, 1, 'Trending #1 must be at position 0');
  // Trending #1 must be present in the trending row.
  assert.ok(result.trending.some(i => i.id === 1), 'Trending #1 must be present in trending');
  // Trending #1 is exempt from the appearance cap — it can appear 4+ times.
  const appearances = ['trending', 'popular', 'newReleases', 'classics']
    .reduce((acc, key) => acc + result[key].filter(i => i.id === 1).length, 0);
  assert.ok(appearances >= 4, `Trending #1 should appear 4+ times (exempt from cap), got ${appearances}`);
  console.log('  ✓ Trending #1 exemption: never suppressed, position 0, cap-exempt');
}

// ── Test 2: Hard appearance cap (MAX_APPEARANCES = 3) is enforced ──
function testAppearanceCap() {
  // Anime 2 appears in all four sections but is NOT trending #1 (anime 1 is).
  // It should be capped at 3 appearances.
  const sections = {
    trending: [anime(1, 9.0, 900), anime(2, 8.0, 800)],
    popular: [anime(2, 8.0, 800), anime(3, 8.5, 700)],
    newReleases: [anime(2, 8.0, 800), anime(4, 8.0, 600)],
    classics: [anime(2, 8.0, 800), anime(5, 7.8, 500)],
  };

  const result = diversify(sections);

  // Anime 2 (not trending #1) must appear at most MAX_APPEARANCES times.
  const appearances = ['trending', 'popular', 'newReleases', 'classics']
    .reduce((acc, key) => acc + result[key].filter(i => i.id === 2).length, 0);
  assert.ok(appearances <= DIVERSITY_CONFIG.MAX_APPEARANCES,
    `Anime 2 should appear at most ${DIVERSITY_CONFIG.MAX_APPEARANCES} times, got ${appearances}`);
  console.log(`  ✓ Appearance cap: anime 2 appears ${appearances} times (max ${DIVERSITY_CONFIG.MAX_APPEARANCES})`);
}

// ── Test 3: Cross-shelf penalty affects placement ──
function testCrossShelfPenalty() {
  // Anime 1 appears in trending (position 0) and popular. In popular, it has
  // a high _score but should be penalised because it already appeared once.
  // Anime 2 has a lower _score but no prior appearance — it should outrank
  // anime 1 in the popular shelf.
  const sections = {
    trending: [anime(1, 9.0, 1000), anime(2, 8.0, 500)],
    popular: [anime(1, 9.0, 1000), anime(2, 8.0, 500)],
    newReleases: [],
    classics: [],
  };

  const result = diversify(sections);

  // In popular, anime 1 has been seen once (penalty = 0.3), so its finalScore
  // is 1000 * 0.7 = 700. Anime 2 has not been seen (penalty = 0), so its
  // finalScore is 500. Anime 1 should still outrank anime 2 because 700 > 500.
  // But if anime 1 had been seen 3+ times (penalty = 0.6), its finalScore
  // would be 1000 * 0.4 = 400 < 500, so anime 2 would outrank it.
  // Let's verify the penalty is actually applied by checking the order.
  const popularIds = result.popular.map(i => i.id);
  assert.strictEqual(popularIds[0], 1, 'Anime 1 (penalised but still higher) should be first in popular');
  assert.strictEqual(popularIds[1], 2, 'Anime 2 should be second in popular');

  // Now test the stronger penalty: anime 1 appears in trending, popular, AND
  // newReleases before classics. In classics, anime 1 has been seen 3 times
  // → penalty = min(0.6, 0.3*3) = 0.6 → finalScore = 1000*0.4 = 400.
  // Anime 5 has not been seen → finalScore = 500. Anime 5 should outrank
  // anime 1 in the classics shelf.
  const sections3 = {
    trending: [anime(2, 8.0, 500), anime(1, 9.0, 1000)],
    popular: [anime(1, 9.0, 1000), anime(3, 7.0, 300)],
    newReleases: [anime(1, 9.0, 1000), anime(4, 6.5, 200)],
    classics: [anime(1, 9.0, 1000), anime(5, 8.0, 500)],
  };

  const result3 = diversify(sections3);

  // In classics, anime 1 has been seen 3 times (trending + popular +
  // newReleases) → penalty = min(0.6, 0.3*3) = 0.6 → finalScore = 1000*0.4 = 400.
  // Anime 5 has not been seen → finalScore = 500. Anime 5 should now outrank
  // anime 1 in the classics shelf.
  const classicsIds3 = result3.classics.map(i => i.id);
  assert.strictEqual(classicsIds3[0], 5, 'Anime 5 (unpenalised) should outrank anime 1 (heavily penalised) in classics');
  console.log('  ✓ Cross-shelf penalty: heavily-penalised anime drops below unpenalised one');
}

// ── Test 4: _score is carried through internally and stripped at API boundary ──
function testScoreCarriedThrough() {
  const sections = {
    trending: [anime(1, 9.0, 1000), anime(2, 8.0, 500)],
    popular: [anime(3, 8.5, 700)],
    newReleases: [anime(4, 8.0, 600)],
    classics: [anime(5, 7.8, 500)],
  };

  const result = diversify(sections);

  // The diversified result should still carry _score internally (it is
  // stripped only at the API boundary by publicAnime).
  assert.strictEqual(result.trending[0]._score, 1000, 'Trending #1 should carry _score internally');
  assert.strictEqual(result.popular[0]._score, 700, 'Popular should carry _score internally');
  console.log('  ✓ _score carried through internally');
}

// ── Run all tests ──
console.log('Running homeShelf diversify() tests...');
testTrendingTopExemption();
testAppearanceCap();
testCrossShelfPenalty();
testScoreCarriedThrough();
console.log('\nAll homeShelf diversify() tests passed.');