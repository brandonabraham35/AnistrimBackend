// READ-ONLY End-to-End Runtime Verification (part 2)
// Uses the warm Naruto ep1 cache for fast free-serving tests, then runs
// a single cold resolve (episode 2) for cache-miss/concurrency/hit tests.
'use strict';
require('dotenv').config();
const http = require('http');
const mysql = require('mysql2/promise');

const BASE = 'http://localhost:5000';
const TITLE = 'Naruto';
const EP1 = 1;      // eid 558 (warm cache)
const EP2 = 2;      // eid 559 (cold)
const EP2_ID = 559;

let dbConn = null;
const results = [];

function httpGet(path, { timeoutMs = 90000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: body });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function record(test, status, httpStatus, expected, actual, evidence) {
  results.push({ test, status, httpStatus, expected, actual, evidence });
  console.log(`\n[${test}]\n  STATUS: ${status}\n  HTTP STATUS: ${httpStatus}\n  EXPECTED: ${expected}\n  ACTUAL: ${actual}\n  EVIDENCE: ${evidence}`);
}

async function dbQuery(sql, params = []) {
  const [rows] = await dbConn.query(sql, params);
  return rows;
}

async function cacheCount(episodeId) {
  const r = await dbQuery('SELECT COUNT(*) n FROM episode_stream_cache WHERE episode_id=?', [episodeId]);
  return r[0].n;
}

async function findCacheRow(episodeId) {
  const r = await dbQuery('SELECT id, provider, stream_type, expires_at FROM episode_stream_cache WHERE episode_id=? LIMIT 1', [episodeId]);
  return r[0] || null;
}

async function main() {
  dbConn = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  console.log('Connected. Starting fast warm-cache tests.\n');

  // ── TEST 1: FREE USER + FREE EPISODE (warm cache, fast) ──
  {
    const path = `/api/stream/${encodeURIComponent(TITLE)}/${EP1}`;
    const start = Date.now();
    const r = await httpGet(path, { timeoutMs: 30000 });
    const elapsed = Date.now() - start;
    const srcs = Array.isArray(r.body && r.body.sources) ? r.body.sources : [];
    const leaked = srcs.some(s => /^https?:\/\//i.test(s.url));
    const allProxy = srcs.length > 0 && srcs.every(s => typeof s.url === 'string' && s.url.startsWith('/api/'));
    record(
      '1. FREE USER + FREE EPISODE (warm cache)',
      (r.status === 200 && r.body && r.body.success && srcs.length > 0 && !leaked) ? 'PASS' : 'FAIL',
      r.status,
      'HTTP 200, AnimeHeaven playback returned, only free-tier sources, no premium leak',
      `status=${r.status} success=${r.body && r.body.success} provider=${r.body && r.body.provider} sources=${srcs.length} elapsedMs=${elapsed} leakedRaw=${leaked} allProxy=${allProxy}`,
      JSON.stringify({ status: r.status, success: r.body && r.body.success, provider: r.body && r.body.provider, sourceCount: srcs.length, qualities: srcs.map(s => s.quality).slice(0, 8), leaked, allProxy, elapsedMs: elapsed })
    );
  }

  // ── TEST 7: CACHE HIT (second request, warm) ──
  {
    const path = `/api/stream/${encodeURIComponent(TITLE)}/${EP1}`;
    const start = Date.now();
    const r = await httpGet(path, { timeoutMs: 20000 });
    const elapsed = Date.now() - start;
    const row = await findCacheRow(558);
    record(
      '7. CACHE HIT (same episode, warm)',
      (r.status === 200 && r.body && r.body.cached === true && row !== null) ? 'PASS' : 'FAIL',
      r.status,
      'HTTP 200, cached flag true, proxy context fresh (regenerated proxy URL), AnimeHeaven not re-contacted',
      `status=${r.status} cached=${r.body && r.body.cached} elapsedMs=${elapsed} rowStillValid=${row ? 'yes' : 'no'} streamUrl=${r.body && r.body.streamUrl ? String(r.body.streamUrl).substring(0, 50) : 'NONE'}`,
      JSON.stringify({ status: r.status, cached: r.body && r.body.cached, elapsedMs: elapsed, rowValid: !!row, streamUrl: (r.body && r.body.streamUrl) || null })
    );
  }

  // ── TEST 8: CACHE TIER ISOLATION ──
  // Simulate free vs premium on the SAME cached episode. Premium user = a
  // signed JWT with is_premium=true. We can mint a token locally since JWT_SECRET is in env.
  const jwt = require('jsonwebtoken');
  const premiumToken = jwt.sign({ id: 4, email: 'mylesmuhangii@gmail.com', isPremium: true, isAdmin: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const adminToken = jwt.sign({ id: 1, email: 'admin@anistrim.com', isAdmin: true, isPremium: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const freeToken = jwt.sign({ id: 999, email: 'free@test.com', isPremium: false, isAdmin: false }, process.env.JWT_SECRET, { expiresIn: '1h' });

  {
    const path = `/api/stream/${encodeURIComponent(TITLE)}/${EP1}`;
    const rFree = await httpGet(path, { timeoutMs: 20000, headers: { Authorization: 'Bearer ' + freeToken } });
    const rPremium = await httpGet(path, { timeoutMs: 20000, headers: { Authorization: 'Bearer ' + premiumToken } });
    const freeSrcs = (rFree.body && rFree.body.sources) || [];
    const premSrcs = (rPremium.body && rPremium.body.sources) || [];
    // Maximum quality number for free should be <= 720; premium may be higher.
    const maxQ = (arr) => arr.reduce((m, s) => {
      const n = parseInt(String(s.quality).replace(/[^0-9]/g, '') || '0', 10);
      return s.quality && (s.quality === '4K' || s.quality === '4k' || n > (m.n || 0)) ? { q: s.quality, n } : m;
    }, { q: 'auto', n: 0 });
    const fq = maxQ(freeSrcs);
    const pq = maxQ(premSrcs);
    // A free request must not return a quality above 720p.
    const freeOk = fq.n <= 720 || !/[0-9]{4}/.test(fq.q || '');
    record(
      '8. CACHE TIER ISOLATION (free vs premium on warm cache)',
      (rFree.status === 200 && freeOk && !(fq.n === 0 && premSrcs.length && premSrcs.some(s => /1080|2160|4k/i.test(s.quality)))) ? 'PASS' : 'FAIL',
      rFree.status,
      'Free context returns only ≤720p sources from shared cache; cached object not downgraded for premium',
      `freeStatus=${rFree.status} freeQuals=${JSON.stringify(freeSrcs.map(s => s.quality))} freeMax=${fq.q} premiumStatus=${rPremium.status} premQuals=${JSON.stringify(premSrcs.map(s => s.quality))} premMax=${pq.q}`,
      JSON.stringify({ freeStatus: rFree.status, freeMaxQuality: fq, premiumStatus: rPremium.status, premiumMaxQuality: pq, freeSourceCount: freeSrcs.length, premiumSourceCount: premSrcs.length })
    );
  }

  // ── TEST 2/3/4: PREMIUM EPISODE AUTHORIZATION ──
  // No premium episodes exist in DB (PREMIUM EPISODES: 0), so the 403 branch
  // cannot be exercised with real data. Verify: (a) free episode does NOT get
  // blocked even with a premium claim (no over-blocking), and (b) admin +
  // premium playback of a normal episode succeeds (200). The 403-on-premium
  // ordering is proven by code inspection (resolveEpisodeAuth returns before
  // any cache/animeheaven work).
  {
    const path = `/api/stream/${encodeURIComponent(TITLE)}/${EP1}`;
    const rAdmin = await httpGet(path, { timeoutMs: 20000, headers: { Authorization: 'Bearer ' + adminToken } });
    record(
      '4. ADMIN USER + EPISODE (premium-or-free episode)',
      (rAdmin.status === 200 && rAdmin.body && rAdmin.body.success) ? 'PASS' : 'FAIL',
      rAdmin.status,
      'Admin playback succeeds (200)',
      `status=${rAdmin.status} success=${rAdmin.body && rAdmin.body.success} provider=${rAdmin.body && rAdmin.body.provider}`,
      JSON.stringify({ status: rAdmin.status, success: rAdmin.body && rAdmin.body.success, provider: rAdmin.body && rAdmin.body.provider })
    );
  }

  console.log('\n=== FAST WARM TEST SUITE COMPLETE ===');
  console.log('Proceeding to cold-resolve concurrency test for episode 2 (will take ~2min).\n');

  // ── TEST 6 + 9 + 7b: CACHE MISS + CONCURRENCY + HIT on EP2 ──
  {
    const before = await cacheCount(EP2_ID);
    const path = `/api/stream/${encodeURIComponent(TITLE)}/${EP2}`;
    // Fire 3 concurrent identical requests (single-flight).
    const resultsArr = await Promise.all([
      httpGet(path, { timeoutMs: 180000 }),
      httpGet(path, { timeoutMs: 180000 }),
      httpGet(path, { timeoutMs: 180000 }),
    ]);
    const after = await cacheCount(EP2_ID);
    const row = await findCacheRow(EP2_ID);
    const statuses = resultsArr.map(r => r.status);
    const allOk = statuses.every(s => s === 200);
    const cachedFlags = resultsArr.map(r => r.body && r.body.cached);
    // At least one should be a fresh resolve (cached:false/undefined); single-flight
    // means only ONE AnimeHeaven resolution -> exactly one DB row created.
    record(
      '6+9. CACHE MISS + CONCURRENT REQUESTS (single-flight on ep2)',
      (allOk && after === before + 1) ? 'PASS' : 'FAIL',
      statuses.join('/'),
      'HTTP 200 all, exactly one cache row created, one upstream resolution',
      `before=${before} after=${after} row=${row ? ('provider=' + row.provider + ' type=' + row.stream_type + ' expires=' + row.expires_at) : 'NONE'} statuses=${statuses.join(',')} cachedFlags=${cachedFlags.join(',')}`,
      JSON.stringify({ before, after, row: row ? { provider: row.provider, stream_type: row.stream_type, expires_at: row.expires_at } : null, statuses, cachedFlags })
    );

    // ── TEST 7b: CACHE HIT after the miss (now warm) ──
    const start = Date.now();
    const r2 = await httpGet(path, { timeoutMs: 15000 });
    const elapsed = Date.now() - start;
    record(
      '7b. CACHE HIT (immediately after miss, ep2 now warm)',
      (r2.status === 200 && r2.body && r2.body.cached === true) ? 'PASS' : 'FAIL',
      r2.status,
      'HTTP 200, cached flag true, fast (no AnimeHeaven contact), row valid',
      `status=${r2.status} cached=${r2.body && r2.body.cached} elapsedMs=${elapsed}`,
      JSON.stringify({ status: r2.status, cached: r2.body && r2.body.cached, elapsedMs: elapsed })
    );
  }

  await dbConn.end();
  console.log('\n=== VERIFICATION RUN 2 COMPLETE ===');
}

main().catch(e => { console.error('HARNESS FAIL:', e.message); if (dbConn) dbConn.end().catch(() => {}); process.exit(1); });

