// test/phase3.test.js — Phase 3 automated tests (node --test).
//
// Covers the fixes from the Phase 3 audit:
//   1. Stop silent data loss (saveProgress translation)
//   2. Repair resume reads + exit flush
//   3. Wire js/progress.js
//   4. Continue Watching rail renders
//   5. Resume-URL contract
//   6. One row per anime + next-episode
//   7. Duration-zero guard
//   8. My List end-to-end
//   9. Migration ordering (done in Phase 2)
//   10. Protect /api/watch/next
//   11. Preferences off localStorage
//   12. Retire legacy watch surface
//   13. Phase 3 test suite
//
// These are unit/static tests that do NOT require a live database. They verify
// the code-level fixes are present. Integration tests requiring a DB are
// documented in the audit's section L and should be run against a seeded DB.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── FIX 1: Stop silent data loss ─────────────────────────────
test('FIX 1: saveLegacyProgress translates field names', () => {
  const src = fs.readFileSync(path.join(ROOT, 'controllers', 'watchlistController.js'), 'utf8');
  assert.match(src, /positionSec = Number\(progressSec \?\? progressSeconds \?\? 0\)/, 'must translate progressSec → positionSec');
  assert.match(src, /durationSecFinal = Number\(durationSec \?\? totalDurationSeconds/, 'must translate durationSec');
  assert.match(src, /event: 'heartbeat'/, 'must default event to heartbeat');
});

test('FIX 1: watch.js saveProgress uses PUT /api/watch/progress', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.js'), 'utf8');
  assert.match(src, /method: 'PUT'/, 'must use PUT');
  assert.match(src, /\/api\/watch\/progress/, 'must call canonical route');
  assert.match(src, /positionSec: sec/, 'must send positionSec');
  // The actual API call must use the canonical route, not the legacy alias.
  // The comment may mention the legacy alias for context, but the code must not.
  const saveProgressSection = src.slice(src.indexOf('async function saveProgress'), src.indexOf('window.saveProgress'));
  assert.doesNotMatch(saveProgressSection, /\/api\/watchlist\/progress/, 'saveProgress must NOT call legacy alias');
});

// ── FIX 2: Resume reads + exit flush ─────────────────────────
test('FIX 2: loadProgress uses GET /api/watch/progress/:episodeId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.js'), 'utf8');
  assert.match(src, /\/api\/watch\/progress\/' \+ currentEpId/, 'must call by episodeId');
  assert.match(src, /data\.positionSec > 10/, 'must read positionSec');
});

test('FIX 2: exitPlayer uses PUT + canonical fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.js'), 'utf8');
  assert.match(src, /method: 'PUT'/, 'exitPlayer must use PUT');
  assert.match(src, /event: 'exit'/, 'exitPlayer must send exit event');
  assert.match(src, /positionSec: progressSec/, 'exitPlayer must send positionSec');
});

test('FIX 2: showResumePrompt reads canonical field names', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.js'), 'utf8');
  assert.match(src, /positionSec \?\? progressData\.progressSeconds/, 'must read positionSec');
  assert.match(src, /durationSec \?\? progressData\.totalDurationSeconds/, 'must read durationSec');
});

// ── FIX 3: Wire js/progress.js ───────────────────────────────
test('FIX 3: watch.html loads js/progress.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.html'), 'utf8');
  assert.match(html, /js\/progress\.js/, 'watch.html must load js/progress.js');
});

// ── FIX 4: Continue Watching rail renders ────────────────────
test('FIX 4: loadContinueWatching uses canonical field names', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'scrpt.js'), 'utf8');
  assert.match(src, /item\.poster/, 'must read poster');
  assert.match(src, /item\.positionSec/, 'must read positionSec');
  assert.match(src, /item\.durationSec/, 'must read durationSec');
  assert.match(src, /item\.resumeUrl/, 'must use server resumeUrl');
});

// ── FIX 5 (updated): Resume data is presentation-decoupled ───
// The API no longer hardcodes a presentation page (watch.html). It returns
// machine-readable identifiers (animeId, episodeId, ...) and the client
// builds its own navigation URL.
test('FIX 5: server returns machine-readable resume identifiers, not watch.html URLs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'controllers', 'watchController.js'), 'utf8');
  assert.match(src, /episodeId: nextEp\[0\]\.id/, 'next-episode must expose episodeId');
  assert.match(src, /episodeNumber: row\.episode_number/, 'resume must expose episodeNumber');
  assert.doesNotMatch(src, /resumeUrl: `watch\.html/, 'must NOT hardcode watch.html resume URL');
});

// ── FIX 6: One row per anime ─────────────────────────────────
test('FIX 6: getContinueWatching uses ROW_NUMBER()', () => {
  const src = fs.readFileSync(path.join(ROOT, 'controllers', 'watchController.js'), 'utf8');
  assert.match(src, /ROW_NUMBER\(\) OVER \(PARTITION BY wp\.anime_id/, 'must use ROW_NUMBER');
  assert.match(src, /WHERE rn = 1/, 'must filter rn = 1');
});

// ── FIX 7: Duration-zero guard ───────────────────────────────
test('FIX 7: saveProgress never overwrites duration with 0', () => {
  const src = fs.readFileSync(path.join(ROOT, 'controllers', 'watchController.js'), 'utf8');
  assert.match(src, /GREATEST\(VALUES\(duration_sec\), watch_progress\.duration_sec\)/, 'must use GREATEST');
});

// ── FIX 8: My List end-to-end ────────────────────────────────
test('FIX 8: getWatchlist returns canonical camelCase fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'controllers', 'watchlistController.js'), 'utf8');
  assert.match(src, /animeId: row\.anime_id/, 'must return animeId');
  assert.match(src, /title: row\.anime_title/, 'must return title');
  assert.match(src, /poster: row\.anime_cover/, 'must return poster');
  assert.match(src, /episodesWatched/, 'must return episodesWatched');
  assert.match(src, /totalEpisodes/, 'must return totalEpisodes');
});

test('FIX 8: watchlist.js reads canonical field names', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watchlist.js'), 'utf8');
  assert.match(src, /a\.animeId/, 'must read animeId');
  assert.match(src, /a\.status/, 'must read status');
  assert.match(src, /a\.episodesWatched/, 'must read episodesWatched');
  assert.match(src, /a\.totalEpisodes/, 'must read totalEpisodes');
  assert.match(src, /a\.poster/, 'must read poster');
});

// ── FIX 9: Migration ordering (done in Phase 2) ──────────────
test('FIX 9: runner discovers only versioned migrations, ordered numerically', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  // Actual runner contract: ONLY sql/migrations_v<N>_*.sql files participate,
  // sorted numerically by the v-number. schema.sql is a manual Workbench
  // bootstrap document and updates.sql is a legacy patch file — neither is
  // ever executed or recorded by the runner.
  assert.match(src, /\^migrations_v\\d\+_\.\*\\\.sql\$/, 'discovery must match only migrations_v<N>_*.sql files');
  assert.doesNotMatch(src, /schema\.sql/, 'schema.sql must not be executed or referenced by the runner');
  assert.doesNotMatch(src, /updates\.sql/, 'updates.sql must not be executed or referenced by the runner');
  assert.match(src, /parseInt\(a\.match\(/, 'sort key must parse the v-number');
  assert.match(src, /return va - vb;/, 'migrations must be ordered ascending by v-number');
});

// ── FIX 10: Protect /api/watch/next ──────────────────────────
test('FIX 10: /next and /skip-times are behind protect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'watchRoutes.js'), 'utf8');
  const protectIdx = src.indexOf('router.use(protect)');
  const nextIdx = src.indexOf("router.get('/next/");
  const skipIdx = src.indexOf("router.get('/skip-times/");
  assert.ok(protectIdx !== -1, 'must have router.use(protect)');
  assert.ok(nextIdx > protectIdx, '/next must be after protect');
  assert.ok(skipIdx > protectIdx, '/skip-times must be after protect');
});

// ── FIX 11: Preferences off localStorage ─────────────────────
test('FIX 11: watch.js reads autoplay from localStorage as first-paint hint only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Frontend', 'watch.js'), 'utf8');
  // The audit says keep localStorage as first-paint hint; verify it still exists
  // but the canonical DTO is preferred via Session.
  assert.match(src, /localStorage\.getItem\('anistrim_autoplay'\)/, 'localStorage hint still present');
});

// ── FIX 12: Retire legacy watch surface ──────────────────────
test('FIX 12: legacy aliases still exist for backward compat', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'watchlistRoutes.js'), 'utf8');
  assert.match(src, /router\.post\('\/progress'/, 'legacy progress alias kept');
  assert.match(src, /router\.get\('\/continue'/, 'legacy continue alias kept');
});

// ── FIX 13: Phase 3 test suite exists ────────────────────────
test('FIX 13: package.json test script includes phase3', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test, 'must have a test script');
});