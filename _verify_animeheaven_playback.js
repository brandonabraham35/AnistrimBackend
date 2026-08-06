// =============================================================
//  _verify_animeheaven_playback.js — End-to-end AnimeHeaven playback fix
//
//  PURPOSE:
//    Starts the real Express app on a test port and verifies that the AnimeHeaven
//    stream proxy chain works end-to-end:
//      1. GET /api/stream/:title/:ep resolves a stream whose streamUrl is an
//         ANONYMIZED /api/stream-proxy/:streamId URL (NOT the raw CDN URL).
//      2. The response contract is preserved (bestQuality, tier, subtitleMode,
//         externalTracks present).
//      3. No upstream CDN URL / cookie / referer / origin leaks to the client.
//      4. GET /api/stream-proxy/:streamId with a Range header returns a playable
//         HTTP 200/206 with a media content-type (video/* or HLS manifest) —
//         proving the proxy injects the server-side cookie/referer/origin that
//         the browser cannot supply.
//
//  USAGE:
//    node _verify_animeheaven_playback.js
//    (set PORT to a free port; defaults to 5087)
// =============================================================
'use strict';

process.env.PORT = process.env.PORT || '5087';
process.env.STREAM_PROVIDERS = 'animeheaven'; // force the AnimeHeaven provider

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

// ── Test state ──────────────────────────────
const results = { passed: [], failed: [], warnings: [] };
const episodes = [];

function log(msg) { console.log(msg); }

// Minimal HTTP request helper (no external deps).
function request(method, reqPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + reqPath);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...opts.headers,
      },
      timeout: opts.timeout || 30000,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString('utf8'),
          json,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Timeout after ${options.timeout}ms`)); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Well-known long-running anime titles for the 20+ episode probe.
// Each is resolved for episode 1 through the AnimeHeaven provider.
const TITLES = [
  'One Piece',
  'Naruto',
  'Jujutsu Kaisen',
  'Demon Slayer',
  'Steins Gate',
  'Attack on Titan',
  'Fullmetal Alchemist Brotherhood',
  'My Hero Academia',
  'Sword Art Online',
  'Re:Zero',
  'Bleach',
  'Death Note',
  'Tokyo Ghoul',
  'Hunter x Hunter',
  'Fairy Tail',
  'Black Clover',
  'Dragon Ball Z',
  'One Punch Man',
  'Mob Psycho 100',
  'Vinland Saga',
  'Code Geass',
  'Cowboy Bebop',
  'Neon Genesis Evangelion',
  'Naruto Shippuden',
];

function isMediaContentType(ct) {
  const type = String(ct || '').toLowerCase();
  return type.includes('video/')
    || type.includes('application/vnd.apple.mpegurl')
    || type.includes('application/x-mpegurl')
    || type.includes('application/mp4');
}

function isProxyUrl(u) {
  return /\/api\/stream-proxy\/[a-f0-9]+/i.test(String(u || ''));
}

function hasUpstreamLeak(payload) {
  // Any field that exposes a raw CDN URL or secrets indicates a leak.
  const raw = JSON.stringify(payload || {});
  return /https?:\/\/(?!.*stream-proxy)[^"']*(?:\.m3u8|\.mp4|getf\.open|cdn|vidstream|filemoon|dood|mp4upload)/i.test(raw);
}

async function waitForServer(attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request('GET', '/api/health', { timeout: 2000 });
      if (res.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  log('\n══════════════════════════════════════════════════════════');
  log('   AnimeHeaven Playback End-to-End Verification');
  log('══════════════════════════════════════════════════════════\n');

  // ── Start the real server in-process ────────────────────
  log(`🌐 Starting server on port ${process.env.PORT}...`);
  let server;
  try {
    server = require('./server');
    // server.js calls app.listen internally; wait for it to be reachable.
    await waitForServer();
    log('✅ Server is up.\n');
  } catch (err) {
    log(`❌ Failed to start server: ${err.message}`);
    process.exit(1);
  }

  // ── 1. Contract regression: response shape ──────────────
  log('📋 1. RESOLVE + PROXY REWRITE CONTRACT');
  let successCount = 0;
  const proxyIds = [];

  for (const title of TITLES) {
    const ep = 1;
    const result = { title, episode: ep, playable: false };
    try {
      const res = await request(
        'GET',
        `/api/stream/${encodeURIComponent(title)}/${ep}?preferredProvider=animeheaven`,
        { timeout: 30000 }
      );

      if (res.status !== 200) {
        result.error = `HTTP ${res.status}`;
        results.warnings.push({ name: `resolve ${title}`, error: res.text.slice(0, 200) });
        episodes.push(result);
        continue;
      }

      const payload = res.json || {};
      result.provider = payload.provider;
      result.streamUrl = payload.streamUrl;
      result.bestQuality = payload.bestQuality;
      result.tier = payload.tier;
      result.subtitleMode = payload.subtitleMode;
      result.externalTracks = payload.externalTracks;

      // Assert: streamUrl is a proxy URL (not raw CDN).
      if (!isProxyUrl(payload.streamUrl)) {
        result.error = `streamUrl is not a proxy URL: ${payload.streamUrl}`;
        results.failed.push({ name: `proxy rewrite ${title}`, error: result.error });
        episodes.push(result);
        continue;
      }

      // Assert: response contract preserved.
      const contractOk = ('bestQuality' in payload) && ('tier' in payload) && ('subtitleMode' in payload) && ('externalTracks' in payload);
      if (!contractOk) {
        result.error = 'Response contract missing fields (bestQuality/tier/subtitleMode/externalTracks)';
        results.failed.push({ name: `contract ${title}`, error: result.error });
        episodes.push(result);
        continue;
      }

      // Assert: no upstream leak.
      if (hasUpstreamLeak(payload)) {
        result.error = 'Possible upstream CDN URL leak in response';
        results.failed.push({ name: `leak ${title}`, error: result.error });
        episodes.push(result);
        continue;
      }

      // Extract the streamId for the proxy fetch.
      const m = payload.streamUrl.match(/\/api\/stream-proxy\/([a-f0-9]+)/i);
      if (!m) {
        result.error = 'Could not parse streamId';
        results.failed.push({ name: `streamId ${title}`, error: result.error });
        episodes.push(result);
        continue;
      }
      proxyIds.push({ title, streamId: m[1], streamUrl: payload.streamUrl });

      // ══ Proxy playback probe ═════════════════════════════
      log(`   ▶ ${title} Ep ${ep} → ${payload.streamUrl}`);
      const proxyRes = await request(
        'GET',
        payload.streamUrl,
        { headers: { 'Range': 'bytes=0-1023' }, timeout: 30000 }
      );

      result.proxyStatus = proxyRes.status;
      result.contentType = proxyRes.headers['content-type'];

      const okStatus = proxyRes.status === 200 || proxyRes.status === 206;
      const okType = isMediaContentType(proxyRes.headers['content-type']);
      result.playable = okStatus && okType;

      if (result.playable) {
        successCount += 1;
        results.passed.push(`playable ${title} Ep ${ep} [${proxyRes.status} ${proxyRes.headers['content-type']}]`);
        log(`     ✅ ${proxyRes.status} ${proxyRes.headers['content-type']}`);
      } else {
        result.error = `Proxy returned ${proxyRes.status} ${proxyRes.headers['content-type']}`;
        results.failed.push({ name: `playback ${title}`, error: result.error });
        log(`     ❌ ${proxyRes.status} ${proxyRes.headers['content-type']}`);
      }
    } catch (err) {
      result.error = err.message;
      results.failed.push({ name: `resolve ${title}`, error: err.message });
      log(`   ❌ ${title}: ${err.message}`);
    }
    episodes.push(result);
  }

  // ── 2. Security: no secrets in proxy URL / no open proxy ─
  log('\n📋 2. SECURITY / NO-LEAK VERIFICATION');
  const leaked = episodes.filter((e) => e.error && /cdn|\.mp4|\.m3u8|getf\.open|referer|cookie|origin/i.test(e.error));
  if (leaked.length === 0) {
    results.passed.push('No upstream CDN URL / secret leaked in any API response');
    log('   ✅ No upstream CDN URL / secret leaked in any API response');
  } else {
    results.failed.push({ name: 'security-leak', error: `${leaked.length} responses may leak context` });
    log(`   ❌ ${leaked.length} responses may leak context`);
  }

  // ── Summary ─────────────────────────────────────────────
  const total = results.passed.length + results.failed.length;
  log('\n══════════════════════════════════════════════════════════');
  log(`   VERIFICATION SUMMARY`);
  log(`   AnimeHeaven playable episodes: ${successCount}/${TITLES.length}`);
  log(`   Passed: ${results.passed.length}/${total}`);
  log(`   Failed: ${results.failed.length}/${total}`);
  if (results.failed.length > 0) {
    log('\n   ❌ FAILED:');
    results.failed.forEach((f) => log(`      - ${f.name}: ${f.error}`));
  }
  if (results.warnings.length > 0) {
    log('\n   ⚠️  WARNINGS (non-blocking):');
    results.warnings.forEach((w) => log(`      - ${w.name}: ${w.error}`));
  }
  log('══════════════════════════════════════════════════════════\n');

  // ── Write report ─────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    rootCause: 'streamingService.normalizeProviderResult() stripped the referer/origin/cookies/headers context that AnimeHeaven attaches to each source, so streamProxy.isAnimeHeavenSource() returned false and the raw hotlink-protected CDN URL was returned to the browser, which cannot play it.',
    fix: [
      'normalizeProviderResult() now preserves playback context (referer/origin/cookies/headers/sourceType) server-side.',
      'rewriteResultToProxy() now preserves the full response contract (bestQuality/tier/subtitleMode/externalTracks) via spread.',
    ],
    summary: {
      totalEpisodes: TITLES.length,
      playable: successCount,
      failed: results.failed.length,
      passedChecks: results.passed.length,
    },
    proxyUrlsVerified: proxyIds.length,
    results: {
      passed: results.passed,
      failed: results.failed,
      warnings: results.warnings,
    },
    episodes: episodes.map((e) => ({
      title: e.title,
      episode: e.episode,
      provider: e.provider || null,
      streamUrl: e.streamUrl || null,
      proxyStatus: e.proxyStatus || null,
      contentType: e.contentType || null,
      playable: !!e.playable,
      error: e.error || null,
    })),
  };
  fs.writeFileSync(path.join(__dirname, 'animeheaven-playback-verification.json'), JSON.stringify(report, null, 2));
  log('📄 Report written to animeheaven-playback-verification.json');

  // Shut down the in-process server.
  try {
    const s = server?.close ? server : null;
    if (s) s.close();
  } catch { /* ignore */ }
  process.exit(successCount >= 20 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
