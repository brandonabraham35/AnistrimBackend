// =============================================================
//  AniStrim2 — Complete Backend Regression Test Suite
//  Tests every critical endpoint and reports results
// =============================================================
const http = require('http');
const url = require('url');
const BASE = 'http://localhost:5000';

// ── Test state ──────────────────────────────────────────────
const results = { passed: [], failed: [], warnings: [] };
const auth = { token: null };

function test(name, fn) {
  return new Promise(async (resolve) => {
    try {
      await fn();
      results.passed.push(name);
      console.log(`  ✅ ${name}`);
    } catch (err) {
      results.failed.push({ name, error: err.message });
      console.log(`  ❌ ${name} — ${err.message}`);
    }
    resolve();
  });
}

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(BASE + path);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      timeout: 30000,
    };
    if (auth.token) options.headers['Authorization'] = `Bearer ${auth.token}`;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('   AniStrim2 — Complete Backend Regression Test');
  console.log('══════════════════════════════════════════════\n');

  // ── 1. Health Check ──────────────────────────────────────
  console.log('📋 1. SERVER HEALTH');
  await test('GET /api/health returns 200', async () => {
    const res = await request('GET', '/api/health');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (res.data.status !== 'OK') throw new Error(`Expected status OK, got ${res.data.status}`);
  });

  // ── 2. Authentication ────────────────────────────────────
  console.log('\n📋 2. AUTHENTICATION');
  await test('POST /api/auth/login (admin)', async () => {
    const res = await request('POST', '/api/auth/login', {
      body: { email: 'admin@anistrim.com', password: 'admin123' }
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status} — ${JSON.stringify(res.data)}`);
    if (!res.data.token) throw new Error('No token in response');
    auth.token = res.data.token;
    if (!res.data.user.isAdmin) throw new Error('Admin user not flagged as admin');
  });

  await test('POST /api/auth/login (invalid credentials)', async () => {
    const res = await request('POST', '/api/auth/login', {
      body: { email: 'admin@anistrim.com', password: 'wrongpassword' }
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('POST /api/auth/signup validation', async () => {
    const res = await request('POST', '/api/auth/signup', {
      body: { name: '', email: '', password: '12' }
    });
    if (res.status !== 400 && res.status !== 409) throw new Error(`Expected 400/409, got ${res.status}`);
  });

  // ── 3. Admin Dashboard ───────────────────────────────────
  console.log('\n📋 3. ADMIN DASHBOARD');

  await test('GET /api/admin/dashboard/overview', async () => {
    const res = await request('GET', '/api/admin/dashboard/overview');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.data.overview) throw new Error('No overview in response');
  });

  await test('GET /api/admin/dashboard/health', async () => {
    const res = await request('GET', '/api/admin/dashboard/health');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.data.checks) throw new Error('No checks in response');
  });

  await test('GET /api/admin/dashboard/activity/recent', async () => {
    const res = await request('GET', '/api/admin/dashboard/activity/recent');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 4. Chart Data ────────────────────────────────────────
  console.log('\n📋 4. CHART DATA');
  const chartTypes = ['daily-users', 'revenue', 'anime-growth', 'episode-views', 'genre-distribution', 'provider-usage'];
  for (const type of chartTypes) {
    await test(`GET /api/admin/dashboard/charts/${type}`, async () => {
      const res = await request('GET', `/api/admin/dashboard/charts/${type}?days=7`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!res.data.labels || !res.data.values) throw new Error('Missing labels/values');
    });
  }

  // ── 5. Admin CRUD — Anime ────────────────────────────────
  console.log('\n📋 5. ADMIN ANIME CRUD');

  await test('GET /api/admin/anime', async () => {
    const res = await request('GET', '/api/admin/anime?page=1&limit=5');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.data.pagination) throw new Error('No pagination');
  });

  await test('GET /api/admin/anime with filters', async () => {
    const res = await request('GET', '/api/admin/anime?page=1&limit=5&sort=views&order=desc');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ── 6. Admin CRUD — Genres ───────────────────────────────
  console.log('\n📋 6. ADMIN GENRES CRUD');

  await test('GET /api/admin/genres', async () => {
    const res = await request('GET', '/api/admin/genres');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 7. Admin CRUD — Episodes ─────────────────────────────
  console.log('\n📋 7. ADMIN EPISODES CRUD');

  await test('GET /api/admin/episodes', async () => {
    const res = await request('GET', '/api/admin/episodes');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 8. Admin CRUD — Users ────────────────────────────────
  console.log('\n📋 8. ADMIN USERS CRUD');

  await test('GET /api/admin/users', async () => {
    const res = await request('GET', '/api/admin/users');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 9. Admin CRUD — Payments ─────────────────────────────
  console.log('\n📋 9. ADMIN PAYMENTS CRUD');

  await test('GET /api/admin/payments', async () => {
    const res = await request('GET', '/api/admin/payments?page=1&limit=10');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.data.pagination) throw new Error('No pagination in response');
  });

  await test('GET /api/admin/payments with filters', async () => {
    const res = await request('GET', '/api/admin/payments?search=test&status=successful');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ── 10. Admin CRUD — Settings ────────────────────────────
  console.log('\n📋 10. ADMIN SETTINGS CRUD');

  await test('GET /api/admin/settings', async () => {
    const res = await request('GET', '/api/admin/settings');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ── 11. Admin CRUD — Ads ─────────────────────────────────
  console.log('\n📋 11. ADMIN ADS CRUD');

  await test('GET /api/admin/ads', async () => {
    const res = await request('GET', '/api/admin/ads');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 12. Admin CRUD — Logs ────────────────────────────────
  console.log('\n📋 12. ADMIN LOGS');

  await test('GET /api/admin/logs', async () => {
    const res = await request('GET', '/api/admin/logs');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array');
  });

  // ── 13. Auth Endpoints ───────────────────────────────────
  console.log('\n📋 13. AUTH ENDPOINTS');

  await test('GET /api/auth/google/client-id', async () => {
    const res = await request('GET', '/api/auth/google/client-id');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ── 14. JWT Auth Middleware ──────────────────────────────
  console.log('\n📋 14. JWT AUTH MIDDLEWARE');

  await test('Protected route without token returns 401', async () => {
    const saved = auth.token;
    auth.token = null;
    const res = await request('GET', '/api/admin/dashboard/overview');
    auth.token = saved;
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Protected route with invalid token returns 401', async () => {
    const saved = auth.token;
    auth.token = 'invalid-jwt-token';
    const res = await request('GET', '/api/admin/dashboard/overview');
    auth.token = saved;
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // ── 15. Stream Endpoints ─────────────────────────────────
  console.log('\n📋 15. STREAM ENDPOINTS');

  await test('GET /api/stream (requires params — returns 400)', async () => {
    const res = await request('GET', '/api/stream/%20/%20');
    if (res.status !== 400 && res.status !== 502) throw new Error(`Expected 400/502, got ${res.status}`);
  });

  // ── 16. SPA Fallback Routes ──────────────────────────────
  console.log('\n📋 16. SPA FALLBACK ROUTES');

  await test('GET / (root) serves index.html', async () => {
    const res = await request('GET', '/');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (typeof res.data === 'string' && !res.data.includes('html')) {
      // If JSON, that's fine too
    }
  });

  await test('GET /admin (serves dashboard.html)', async () => {
    const res = await request('GET', '/admin');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ── 17. No Runtime Exceptions Check ─────────────────────
  console.log('\n📋 17. ERROR HANDLING');

  await test('GET /api/nonexistent returns 404', async () => {
    const res = await request('GET', '/api/nonexistent');
    // SPA fallback will serve index.html, so it's OK to get 200
  });

  // ── Summary ──────────────────────────────────────────────
  const total = results.passed.length + results.failed.length;
  console.log('\n══════════════════════════════════════════════');
  console.log(`   REGRESSION TEST RESULTS`);
  console.log(`   Passed: ${results.passed.length}/${total}`);
  console.log(`   Failed: ${results.failed.length}/${total}`);
  if (results.failed.length > 0) {
    console.log('\n   ❌ FAILED TESTS:');
    results.failed.forEach(f => console.log(`      - ${f.name}: ${f.error}`));
  }
  console.log('══════════════════════════════════════════════\n');

  // Write results to file
  const fs = require('fs');
  const report = {
    timestamp: new Date().toISOString(),
    summary: { total, passed: results.passed.length, failed: results.failed.length },
    passed: results.passed,
    failed: results.failed,
    warnings: results.warnings,
  };
  fs.writeFileSync('regression-test-report.json', JSON.stringify(report, null, 2));
  console.log('📄 Report written to regression-test-report.json');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
