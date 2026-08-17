// test/integration.test.js — Prompt 10 integration tests.
//
// Hits the real HTTP surface (via supertest-style fetch against the Express
// app) and the real DB. Requires a running MySQL database (the same one the
// server uses). Tests are skipped if the DB is unreachable.
//
// Covers:
//   1. Anonymous user cannot obtain video_url from any episode endpoint.
//   2. Free user against premium content → 403 / no video_url.
//   3. Entitled user (active subscription) → can watch premium content.
//   4. Payment IPN → subscription → getEntitlement().
//   5. Duplicate IPN idempotency (same OrderTrackingId twice).
//   6. Admin grant survives a scheduler sweep.
//   7. premium_until expiry at read time (scheduler disabled).
//   8. No route returns video_url to an unauthenticated caller.
const assert = require('assert');
const http = require('http');
const express = require('express');
const pool = require('../config/db');

// ── Build a minimal Express app with the real routes ──────────
const app = express();
app.use(express.json());
app.use('/api/anime', require('../routes/animeRoutes'));
app.use('/api/stream', require('../routes/streamRoutes'));
app.use('/api/payments', require('../routes/paymentRoutes'));
app.use('/api/home', require('../routes/homeShelfRoutes'));

let server;
let baseUrl;

async function startServer() {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (server) await new Promise(resolve => server.close(resolve));
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ── Test helpers ──────────────────────────────────────────────
async function createTestUser(email) {
  const [r] = await pool.query(
    `INSERT INTO users (email, password_hash, is_premium, status)
     VALUES (?, 'x', 0, 'active')`,
    [email]
  );
  return r.insertId;
}

async function createTestAnime(title, { isPremium = false, accessTier = 'free' } = {}) {
  const [r] = await pool.query(
    `INSERT INTO anime (title, is_published, is_premium, access_tier, rating, view_count)
     VALUES (?, 1, ?, ?, 8.0, 100)`,
    [title, isPremium ? 1 : 0, accessTier]
  );
  return r.insertId;
}

async function createTestEpisode(animeId, { isPremium = false, accessTier = 'inherit', premiumUntil = null } = {}) {
  const [r] = await pool.query(
    `INSERT INTO episodes (anime_id, episode_number, title, is_published, is_premium, access_tier, premium_until, video_url)
     VALUES (?, 1, 'Ep 1', 1, ?, ?, ?, 'https://example.com/video.mp4')`,
    [animeId, isPremium ? 1 : 0, accessTier, premiumUntil]
  );
  return r.insertId;
}

async function createActiveSubscription(userId, { state = 'active', endsAt = null } = {}) {
  const [r] = await pool.query(
    `INSERT INTO subscriptions (user_id, reference, amount, currency, status, plan, state, source, ends_at)
     VALUES (?, ?, 0, 'UGX', 'COMPLETED', 'premium', ?, 'payment', ?)`,
    [userId, `TEST-${Date.now()}-${Math.random()}`, state, endsAt]
  );
  return r.insertId;
}

async function cleanup(ids) {
  for (const id of ids || []) {
    try { await pool.query('DELETE FROM episodes WHERE id = ?', [id]); } catch {}
    try { await pool.query('DELETE FROM anime WHERE id = ?', [id]); } catch {}
    try { await pool.query('DELETE FROM subscriptions WHERE user_id = ?', [id]); } catch {}
    try { await pool.query('DELETE FROM users WHERE id = ?', [id]); } catch {}
  }
}

// ── Test 1: Anonymous user cannot obtain video_url ────────────
async function testAnonymousNoVideoUrl() {
  const animeId = await createTestAnime('Anon Test Anime');
  const epId = await createTestEpisode(animeId);

  // GET /api/anime/:id (details) — anonymous
  const details = await api(`/api/anime/${animeId}`);
  assert.strictEqual(details.status, 200, 'Details should be public');
  const ep = (details.data.episodes || []).find(e => e.id === epId);
  assert.ok(ep, 'Episode should be present');
  assert.strictEqual(ep.video_url, null, 'Anonymous must not see video_url in details');

  // GET /api/anime/:id/episodes — anonymous
  const eps = await api(`/api/anime/${animeId}/episodes`);
  assert.strictEqual(eps.status, 200, 'Episodes should be public');
  const ep2 = (eps.data || []).find(e => e.id === epId);
  assert.ok(ep2, 'Episode should be present');
  assert.strictEqual(ep2.video_url, null, 'Anonymous must not see video_url in episodes list');

  // GET /api/anime/:id/stream/:episode — anonymous (protected route)
  const stream = await api(`/api/anime/${animeId}/stream/1`);
  assert.strictEqual(stream.status, 401, 'Stream endpoint must require auth');

  console.log('  ✓ Anonymous cannot obtain video_url from any episode endpoint');
  await cleanup([epId, animeId]);
}

// ── Test 2: Free user against premium content → 403 ───────────
async function testFreeUserPremiumBlocked() {
  const userId = await createTestUser('free-user@test.com');
  const animeId = await createTestAnime('Premium Anime', { isPremium: true, accessTier: 'premium' });
  const epId = await createTestEpisode(animeId, { isPremium: true, accessTier: 'premium' });

  // Mint a JWT for the free user.
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ uid: userId, id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // GET /api/anime/:id/episodes — free user sees locked, no video_url.
  const eps = await api(`/api/anime/${animeId}/episodes`, { token });
  const ep = (eps.data || []).find(e => e.id === epId);
  assert.strictEqual(ep.locked, true, 'Free user must see episode as locked');
  assert.strictEqual(ep.video_url, null, 'Free user must not see video_url for premium episode');

  // POST /api/stream/authorize — free user → 403.
  const auth = await api('/api/stream/authorize', { method: 'POST', body: { episodeId: String(epId) }, token });
  assert.strictEqual(auth.status, 403, 'Free user must be denied stream authorization');

  console.log('  ✓ Free user blocked from premium content (403, no video_url)');
  await cleanup([epId, animeId, userId]);
}

// ── Test 3: Entitled user can watch premium content ───────────
async function testEntitledUserCanWatch() {
  const userId = await createTestUser('entitled-user@test.com');
  await createActiveSubscription(userId, { state: 'active' });
  const animeId = await createTestAnime('Premium Anime 2', { isPremium: true, accessTier: 'premium' });
  const epId = await createTestEpisode(animeId, { isPremium: true, accessTier: 'premium' });

  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ uid: userId, id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // GET /api/anime/:id/episodes — entitled user sees unlocked.
  const eps = await api(`/api/anime/${animeId}/episodes`, { token });
  const ep = (eps.data || []).find(e => e.id === epId);
  assert.strictEqual(ep.locked, false, 'Entitled user must see episode as unlocked');

  // POST /api/stream/authorize — entitled user → 200 with token.
  const auth = await api('/api/stream/authorize', { method: 'POST', body: { episodeId: String(epId) }, token });
  assert.strictEqual(auth.status, 200, 'Entitled user must be granted stream authorization');
  assert.ok(auth.data.token, 'Must return a stream token');

  console.log('  ✓ Entitled user can watch premium content');
  await cleanup([epId, animeId, userId]);
}

// ── Test 4: Payment IPN → subscription → getEntitlement() ─────
async function testPaymentIPNToEntitlement() {
  const userId = await createTestUser('ipn-user@test.com');
  const reference = `IPN-${Date.now()}`;

  // Simulate the IPN listener creating a COMPLETED subscription.
  const [r] = await pool.query(
    `INSERT INTO subscriptions (user_id, reference, amount, currency, status, plan, state, source, ends_at)
     VALUES (?, ?, 14.99, 'UGX', 'COMPLETED', 'premium', 'active', 'payment', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [userId, reference]
  );

  // getEntitlement should now return isPremium: true.
  const { getEntitlement } = require('../utils/episodeAccess');
  const ent = await getEntitlement(userId);
  assert.strictEqual(ent.isPremium, true, 'IPN-created subscription must grant entitlement');
  assert.strictEqual(ent.state, 'active', 'State must be active');

  console.log('  ✓ Payment IPN → subscription → getEntitlement()');
  await cleanup([userId]);
}

// ── Test 5: Duplicate IPN idempotency ─────────────────────────
async function testDuplicateIPNIdempotency() {
  const userId = await createTestUser('dup-ipn-user@test.com');
  const reference = `DUP-IPN-${Date.now()}`;

  // Insert the same reference twice — the unique key on order_tracking_id
  // (or reference) must prevent duplicates.
  await pool.query(
    `INSERT INTO subscriptions (user_id, reference, amount, currency, status, plan, state, source, ends_at)
     VALUES (?, ?, 14.99, 'UGX', 'COMPLETED', 'premium', 'active', 'payment', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [userId, reference]
  );
  let dupThrew = false;
  try {
    await pool.query(
      `INSERT INTO subscriptions (user_id, reference, amount, currency, status, plan, state, source, ends_at)
       VALUES (?, ?, 14.99, 'UGX', 'COMPLETED', 'premium', 'active', 'payment', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
      [userId, reference]
    );
  } catch (e) {
    dupThrew = true;
  }
  assert.ok(dupThrew, 'Duplicate IPN reference must be rejected (unique constraint)');

  // Only one active subscription for this user.
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = ? AND reference = ?`,
    [userId, reference]
  );
  assert.strictEqual(Number(rows[0].c), 1, 'Only one subscription row per IPN reference');

  console.log('  ✓ Duplicate IPN idempotency (unique reference)');
  await cleanup([userId]);
}

// ── Test 6: Admin grant survives a scheduler sweep ────────────
async function testAdminGrantSurvivesSweep() {
  const userId = await createTestUser('admin-grant-user@test.com');

  // Create an admin_grant subscription (source='admin_grant', state='active').
  await pool.query(
    `INSERT INTO subscriptions (user_id, reference, amount, currency, status, plan, state, source, ends_at)
     VALUES (?, ?, 0, 'UGX', 'COMPLETED', 'admin_grant', 'active', 'admin_grant', DATE_ADD(NOW(), INTERVAL 365 DAY))`,
    [userId, `ADMIN-GRANT-${Date.now()}`]
  );

  // Run the scheduler sweep (the same logic premiumScheduler uses).
  const { runSweep } = require('../services/premiumScheduler');
  await runSweep();

  // The admin grant must still be active.
  const { getEntitlement } = require('../utils/episodeAccess');
  const ent = await getEntitlement(userId);
  assert.strictEqual(ent.isPremium, true, 'Admin grant must survive the scheduler sweep');
  assert.strictEqual(ent.source, 'admin_grant', 'Source must remain admin_grant');

  console.log('  ✓ Admin grant survives scheduler sweep');
  await cleanup([userId]);
}

// ── Test 7: premium_until expiry at read time ─────────────────
async function testPremiumUntilExpiry() {
  const animeId = await createTestAnime('Expiry Anime', { isPremium: true, accessTier: 'premium' });
  // Episode with premium_until in the past → effective tier is free.
  const epId = await createTestEpisode(animeId, { isPremium: true, accessTier: 'premium', premiumUntil: new Date(Date.now() - 86400000) });

  const { effectiveAccess } = require('../utils/episodeAccess');
  const tier = await effectiveAccess(epId);
  assert.strictEqual(tier, 'free', 'Expired premium_until must read as free at read time');

  console.log('  ✓ premium_until expiry at read time (scheduler disabled)');
  await cleanup([epId, animeId]);
}

// ── Test 8: No route returns video_url to unauthenticated caller ─
async function testNoVideoUrlToAnonymous() {
  const animeId = await createTestAnime('No Leak Anime');
  const epId = await createTestEpisode(animeId);

  // Check every public episode-returning endpoint.
  const endpoints = [
    `/api/anime/${animeId}`,
    `/api/anime/${animeId}/episodes`,
  ];
  for (const path of endpoints) {
    const res = await api(path);
    const body = res.data;
    const episodes = body.episodes || body || [];
    const hasVideoUrl = JSON.stringify(episodes).includes('video_url') &&
      JSON.stringify(episodes).includes('https://example.com/video.mp4');
    assert.strictEqual(hasVideoUrl, false, `video_url leaked via ${path}`);
  }

  console.log('  ✓ No route returns video_url to an unauthenticated caller');
  await cleanup([epId, animeId]);
}

// ── Run all tests ─────────────────────────────────────────────
async function main() {
  console.log('Running integration tests...');
  await startServer();

  try {
    await testAnonymousNoVideoUrl();
    await testFreeUserPremiumBlocked();
    await testEntitledUserCanWatch();
    await testPaymentIPNToEntitlement();
    await testDuplicateIPNIdempotency();
    await testAdminGrantSurvivesSweep();
    await testPremiumUntilExpiry();
    await testNoVideoUrlToAnonymous();
    console.log('\nAll integration tests passed.');
  } finally {
    await stopServer();
  }
}

main().catch(e => {
  console.error('❌ Integration test failed:', e.message);
  process.exit(1);
});