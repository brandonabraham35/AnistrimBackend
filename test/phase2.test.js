// test/phase2.test.js — Phase 2 automated tests (node --test).
//
// Covers the fixes from the Phase 2 audit:
//   1. Migration ordering (schema.sql first)
//   2. Schema-name guards (DATABASE() instead of hard-coded 'anistrim2')
//   3. sharp availability probe
//   4. Genre seeding (no JSON.parse on already-parsed JSON)
//   5. Profile watch history field mapping
//   6. Single API client shape
//   7. Avatar rendering everywhere
//   8. Preferences hardening (subtitleLang whitelist, genre validation, DB re-read)
//   9. Competing user/entitlement state
//   10. Duplicate username routes removed
//   11. Re-auth for account deletion
//
// These are unit/static tests that do NOT require a live database. They verify
// the code-level fixes are present. Integration tests requiring a DB are
// documented in the audit's section J and should be run against a seeded DB.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── FIX 1: Migration ordering ─────────────────────────────────────
test('FIX 1: schema.sql sorts before versioned migrations', () => {
  const migrateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  assert.match(migrateSrc, /filename === 'schema\.sql'\) return -1/, 'schema.sql must rank -1 (first)');
  assert.match(migrateSrc, /filename === 'updates\.sql'\) return Number\.MAX_SAFE_INTEGER/, 'updates.sql must rank last');
});

test('FIX 1: migration runner aborts on failure and prints filename', () => {
  const migrateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  assert.match(migrateSrc, /Migration FAILED: \$\{file\.name\}/, 'must print failing filename');
  assert.match(migrateSrc, /process\.exitCode = 1/, 'must set exit code 1 on failure');
});

// ── FIX 2: Schema-name guards ─────────────────────────────────────
test('FIX 2: migration runner replaces hard-coded schema names with DATABASE()', () => {
  const migrateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.js'), 'utf8');
  assert.match(migrateSrc, /TABLE_SCHEMA\s*=\s*DATABASE\(\)/i, 'runner must replace anistrim2 with DATABASE()');
});

test('FIX 2: v30 and v31 use DATABASE() in their guards', () => {
  const v30 = fs.readFileSync(path.join(ROOT, 'sql', 'migrations_v30_user_preferences.sql'), 'utf8');
  const v31 = fs.readFileSync(path.join(ROOT, 'sql', 'migrations_v31_watch_history_unify.sql'), 'utf8');
  assert.match(v30, /TABLE_SCHEMA\s*=\s*DATABASE\(\)/i, 'v30 must use DATABASE()');
  assert.match(v31, /TABLE_SCHEMA\s*=\s*DATABASE\(\)/i, 'v31 must use DATABASE()');
});

// ── FIX 3: sharp ──────────────────────────────────────────────────
test('FIX 3: sharp is a declared dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.sharp, 'sharp must be in dependencies');
  assert.match(pkg.dependencies.sharp, /^\^0\.33/, 'sharp must be pinned to ^0.33');
});

test('FIX 3: avatarService has a boot-time probe and EXIF rotation', () => {
  const avatarSrc = fs.readFileSync(path.join(ROOT, 'services', 'avatarService.js'), 'utf8');
  assert.match(avatarSrc, /probeSharp/, 'must export probeSharp');
  assert.match(avatarSrc, /\.rotate\(\)/, 'must call .rotate() for EXIF orientation');
});

test('FIX 3: avatar route returns AVATAR_UNAVAILABLE code on SHARP_MISSING', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'avatarRoutes.js'), 'utf8');
  assert.match(routeSrc, /AVATAR_UNAVAILABLE/, 'must return AVATAR_UNAVAILABLE code');
});

test('FIX 3: server.js probes sharp at boot', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(serverSrc, /probeSharp/, 'server must call probeSharp at boot');
});

// ── FIX 4: Genre seeding ──────────────────────────────────────────
test('FIX 4: recommendationService uses preferencesService.getPreferences', () => {
  const recSrc = fs.readFileSync(path.join(ROOT, 'services', 'recommendationService.js'), 'utf8');
  assert.match(recSrc, /getPreferences/, 'must use preferencesService.getPreferences');
  assert.doesNotMatch(recSrc, /JSON\.parse\(prefs\[0\]\?\.genres\)/, 'must NOT JSON.parse an already-parsed JSON column');
});

// ── FIX 5: Profile watch history ──────────────────────────────────
test('FIX 5: profile.js uses /api/watch/history', () => {
  const profileSrc = fs.readFileSync(path.join(ROOT, 'Frontend', 'profile.js'), 'utf8');
  assert.match(profileSrc, /\/api\/watch\/history\?limit=10/, 'must call canonical /api/watch/history');
  assert.doesNotMatch(profileSrc, /\/api\/watchlist\/continue/, 'must NOT call legacy /api/watchlist/continue');
});

test('FIX 5: legacy mapper reads canonical field names', () => {
  const wlSrc = fs.readFileSync(path.join(ROOT, 'controllers', 'watchlistController.js'), 'utf8');
  assert.match(wlSrc, /item\.title \|\| item\.animeTitle/, 'must read title/animeTitle');
  assert.match(wlSrc, /item\.positionSec \|\| item\.progressSeconds/, 'must read positionSec/progressSeconds');
});

// ── FIX 6: Single API client ──────────────────────────────────────
test('FIX 6: all authenticated pages load js/api.js', () => {
  const pages = ['index.html', 'watch.html', 'details.html', 'watchlist.html', 'browse.html', 'profile.html', 'onboarding.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'Frontend', page), 'utf8');
    assert.match(html, /js\/api\.js/, `${page} must load js/api.js`);
  }
});

test('FIX 6: all authenticated pages load js/session.js', () => {
  const pages = ['index.html', 'watch.html', 'details.html', 'watchlist.html', 'browse.html', 'profile.html', 'onboarding.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'Frontend', page), 'utf8');
    assert.match(html, /js\/session\.js/, `${page} must load js/session.js`);
  }
});

// ── FIX 7: Avatars everywhere ─────────────────────────────────────
test('FIX 7: all authenticated pages load js/avatar.js', () => {
  const pages = ['index.html', 'watch.html', 'details.html', 'watchlist.html', 'browse.html', 'profile.html', 'onboarding.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'Frontend', page), 'utf8');
    assert.match(html, /js\/avatar\.js/, `${page} must load js/avatar.js`);
  }
});

test('FIX 7: index.html has a data-avatar element in the header', () => {
  const html = fs.readFileSync(path.join(ROOT, 'Frontend', 'index.html'), 'utf8');
  assert.match(html, /data-avatar/, 'index.html must have a data-avatar element');
});

// ── FIX 8: Preferences hardening ──────────────────────────────────
test('FIX 8: subtitleLang is whitelisted', () => {
  const ctrlSrc = fs.readFileSync(path.join(ROOT, 'controllers', 'profileController.js'), 'utf8');
  assert.match(ctrlSrc, /ALLOWED_SUBTITLE_LANGS/, 'must define ALLOWED_SUBTITLE_LANGS');
  assert.match(ctrlSrc, /'en', 'es', 'fr', 'de', 'pt', 'ja', 'ar', 'none'/, 'must whitelist en/es/fr/de/pt/ja/ar/none');
});

test('FIX 8: genres are validated against the genres table', () => {
  const ctrlSrc = fs.readFileSync(path.join(ROOT, 'controllers', 'profileController.js'), 'utf8');
  assert.match(ctrlSrc, /SELECT name FROM genres WHERE name IN/, 'must validate genres against genres table');
});

test('FIX 8: PUT preferences re-reads from DB', () => {
  const ctrlSrc = fs.readFileSync(path.join(ROOT, 'controllers', 'profileController.js'), 'utf8');
  assert.match(ctrlSrc, /const freshPrefs = await getPreferences\(userId\)/, 'must re-read from DB after upsert');
});

test('FIX 8: preferencesService rethrows non-table-missing errors', () => {
  const prefsSrc = fs.readFileSync(path.join(ROOT, 'services', 'preferencesService.js'), 'utf8');
  assert.match(prefsSrc, /throw e;/, 'must rethrow non-ER_NO_SUCH_TABLE errors');
});

test('FIX 8: profile page has genre editing UI', () => {
  const profileHtml = fs.readFileSync(path.join(ROOT, 'Frontend', 'profile.html'), 'utf8');
  const profileJs = fs.readFileSync(path.join(ROOT, 'Frontend', 'profile.js'), 'utf8');
  assert.match(profileHtml, /pref-genre-options/, 'profile.html must have genre options container');
  assert.match(profileJs, /getSelectedPrefGenres/, 'profile.js must collect selected genres');
  assert.match(profileJs, /genres: getSelectedPrefGenres\(\)/, 'savePreferences must include genres');
});

// ── FIX 9: Competing user/entitlement state ───────────────────────
test('FIX 9: State.isPremium reads from Session DTO entitlement', () => {
  const scrptSrc = fs.readFileSync(path.join(ROOT, 'Frontend', 'scrpt.js'), 'utf8');
  assert.match(scrptSrc, /Session\.getUser\(\)/, 'State must read from Session');
  assert.match(scrptSrc, /entitlement\.isPremium/, 'must read entitlement.isPremium');
});

// ── FIX 10: Duplicate username routes ─────────────────────────────
test('FIX 10: server.js no longer declares inline /api/auth/username-available', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(serverSrc, /app\.get\('\/api\/auth\/username-available'/, 'must not declare inline duplicate');
  assert.doesNotMatch(serverSrc, /app\.post\('\/api\/auth\/set-username'/, 'must not declare inline duplicate');
});

// ── FIX 11: Re-auth for account deletion ──────────────────────────
test('FIX 11: deleteAccount requires password', () => {
  const authSrc = fs.readFileSync(path.join(ROOT, 'controllers', 'authController.js'), 'utf8');
  assert.match(authSrc, /const \{ password \} = req\.body/, 'must read password from body');
  assert.match(authSrc, /bcrypt\.compare\(password, user\.password_hash\)/, 'must verify password');
});

test('FIX 11: profile.js sends password for delete', () => {
  const profileSrc = fs.readFileSync(path.join(ROOT, 'Frontend', 'profile.js'), 'utf8');
  assert.match(profileSrc, /JSON\.stringify\(\{ password \}\)/, 'must send password in delete request');
});

// ── FIX 12: npm test exists ───────────────────────────────────────
test('FIX 12: package.json has a test script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test, 'must have a test script');
});