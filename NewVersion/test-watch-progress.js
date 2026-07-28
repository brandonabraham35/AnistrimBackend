// test-watch-progress.js
// Standalone test script to verify the "Resume Watching" API endpoints.
//
// Usage:
//   1. Ensure your server is running (node server.js)
//   2. Set AUTH_TOKEN below or via environment variable
//   3. Run: node test-watch-progress.js
//
// The script tests:
//   - POST /api/watch/progress (save/upsert progress)
//   - GET  /api/watch/progress/:animeId/:episodeNumber (fetch progress)
//   - UPSERT behaviour by updating progress and verifying the change

const http = require('http');

// ─── Configurable Constants ─────────────────────────────────
const BASE_URL   = process.env.BASE_URL   || 'http://localhost:5000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'YOUR_JWT_TOKEN_HERE';

const ANIME_ID        = 'jujutsu-kaisen';
const EPISODE_NUMBER  = 1;
const INITIAL_SECONDS = 120;
const UPDATED_SECONDS = 450;
const TOTAL_DURATION  = 1440;

// ─── Helper: Parse a URL into host / path / protocol ───────
function parseUrl(url) {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol,  // e.g. "http:"
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname,
  };
}

// ─── Helper: Make an HTTP request (promise-based) ──────────
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseUrl(BASE_URL);
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    const bodyStr  = body ? JSON.stringify(body) : null;

    const options = {
      hostname,
      port,
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Helper: Pretty-print a step result ────────────────────
function logStep(stepName, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${stepName}`);
  if (detail) console.log(`       → ${detail}`);
}

// ─── Main Test Runner ──────────────────────────────────────
async function runTests() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Watch History API — Resume Watching Test Suite');
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Token:  ${AUTH_TOKEN.substring(0, 20)}...`);
  console.log('═══════════════════════════════════════════════════\n');

  let allPassed = true;

  // ── Step 1: POST initial progress ────────────────────────
  console.log('[Step 1] POST /api/watch/progress (initial: 120s)');
  try {
    const res1 = await request('POST', '/api/watch/progress', {
      animeId: ANIME_ID,
      episodeNumber: EPISODE_NUMBER,
      progressSeconds: INITIAL_SECONDS,
      totalDurationSeconds: TOTAL_DURATION,
    });

    const ok = res1.status === 200 && res1.body.message === 'Progress saved successfully.';
    logStep('Save initial progress', ok, `Status ${res1.status} — ${JSON.stringify(res1.body)}`);
    if (!ok) allPassed = false;
  } catch (err) {
    logStep('Save initial progress', false, err.message);
    allPassed = false;
  }

  // ── Step 2: GET progress (expect 120) ────────────────────
  console.log('\n[Step 2] GET /api/watch/progress/jujutsu-kaisen/1 (expect 120s)');
  try {
    const res2 = await request('GET', `/api/watch/progress/${ANIME_ID}/${EPISODE_NUMBER}`);

    const actual = res2.body.progressSeconds;
    const ok = res2.status === 200 && actual === INITIAL_SECONDS;
    logStep('Fetch progress (120s)', ok, `Status ${res2.status} — progressSeconds: ${actual} (expected ${INITIAL_SECONDS})`);
    if (!ok) allPassed = false;
  } catch (err) {
    logStep('Fetch progress (120s)', false, err.message);
    allPassed = false;
  }

  // ── Step 3: POST updated progress (UPSERT to 450s) ──────
  console.log('\n[Step 3] POST /api/watch/progress (UPSERT → 450s)');
  try {
    const res3 = await request('POST', '/api/watch/progress', {
      animeId: ANIME_ID,
      episodeNumber: EPISODE_NUMBER,
      progressSeconds: UPDATED_SECONDS,
      totalDurationSeconds: TOTAL_DURATION,
    });

    const ok = res3.status === 200 && res3.body.message === 'Progress saved successfully.';
    logStep('UPSERT to 450s', ok, `Status ${res3.status} — ${JSON.stringify(res3.body)}`);
    if (!ok) allPassed = false;
  } catch (err) {
    logStep('UPSERT to 450s', false, err.message);
    allPassed = false;
  }

  // ── Step 4: GET progress (expect 450) ────────────────────
  console.log('\n[Step 4] GET /api/watch/progress/jujutsu-kaisen/1 (expect 450s)');
  try {
    const res4 = await request('GET', `/api/watch/progress/${ANIME_ID}/${EPISODE_NUMBER}`);

    const actual = res4.body.progressSeconds;
    const ok = res4.status === 200 && actual === UPDATED_SECONDS;
    logStep('Fetch progress (450s)', ok, `Status ${res4.status} — progressSeconds: ${actual} (expected ${UPDATED_SECONDS})`);
    if (!ok) allPassed = false;
  } catch (err) {
    logStep('Fetch progress (450s)', false, err.message);
    allPassed = false;
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('═══════════════════════════════════════════════════\n');

  process.exit(allPassed ? 0 : 1);
}

runTests();

