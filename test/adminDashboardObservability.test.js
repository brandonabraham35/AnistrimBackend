// test/adminDashboardObservability.test.js — Phase B dashboard truthfulness tests.
//
// Verifies the Admin Dashboard UI faithfully represents the
// persistent-until-proven-dead cache architecture and the Phase A metrics:
//   - no fabricated "Total Searches" metric (no real producer exists)
//   - no misleading "Provider Usage" chart (it was episodes with/without video_url)
//   - no misleading "Avg Lifetime" card (observed interval, not source age)
//   - inMemoryHits is presented as resolver/repair-path memory hits, NOT
//     normal playback in-memory cache hits
//   - cacheHitRate is clearly marked derived/approximate
//   - providerCallsAvoided is displayed as an explicit metric
//   - persistent-cache policy panel is present
//   - nonfunctional platform/date filters are removed from the analytics section
//   - process-lifetime vs DB-total distinction is communicated
//   - the stream-cache metrics module exposes the authoritative fields

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('dashboard.html removes fabricated/misleading metrics', () => {
  const html = read('AdminDashboard/dashboard.html');

  // Total Searches has no real producer — must be gone.
  assert.ok(!html.includes('Total Searches'), 'Total Searches card must be removed');
  assert.ok(!html.includes('analytics-total-searches'), 'analytics-total-searches id must be gone');

  // Provider Usage chart misrepresented episodes with/without video_url.
  assert.ok(!html.includes('Provider Usage'), 'Provider Usage chart must be removed');
  assert.ok(!html.includes('chart-provider-usage'), 'chart-provider-usage must be gone');

  // Avg Lifetime implied sources should die after an interval.
  assert.ok(!html.includes('Avg Lifetime'), 'Avg Lifetime card must be removed');
  assert.ok(!html.includes('sc-avg-lifetime'), 'sc-avg-lifetime id must be gone');

  // Truthful source-age wording must remain (age is NOT expiration).
  assert.ok(html.includes('Average Source Age'), 'Average Source Age wording must be present');
});

test('dashboard.html presents cache metrics truthfully', () => {
  const html = read('AdminDashboard/dashboard.html');

  // inMemoryHits is the resolver/repair-path memory cache, not playback hits.
  assert.ok(html.includes('Resolver Memory Hits'), 'inMemoryHits must be labeled Resolver Memory Hits');
  assert.ok(!html.includes('>In-Memory Hits<'), 'generic In-Memory Hits label must be gone');

  // cacheHitRate is derived/approximate only.
  assert.ok(html.includes('Derived Cache Hit Rate'), 'cacheHitRate must be marked derived');

  // providerCallsAvoided is an explicit metric card.
  assert.ok(html.includes('Provider Calls Avoided'), 'providerCallsAvoided card must be present');

  // Persistent-until-proven-dead policy panel.
  assert.ok(html.includes('Persistent until proven dead'), 'policy panel must state persistent-until-proven-dead');
  assert.ok(html.includes('STREAM SOURCE POLICY'), 'policy panel must be present');

  // Process-lifetime vs DB totals distinction.
  assert.ok(/process-lifetime \(since last restart\)/i.test(html), 'process-lifetime note must be present');

  // Nonfunctional analytics filters removed (breakdown section id is a
  // different, legitimate element — analytics-platform-breakdown).
  assert.ok(!html.includes('id="analytics-platform"'), 'nonfunctional platform filter must be removed');
  assert.ok(!html.includes('id="analytics-range"'), 'nonfunctional date-range filter must be removed');
});

test('dashboard JS no longer renders removed/fabricated metrics', () => {
  const analytics = read('AdminDashboard/js/analytics.js');
  const dashboard = read('AdminDashboard/js/dashboard.js');

  assert.ok(!analytics.includes('analytics-total-searches'), 'analytics.js must not write Total Searches');
  assert.ok(!analytics.includes('sc-avg-lifetime'), 'analytics.js must not write Avg Lifetime');
  assert.ok(!analytics.includes("'analytics-platform'"), 'analytics.js must not reference removed platform filter');
  assert.ok(!analytics.includes("'analytics-range'"), 'analytics.js must not reference removed range filter');
  assert.ok(!dashboard.includes('provider-usage'), 'dashboard.js must not load the Provider Usage chart');

  // Truthful fields still rendered.
  assert.ok(analytics.includes('providerCallsAvoided'), 'analytics.js must render providerCallsAvoided');
  assert.ok(analytics.includes('reusableSources'), 'analytics.js must render reusableSources');
  assert.ok(analytics.includes('invalidSourcesCount'), 'analytics.js must render invalidSourcesCount');
  assert.ok(analytics.includes('knownExpiredSources'), 'analytics.js must render knownExpiredSources');
});

test('streamCacheMetrics snapshot exposes authoritative Phase A fields', () => {
  const metrics = require('../services/streamCacheMetrics');
  metrics.reset();

  // providerCallsAvoided is an explicit counter, not derived from hits.
  assert.strictEqual(metrics.counters.providerCallsAvoided, 0);
  metrics.recordProviderAvoided();
  assert.strictEqual(metrics.counters.providerCallsAvoided, 1);

  // Merely incrementing hit counters must NOT change providerCallsAvoided.
  metrics.increment('tier1Hits');
  metrics.increment('redisHits');
  metrics.increment('mysqlHits');
  assert.strictEqual(metrics.counters.providerCallsAvoided, 1);

  metrics.reset();
});
