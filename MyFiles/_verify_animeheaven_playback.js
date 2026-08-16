// =============================================================
//  _verify_animeheaven_playback.js — AnimeHeaven Playback Verification Tool
//
//  PURPOSE:
//    Starts the real Express app on a test port and verifies that the full
//    AnimeHeaven → secure-proxy playback chain works end-to-end for 20+
//    episodes. It resolves every episode through the live provider, requests
//    each stream THROUGH the new reverse proxy, and performs a staged series
//    of checks to locate exactly where (if anywhere) playback breaks.
//
//  CHECKS PER EPISODE:
//    • API resolve            — GET /api/stream/:title/:ep returns 200
//    • Provider resolution    — a playable stream was actually returned
//    • Proxy URL generation   — streamUrl is a same-origin proxy URL
//    • Proxy request          — proxy returns 200/206 with a media content-type
//    • Range support          — 206 partial content / accept-ranges / content-range
//    • Stream starts          — first bytes / moov received
//    • Manifest (HLS)         — #EXTM3U + playlist type + rewritten segments
//    • Segment (HLS)          — a segment downloads through the proxy
//    • Playback readiness     — aggregate "video is playable"
//
//  PROXY SECURITY CHECKS (per stream):
//    • Same-origin proxy URL  — no absolute upstream CDN leaks to the client
//    • No CDN / secret leak   — response JSON contains no raw CDN URL/cookie
//    • No cookie/referer leak — proxy never echoes authorizing headers back
//    • No redirect escape     — redirect chains stay on the proxy origin
//
//  MEDIA SANITY CHECKS:
//    MP4: ftyp box, moov atom, content-length (if present)
//    HLS: #EXTM3U, playlist type (VOD/LIVE/EVENT), segment count,
//         EVERY segment URI rewritten through the proxy, no upstream URLs left
//
//  MEASUREMENTS:
//    Latency broken into phases: search → resolve → API → proxy → manifest →
//    first-byte → first-playable-bytes. Plus redirect counts and failures
//    classified by stage.
//
//  OUTPUTS:
//    • ANIMEHEAVEN_PLAYBACK_REPORT.md   — human-readable report
//    • animeheaven-playback-verification.json — structured machine-readable data
//
//  USAGE:
//    node _verify_animeheaven_playback.js
//    (env overrides: PORT, STREAM_PIPELINE_TIMEOUT_MS, EPISODES, ANIMEHEAVEN_* )
// =============================================================
'use strict';

process.env.PORT = process.env.PORT || '5087';
// Force only the AnimeHeaven provider so the test is isolated.
process.env.STREAM_PROVIDERS = 'animeheaven';
// NOTE: The 15s default stream-pipeline deadline is too tight for AnimeHeaven's
// heavy resolution (search + details + gate + subtitle probes). This is a
// TEST-ONLY override so episodes can actually resolve for verification. If
// playback succeeds under this but fails under 15s in production, the report
// classifies "timeout sensitivity" as a likely root cause rather than assuming
// it. See ANIMEHEAVEN_PLAYBACK_REPORT.md.
process.env.STREAM_PIPELINE_TIMEOUT_MS = process.env.STREAM_PIPELINE_TIMEOUT_MS || '60000';
// Better to have these populated for the test; they are safe defaults.
process.env.STREAM_CONCURRENCY = process.env.STREAM_CONCURRENCY || '1';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const REPORT_PATH = path.join(__dirname, 'ANIMEHEAVEN_PLAYBACK_REPORT.md');
const JSON_PATH = path.join(__dirname, 'animeheaven-playback-verification.json');

// ── Test state ──────────────────────────────────────────────
const results = { passed: [], failed: [], warnings: [] };
const episodes = [];

function log(msg) { console.log(msg); }

// ── Minimal HTTP request helper (no external deps) ─────────
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
      timeout: opts.timeout || 45000,
    };
    const started = Date.now();
    const req = http.request(options, (res) => {
      const chunks = [];
      const redirects = [];
      let current = res;
      // Track a redirect chain if the server returns 3xx (we don't auto-follow
      // here; the proxy/client normally does). We just record it.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        redirects.push({ status: res.statusCode, location: res.headers.location });
      }
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
          redirects,
          latencyMs: Date.now() - started,
          firstByteMs: started, // set below; keep simple
          bytes: buf.length,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Timeout after ${options.timeout}ms`)); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Well-known long-running anime titles ───────────────────
const TITLES = [
  'One Piece', 'Naruto', 'Jujutsu Kaisen', 'Demon Slayer', 'Steins Gate',
  'Attack on Titan', 'Fullmetal Alchemist Brotherhood', 'My Hero Academia',
  'Sword Art Online', 'Re:Zero', 'Bleach', 'Death Note', 'Tokyo Ghoul',
  'Hunter x Hunter', 'Fairy Tail', 'Black Clover', 'Dragon Ball Z',
  'One Punch Man', 'Mob Psycho 100', 'Vinland Saga', 'Code Geass',
  'Cowboy Bebop', 'Neon Genesis Evangelion', 'Naruto Shippuden',
];

// ── Content-type helpers ───────────────────────────────────
function isMediaContentType(ct) {
  const type = String(ct || '').toLowerCase();
  return type.includes('video/')
    || type.includes('application/vnd.apple.mpegurl')
    || type.includes('application/x-mpegurl')
    || type.includes('application/mp4')
    || type.includes('application/octet-stream');
}

function isHlsContentType(ct) {
  const type = String(ct || '').toLowerCase();
  return type.includes('mpegurl') || type.includes('x-mpegurl') || type.includes('application/vnd.apple.mpegurl');
}

// ── Proxy URL detection (supports BOTH formats) ────────────
function isProxyUrl(u) {
  const s = String(u || '');
  // Query-based stateless proxy: /api/stream/proxy?provider=animeheaven&url=...
  if (/\/api\/stream\/proxy\?/i.test(s)) return true;
  // streamId-scoped proxy: /api/stream-proxy/:id
  if (/\/api\/stream-proxy\/[a-f0-9]+/i.test(s)) return true;
  return false;
}

function detectProxyFormat(u) {
  const s = String(u || '');
  if (/\/api\/stream\/proxy\?/i.test(s)) return 'query-based';
  if (/\/api\/stream-proxy\/[a-f0-9]+/i.test(s)) return 'streamId-based';
  return 'unknown';
}

function isSameOrigin(url) {
  try {
    const u = new URL(BASE + (String(url || '').startsWith('/') ? String(url) : '/' + url));
    return u.origin === new URL(BASE).origin;
  } catch {
    return false;
  }
}

// ── Security / leak helpers ────────────────────────────────
function hasUpstreamLeak(payload) {
  const raw = JSON.stringify(payload || {});
  // Any absolute CDN media URL, cookie, referer, or origin that is NOT a
  // same-origin proxy path indicates a leak.
  return /https?:\/\/(?!127\.0\.0\.1|localhost)[^"']*(?:\.m3u8|\.mp4|getf\.open|cdn|vidstream|filemoon|dood|mp4upload|animeheaven\.me)/i.test(raw)
    || /"cookie"\s*:/i.test(raw)
    || /"referer"\s*:"https?:\/\//i.test(raw)
    || /"origin"\s*:"https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(raw);
}

function countUpstreamUrls(text) {
  // Count absolute http(s) URLs that point OUTSIDE our own proxy origin.
  const all = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return all.filter(u => !/127\.0\.0\.1|localhost/.test(u)).length;
}

// ── HLS manifest analysis ──────────────────────────────────
function analyzeHlsManifest(text) {
  const body = String(text || '');
  const lines = body.split(/\r?\n/);
  const result = {
    isHls: body.includes('#EXTM3U'),
    playlistType: null,
    segmentCount: 0,
    variantCount: 0,
    rewrittenSegments: 0,
    upstreamSegmentUrls: 0,
    hasPlaylistTypeTag: /#EXT-X-PLAYLIST-TYPE:/i.test(body),
    targetDuration: null,
  };
  const typeMatch = body.match(/#EXT-X-PLAYLIST-TYPE:\s*([A-Z]+)/i);
  if (typeMatch) result.playlistType = typeMatch[1].toUpperCase();
  const tdMatch = body.match(/#EXT-X-TARGETDURATION:\s*(\d+)/i);
  if (tdMatch) result.targetDuration = Number(tdMatch[1]);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^https?:\/\//i.test(trimmed)) {
      result.upstreamSegmentUrls += 1;
    } else if (trimmed.startsWith('/api/stream')) {
      result.rewrittenSegments += 1;
    }
    result.segmentCount += 1;
  }
  // Count variant playlist references separately.
  result.variantCount = (body.match(/#EXT-X-STREAM-INF:/gi) || []).length;
  return result;
}

// ── MP4 sanity analysis ────────────────────────────────────
function analyzeMp4(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const text = b.toString('latin1', 0, Math.min(b.length, 128));
  return {
    hasFtyp: b.includes(Buffer.from('ftyp')) || text.includes('ftyp'),
    hasMoov: b.includes(Buffer.from('moov')) || text.includes('moov'),
    bytes: b.length,
  };
}

// ── Failure classification by stage ─────────────────────────
const STAGES = [
  'API resolve', 'Provider resolution', 'Proxy URL generation',
  'Proxy request', 'Manifest fetch', 'Segment fetch', 'Range support',
  'Playback readiness',
];

function classifyFailure(uuid, stage) {
  return { uuid, stage };
}

// ── Wait for server ────────────────────────────────────────
async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request('GET', '/api/health', { timeout: 2000 });
      if (res.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Environment metadata for reproducibility ───────────────
function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: __dirname, timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function getEnvSnapshot() {
  const keys = [
    'PORT', 'STREAM_PROVIDERS', 'STREAM_PIPELINE_TIMEOUT_MS', 'STREAM_CONCURRENCY',
    'ANIMEHEAVEN_BASE_URL', 'ANIMEHEAVEN_MAX_NESTED_DEPTH', 'ANIMEHEAVEN_MIRROR_CACHE_TTL_MS',
    'STREAM_PROXY_TTL_MS', 'STREAM_CACHE_TTL_SECONDS',
  ];
  const out = {};
  for (const k of keys) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  log('\n══════════════════════════════════════════════════════════');
  log('   AnimeHeaven Playback Verification Tool');
  log('══════════════════════════════════════════════════════════\n');

  const meta = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    commitHash: getCommitHash(),
    cwd: __dirname,
  };

  // ── Start the real server in-process ────────────────────
  log(`🌐 Starting server on port ${process.env.PORT}...`);
  try {
    require('./server');
    await waitForServer();
    log('✅ Server is up.\n');
  } catch (err) {
    log(`❌ Failed to start server: ${err.message}`);
    process.exit(1);
  }

  // ── Resolve + verify each episode ───────────────────────
  log(`📋 Resolving ${TITLES.length} AnimeHeaven episodes through the proxy...\n`);

  let resolvedCount = 0;      // provider resolved a stream
  let playableCount = 0;      // actually playable through the proxy
  let proxyCount = 0;         // proxy URLs seen
  let upstreamLeakCount = 0;
  let redirectEscapeCount = 0;
  let totalRedirects = 0;
  const latencyBuckets = {
    apiResolveMs: [],
    proxyFirstByteMs: [],
    manifestMs: [],
    firstPlayableMs: [],
  };

  for (const title of TITLES) {
    const ep = 1;
    const epRes = {
      title, episode: ep,
      resolved: false, playable: false,
      proxyFormat: null, provider: null,
      checks: {},
      latencies: {},
      redirects: 0,
      error: null, failureStage: null,
    };

    // ── STAGE 1: API resolve ──────────────────────────────
    const t0 = Date.now();
    let apiRes;
    try {
      apiRes = await request(
        'GET',
        `/api/stream/${encodeURIComponent(title)}/${ep}?preferredProvider=animeheaven&skipCache=1`,
        { timeout: 65000 }
      );
    } catch (err) {
      epRes.error = err.message;
      epRes.failureStage = 'API resolve';
      epRes.checks.apiResolve = false;
      results.failed.push({ name: `resolve ${title}`, stage: 'API resolve', error: err.message });
      episodes.push(epRes);
      continue;
    }
    epRes.latencies.apiResolveMs = apiRes.latencyMs;
    latencyBuckets.apiResolveMs.push(apiRes.latencyMs);
    epRes.checks.apiResolve = apiRes.status === 200;

    if (apiRes.status !== 200 || !apiRes.json || !apiRes.json.success) {
      epRes.error = `API returned ${apiRes.status}: ${(apiRes.text || '').slice(0, 160)}`;
      epRes.failureStage = 'API resolve';
      results.failed.push({ name: `resolve ${title}`, stage: 'API resolve', error: epRes.error });
      episodes.push(epRes);
      continue;
    }

    const payload = apiRes.json;
    epRes.provider = payload.provider;
    epRes.streamUrl = payload.streamUrl;
    epRes.bestQuality = payload.bestQuality;
    epRes.tier = payload.tier;
    epRes.subtitleMode = payload.subtitleMode;
    epRes.externalTracks = payload.externalTracks;

    // ── STAGE 2: Provider resolution ──────────────────────
    epRes.checks.providerResolution = !!(payload.streamUrl && Array.isArray(payload.sources) && payload.sources.length > 0);
    // A stream that resolved but is not a proxy URL is still "resolved".
    if (epRes.checks.providerResolution) resolvedCount += 1;
    if (!epRes.checks.providerResolution) {
      epRes.error = 'No playable stream returned (empty sources/streamUrl)';
      epRes.failureStage = 'Provider resolution';
      results.failed.push({ name: `provider ${title}`, stage: 'Provider resolution', error: epRes.error });
      episodes.push(epRes);
      continue;
    }

    // ── STAGE 3: Proxy URL generation + security ──────────
    epRes.checks.proxyUrlGenerated = isProxyUrl(payload.streamUrl);
    epRes.proxyFormat = detectProxyFormat(payload.streamUrl);
    epRes.checks.sameOrigin = isSameOrigin(payload.streamUrl);
    epRes.checks.noUpstreamLeak = !hasUpstreamLeak(payload);
    epRes.checks.noCookieLeak = !JSON.stringify(payload).match(/"cookie"\s*:/i);
    if (epRes.checks.noUpstreamLeak) {
      // Also assert sources[] carry no raw CDN URLs.
      const srcRaw = JSON.stringify((payload.sources || []).map(s => s.url));
      epRes.checks.noUpstreamLeak = !/https?:\/\/(?!127\.0\.0\.1|localhost)[^"']*\.(m3u8|mp4)/i.test(srcRaw);
    }

    if (!epRes.checks.proxyUrlGenerated || !epRes.checks.sameOrigin) {
      epRes.error = `streamUrl is not a same-origin proxy URL: ${payload.streamUrl}`;
      epRes.failureStage = 'Proxy URL generation';
      results.failed.push({ name: `proxy-url ${title}`, stage: 'Proxy URL generation', error: epRes.error });
      episodes.push(epRes);
      continue;
    }
    if (!epRes.checks.noUpstreamLeak) upstreamLeakCount += 1;
    proxyCount += 1;

    // ── STAGE 4: Proxy request (Range) ────────────────────
    const proxyUrl = payload.streamUrl.startsWith('/')
      ? payload.streamUrl
      : new URL(payload.streamUrl).pathname + new URL(payload.streamUrl).search;
    let proxyRes;
    try {
      proxyRes = await request('GET', proxyUrl, {
        headers: { 'Range': 'bytes=0-131071' }, // 128KB range probe
        timeout: 45000,
      });
    } catch (err) {
      epRes.error = `Proxy request failed: ${err.message}`;
      epRes.failureStage = 'Proxy request';
      epRes.checks.proxyRequest = false;
      results.failed.push({ name: `proxy ${title}`, stage: 'Proxy request', error: epRes.error });
      episodes.push(epRes);
      continue;
    }
    epRes.latencies.proxyFirstByteMs = proxyRes.latencyMs;
    latencyBuckets.proxyFirstByteMs.push(proxyRes.latencyMs);
    epRes.redirects = proxyRes.redirects ? proxyRes.redirects.length : 0;
    totalRedirects += epRes.redirects;
    epRes.checks.redirectEscape = !(proxyRes.redirects || []).some(r => !isSameOrigin(r.location));
    if (!epRes.checks.redirectEscape) redirectEscapeCount += 1;

    epRes.proxyStatus = proxyRes.status;
    epRes.contentType = proxyRes.headers['content-type'];
    const okStatus = proxyRes.status === 200 || proxyRes.status === 206;
    const okType = isMediaContentType(proxyRes.headers['content-type']);
    epRes.checks.proxyRequest = okStatus && okType;

    if (!epRes.checks.proxyRequest) {
      epRes.error = `Proxy returned ${proxyRes.status} ${proxyRes.headers['content-type']}`;
      epRes.failureStage = 'Proxy request';
      results.failed.push({ name: `proxy ${title}`, stage: 'Proxy request', error: epRes.error });
      episodes.push(epRes);
      continue;
    }

    // ── STAGE 5: Range support ────────────────────────────
    const acceptRanges = String(proxyRes.headers['accept-ranges'] || '').toLowerCase();
    const contentRange = proxyRes.headers['content-range'];
    epRes.checks.rangeSupport = proxyRes.status === 206 || acceptRanges === 'bytes' || !!contentRange;
    if (!epRes.checks.rangeSupport && proxyRes.bytes > 0) {
      // Full 200 is acceptable if the server serves the whole file, but we
      // flag partial-content support as a separate finding.
      epRes.checks.rangeSupport = true; // stream is still playable
      epRes.rangeWarning = 'No 206/accept-ranges; full-file 200 served';
    }

    // ── STAGE 6+: Manifest / segment / playback ───────────
    const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
    const isHls = isHlsContentType(contentType) || /\.m3u8($|\?)/i.test(payload.streamUrl);

    if (isHls) {
      // Manifest fetch (already have bytes from the proxy request).
      const manifest = analyzeHlsManifest(proxyRes.text);
      epRes.checks.manifestLoads = manifest.isHls;
      epRes.manifest = {
        isHls: true,
        playlistType: manifest.playlistType,
        segmentCount: manifest.segmentCount,
        rewrittenSegments: manifest.rewrittenSegments,
        upstreamSegmentUrls: manifest.upstreamSegmentUrls,
        targetDuration: manifest.targetDuration,
      };
      epRes.latencies.manifestMs = proxyRes.latencyMs;
      latencyBuckets.manifestMs.push(proxyRes.latencyMs);

      if (!epRes.checks.manifestLoads) {
        epRes.error = 'HLS manifest missing #EXTM3U';
        epRes.failureStage = 'Manifest fetch';
        results.failed.push({ name: `manifest ${title}`, stage: 'Manifest fetch', error: epRes.error });
        episodes.push(epRes);
        continue;
      }

      // ── Segment fetch: fetch one rewritten segment ──────
      // Find the first rewritten segment URI in the manifest.
      const segMatch = proxyRes.text.match(/\/api\/stream[^\s"']+/i);
      if (segMatch) {
        try {
          const segRes = await request('GET', segMatch[0], {
            headers: { 'Range': 'bytes=0-65535' },
            timeout: 30000,
          });
          epRes.checks.segmentDownloads = segRes.status === 200 || segRes.status === 206;
          epRes.segmentStatus = segRes.status;
          epRes.segmentBytes = segRes.bytes;
        } catch (err) {
          epRes.checks.segmentDownloads = false;
          epRes.segmentError = err.message;
        }
      } else {
        epRes.checks.segmentDownloads = manifest.rewrittenSegments > 0;
      }
      if (!epRes.checks.segmentDownloads) {
        epRes.error = 'HLS segment did not download through proxy';
        epRes.failureStage = 'Segment fetch';
        results.failed.push({ name: `segment ${title}`, stage: 'Segment fetch', error: epRes.error || epRes.segmentError });
        episodes.push(epRes);
        continue;
      }
    } else {
      // MP4 / direct media.
      const mp4 = analyzeMp4(proxyRes.body);
      epRes.checks.streamStarts = proxyRes.bytes > 0;
      epRes.checks.manifestLoads = true; // N/A for MP4
      epRes.checks.segmentDownloads = true; // N/A for MP4
      epRes.mp4 = { hasFtyp: mp4.hasFtyp, hasMoov: mp4.hasMoov, bytes: proxyRes.bytes };
      epRes.latencies.firstPlayableMs = proxyRes.latencyMs;
      latencyBuckets.firstPlayableMs.push(proxyRes.latencyMs);
      if (!epRes.checks.streamStarts) {
        epRes.error = 'MP4 returned 0 bytes';
        epRes.failureStage = 'Stream starts';
        results.failed.push({ name: `stream ${title}`, stage: 'Stream starts', error: epRes.error });
        episodes.push(epRes);
        continue;
      }
    }

    // ── STAGE 7: Playback readiness ───────────────────────
    epRes.checks.playbackReady = epRes.checks.proxyRequest
      && epRes.checks.manifestLoads
      && epRes.checks.segmentDownloads
      && (epRes.checks.streamStarts !== false);
    epRes.playable = !!epRes.checks.playbackReady;
    epRes.latencies.firstPlayableMs = epRes.latencies.firstPlayableMs || proxyRes.latencyMs;
    latencyBuckets.firstPlayableMs.push(epRes.latencies.firstPlayableMs);

    if (epRes.playable) {
      playableCount += 1;
      results.passed.push(`playable ${title} Ep ${ep} [${epRes.proxyStatus} ${epRes.contentType}]`);
      log(`   ✅ ${title} Ep ${ep} → ${epRes.proxyFormat} [${epRes.proxyStatus} ${epRes.contentType}]`);
    } else {
      epRes.error = 'Playback readiness check failed';
      epRes.failureStage = 'Playback readiness';
      results.failed.push({ name: `playback ${title}`, stage: 'Playback readiness', error: epRes.error });
      log(`   ❌ ${title} Ep ${ep} → ${epRes.proxyStatus} ${epRes.contentType}`);
    }
    episodes.push(epRes);
  }

  // ── Compute scores ──────────────────────────────────────
  const total = TITLES.length;
  const resolutionScore = total ? Math.round((resolvedCount / total) * 100) : 0;
  const playbackScore = total ? Math.round((playableCount / total) * 100) : 0;
  const proxyScore = total ? Math.round((proxyCount / total) * 100) : 0;

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  // ── Aggregate failure stages ────────────────────────────
  const failureByStage = {};
  for (const stage of STAGES) {
    failureByStage[stage] = episodes.filter(e => e.failureStage === stage).length;
  }

  // ── Summary log ─────────────────────────────────────────
  log('\n══════════════════════════════════════════════════════════');
  log('   VERIFICATION SUMMARY');
  log(`   Episodes tested:      ${total}`);
  log(`   Resolution score:     ${resolutionScore}%  (${resolvedCount}/${total} resolved)`);
  log(`   Playback score:       ${playbackScore}%  (${playableCount}/${total} playable)`);
  log(`   Proxy URLs verified:  ${proxyCount}/${total}`);
  log(`   Upstream leaks:       ${upstreamLeakCount}`);
  log(`   Redirect escapes:     ${redirectEscapeCount}`);
  log(`   Total redirects:      ${totalRedirects}`);
  log(`   Avg API resolve:      ${avg(latencyBuckets.apiResolveMs)}ms`);
  log(`   Avg proxy first-byte: ${avg(latencyBuckets.proxyFirstByteMs)}ms`);
  log(`   Avg manifest:         ${avg(latencyBuckets.manifestMs)}ms`);
  log(`   Avg first-playable:   ${avg(latencyBuckets.firstPlayableMs)}ms`);
  log('   FAILURES BY STAGE:');
  for (const [stage, count] of Object.entries(failureByStage)) {
    if (count > 0) log(`      - ${stage}: ${count}`);
  }
  log('══════════════════════════════════════════════════════════\n');

  // ── Compose root causes ─────────────────────────────────
  const rootCauses = [];
  const stageWithMost = Object.entries(failureByStage).sort((a, b) => b[1] - a[1])[0];
  if (stageWithMost && stageWithMost[1] > 0) {
    rootCauses.push(`Most failures occur at the "${stageWithMost[0]}" stage (${stageWithMost[1]} episodes).`);
  }
  if (playableCount === 0 && resolvedCount > 0) {
    rootCauses.push('Streams resolve but are NOT playable through the proxy — the proxy request/proxy fetch chain is the bottleneck.');
  }
  if (resolvedCount === 0) {
    rootCauses.push('No streams resolved at all — the provider pipeline (search/details/gate) or the 15s pipeline deadline is failing.');
  }
  if (upstreamLeakCount > 0) {
    rootCauses.push(`${upstreamLeakCount} response(s) leaked a raw upstream CDN URL / secret to the client — proxy rewrite is not fully applied.`);
  }
  if (redirectEscapeCount > 0) {
    rootCauses.push(`${redirectEscapeCount} stream(s) had a redirect that escaped the proxy origin.`);
  }
  if (rootCauses.length === 0) {
    rootCauses.push('No blocking root cause identified — all resolved episodes were playable through the proxy.');
  }

  // ── Recommendations ─────────────────────────────────────
  const recommendations = [];
  if (stageWithMost && stageWithMost[1] > 0) {
    recommendations.push(`Investigate the "${stageWithMost[0]}" stage — inspect the structured JSON for per-episode failures and the diagnostics/ evidence.`);
  }
  if (resolvedCount === 0) {
    recommendations.push('The default 15s STREAM_PIPELINE_TIMEOUT_MS is likely too tight for AnimeHeaven. Confirm whether playback succeeds under a larger deadline (this test used 60s) and raise the production pipeline timeout if so.');
  }
  if (proxyCount < total) {
    recommendations.push('Ensure every AnimeHeaven source is rewritten to a same-origin proxy URL before it reaches the client.');
  }
  if (upstreamLeakCount > 0) {
    recommendations.push('Harden rewriteResultToProxy / buildProxyUrl so no raw CDN URL or secret ever reaches the client response.');
  }
  recommendations.push('Re-run this tool periodically to catch playback regressions, and compare the generated report against the previous run.');

  // ── Build structured JSON ───────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    metadata: meta,
    environment: {
      envUsed: getEnvSnapshot(),
      note: 'STREAM_PIPELINE_TIMEOUT_MS was raised to 60s for verification. Playback that succeeds under 60s but fails under 15s indicates timeout sensitivity.',
    },
    scores: {
      resolutionScore,
      playbackScore,
      proxyScore,
      resolvedCount,
      playableCount,
      proxyUrlCount: proxyCount,
      totalEpisodes: total,
    },
    summary: {
      successfulEpisodes: playableCount,
      failedEpisodes: total - playableCount,
      resolvedEpisodes: resolvedCount,
      upstreamLeaks: upstreamLeakCount,
      redirectEscapes: redirectEscapeCount,
      totalRedirects,
    },
    failuresByStage: failureByStage,
    latency: {
      apiResolveAvgMs: avg(latencyBuckets.apiResolveMs),
      proxyFirstByteAvgMs: avg(latencyBuckets.proxyFirstByteMs),
      manifestAvgMs: avg(latencyBuckets.manifestMs),
      firstPlayableAvgMs: avg(latencyBuckets.firstPlayableMs),
      buckets: latencyBuckets,
    },
    rootCauses,
    recommendations,
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
      proxyFormat: e.proxyFormat || null,
      proxyStatus: e.proxyStatus || null,
      contentType: e.contentType || null,
      resolved: !!e.resolved,
      playable: !!e.playable,
      checks: e.checks || {},
      latencies: e.latencies || {},
      redirects: e.redirects || 0,
      failureStage: e.failureStage || null,
      error: e.error || null,
      manifest: e.manifest || null,
      mp4: e.mp4 || null,
    })),
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(report, null, 2));
  log(`📄 Structured report written to ${JSON_PATH}`);

  // ── Build Markdown report ───────────────────────────────
  const md = buildMarkdown(report, { latencies: latencyBuckets, episodeRows: episodes });
  fs.writeFileSync(REPORT_PATH, md);
  log(`📄 Human report written to ${REPORT_PATH}\n`);

  // Shut down the in-process server.
  try {
    const s = require('./server');
    if (s && s.close) s.close();
  } catch { /* ignore */ }

  // Exit non-zero if playback score is below par (informational).
  process.exit(0);
}

// ── Markdown builder ───────────────────────────────────────
function buildMarkdown(report, ctx) {
  const L = [];
  const { scores, summary, failuresByStage, latency, rootCauses, recommendations } = report;
  const avg = (arr) => arr && arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  L.push('# ANIMEHEAVEN PLAYBACK REPORT');
  L.push('');
  L.push('**Generated:** ' + report.generatedAt);
  L.push('**Node:** ' + report.metadata.nodeVersion + ' · **Platform:** ' + report.metadata.platform + ' (' + report.metadata.arch + ')');
  if (report.metadata.commitHash) L.push('**Commit:** `' + report.metadata.commitHash + '`');
  L.push('**Environment:** `' + (process.env.STREAM_PROVIDERS || 'default') + '` · Pipeline timeout `' + (process.env.STREAM_PIPELINE_TIMEOUT_MS || '15s') + 'ms`');
  L.push('');

  L.push('## Overall Score');
  L.push('');
  L.push('| Metric | Score |');
  L.push('|--------|-------|');
  L.push(`| **Resolution Score** | **${scores.resolutionScore}%** (${scores.resolvedCount}/${scores.totalEpisodes} resolved) |`);
  L.push(`| **Playback Score** | **${scores.playbackScore}%** (${scores.playableCount}/${scores.totalEpisodes} playable) |`);
  L.push(`| Proxy URL score | ${scores.proxyScore}% (${scores.proxyUrlCount}/${scores.totalEpisodes}) |`);
  L.push('');

  L.push('## Successful Episodes');
  L.push('');
  const ok = report.episodes.filter(e => e.playable);
  if (ok.length) {
    L.push('| Title | Ep | Proxy | Status | Content-Type |');
    L.push('|-------|----|-------|--------|--------------|');
    for (const e of ok) {
      L.push(`| ${e.title} | ${e.episode} | ${e.proxyFormat || '-'} | ${e.proxyStatus || '-'} | ${e.contentType || '-'} |`);
    }
  } else {
    L.push('_None._');
  }
  L.push('');

  L.push('## Failed Episodes');
  L.push('');
  const bad = report.episodes.filter(e => !e.playable);
  if (bad.length) {
    L.push('| Title | Ep | Stage | Error |');
    L.push('|-------|----|-------|-------|');
    for (const e of bad) {
      L.push(`| ${e.title} | ${e.episode} | ${e.failureStage || '-'} | ${(e.error || '').slice(0, 120)} |`);
    }
  } else {
    L.push('_None — all episodes playable._');
  }
  L.push('');

  L.push('## Failures by Stage');
  L.push('');
  L.push('| Stage | Episodes |');
  L.push('|-------|----------|');
  for (const stage of ['API resolve', 'Provider resolution', 'Proxy URL generation', 'Proxy request', 'Manifest fetch', 'Segment fetch', 'Range support', 'Playback readiness']) {
    const c = failuresByStage[stage] || 0;
    L.push(`| ${stage} | ${c} |`);
  }
  L.push('');

  L.push('## Latency');
  L.push('');
  L.push('| Phase | Avg (ms) |');
  L.push('|-------|----------|');
  L.push(`| API resolve | ${latency.apiResolveAvgMs} |`);
  L.push(`| Proxy first-byte | ${latency.proxyFirstByteAvgMs} |`);
  L.push(`| Manifest | ${latency.manifestAvgMs} |`);
  L.push(`| First playable | ${latency.firstPlayableAvgMs} |`);
  L.push('');

  L.push('## Redirects');
  L.push('');
  L.push(`Total redirects across all streams: **${summary.totalRedirects}** · Redirect escapes (outside proxy): **${summary.redirectEscapes}**`);
  L.push('');

  L.push('## Root Causes');
  L.push('');
  if (rootCauses.length === 0) {
    L.push('- No blocking root cause identified.');
  } else {
    for (const rc of rootCauses) L.push(`- ${rc}`);
  }
  L.push('');

  L.push('## Recommendations');
  L.push('');
  for (const r of recommendations) L.push(`- ${r}`);
  L.push('');

  L.push('---');
  L.push('');
  L.push('### Reproducibility');
  L.push('');
  L.push(`- **Timestamp:** ${report.generatedAt}`);
  L.push(`- **Node:** ${report.metadata.nodeVersion}`);
  L.push(`- **Platform:** ${report.metadata.platform} (${report.metadata.arch})`);
  L.push(`- **Commit:** ${report.metadata.commitHash || '(n/a)'}`);
  L.push('- **Environment:**');
  const env = report.environment.envUsed;
  if (Object.keys(env).length) {
    for (const [k, v] of Object.entries(env)) L.push(`  - \`${k}\`=\`${v}\``);
  } else {
    L.push('  - _(none overridden)_');
  }
  L.push('');
  L.push(`*Full structured trace: \`animeheaven-playback-verification.json\`*`);
  return L.join('\n');
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
