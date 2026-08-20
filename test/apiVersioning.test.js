// test/apiVersioning.test.js
// Proves both the legacy /api/* contract and the stable /api/v1/* contract
// serve identical behavior for the same resource during migration.
const assert = require('assert');
const http = require('http');
const express = require('express');

// Build a minimal app mirroring server.js mounting for both surfaces.
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Legacy surface.
app.use('/api/auth', require('../routes/authRoutes'));
app.use('/api/anime', require('../routes/animeRoutes'));
app.use('/api/stream', require('../routes/streamRoutes'));
app.use('/api/stream-proxy', require('../routes/streamProxyRoutes'));

// v1 surface (centralized router, same objects as legacy).
app.use('/api/v1', require('../routes/v1'));

let server;
let baseUrl;

async function start() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
}

async function get(path) {
  const res = await fetch(baseUrl + path, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body };
}

// Test 1: v1 version probe.
async function tVersionProbe() {
  const r = await get('/api/v1/version');
  assert.strictEqual(r.status, 200, 'v1 version probe must return 200');
  assert.strictEqual(r.body.version, 'v1');
  assert.strictEqual(r.body.status, 'stable');
  assert.ok(r.body.deprecation, 'must document legacy deprecation');
  console.log('  ✓ v1 version probe (stable contract)');
}

// Test 2: auth route parity.
async function tAuthParity() {
  const legacy = await get('/api/auth/google/client-id');
  const v1 = await get('/api/v1/auth/google/client-id');
  assert.strictEqual(legacy.status, v1.status, 'auth parity: status must match');
  assert.strictEqual(JSON.stringify(legacy.body), JSON.stringify(v1.body), 'auth parity: body must match');
  console.log('  ✓ Auth parity (/api/auth vs /api/v1/auth)');
}

// Test 3: stream surface parity (auth enforcement via POST /authorize).
async function post(path) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body };
}

async function tStreamParity() {
  const legacy = await post('/api/stream/authorize');
  const v1 = await post('/api/v1/stream/authorize');
  assert.strictEqual(legacy.status, 401, 'legacy /api/stream/authorize must 401 unauth');
  assert.strictEqual(v1.status, 401, 'v1 /api/v1/stream/authorize must 401 unauth');
  console.log('  ✓ Stream surface parity (/api/stream vs /api/v1/stream)');
}

// Test 4: stream-proxy surface parity (missing token → 401).
async function tStreamProxyParity() {
  const legacy = await get('/api/stream-proxy/does-not-exist');
  const v1 = await get('/api/v1/stream-proxy/does-not-exist');
  assert.strictEqual(legacy.status, 401, 'legacy proxy must 401 missing token');
  assert.strictEqual(v1.status, 401, 'v1 proxy must 401 missing token');
  console.log('  ✓ Stream-proxy surface parity (/api/stream-proxy vs /api/v1/stream-proxy)');
}

// Test 5: anime route parity (404 for missing).
async function tAnimeParity() {
  const legacy = await get('/api/anime/999999999');
  const v1 = await get('/api/v1/anime/999999999');
  assert.strictEqual(legacy.status, v1.status, 'anime parity: status must match');
  console.log('  ✓ Anime route parity (/api/anime vs /api/v1/anime)');
}

async function main() {
  console.log('Running API versioning migration tests...');
  await start();
  try {
    await tVersionProbe();
    await tAuthParity();
    await tStreamParity();
    await tStreamProxyParity();
    await tAnimeParity();
    console.log('\nAll API versioning migration tests passed.');
  } finally {
    await stop();
  }
}

main().catch((e) => {
  console.error('❌ API versioning test failed:', e.message);
  process.exit(1);
});