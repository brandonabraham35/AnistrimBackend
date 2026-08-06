// =============================================================
//  _diag_animeheaven_full.js — Full AnimeHeaven Provider Pipeline Diagnostic
//
//  PURPOSE:
//    Instrument EVERY stage of the AnimeHeaven resolver pipeline and produce a
//    step-by-step report identifying the FIRST failing stage. NO production
//    code is modified — instrumentation is achieved by monkeypatching the
//    shared HTTP layer (utils/providerHttp.request) so raw response metadata
//    (status, headers, set-cookie, redirects, final URL, timing, Cloudflare
//    Ray ID) is captured for every request the provider makes.
//
//  STAGES TRACED:
//    1. Search
//    2. Anime page (details + episode listing)
//    3. Episode/gate page
//    4. Iframe extraction
//    5. Mirror resolution
//    6. Player assembly
//    7. Stream + subtitle extraction
//
//  OUTPUTS:
//    - diagnostics/animeheaven/            saved evidence (HTML, headers, cookies)
//    - animeheaven-diagnostic.json         structured trace
//    - ANIMEHEAVEN_PROVIDER_DIAGNOSTIC.md  human report + pipeline summary
//
//  USAGE:
//    node _diag_animeheaven_full.js ["Anime Title"] [episode]
// =============================================================
'use strict';

process.env.STREAM_PROVIDERS = 'animeheaven';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// ── Config ───────────────────────────────────────────────────
const TITLE = process.argv[2] || 'One Piece';
const EPISODE = Number(process.argv[3] || 1);
const OUT_DIR = path.join(__dirname, 'diagnostics', 'animeheaven');
const MAX_SAVED_HTML = 200 * 1024;
const MAX_SAVED_SNIPPET = 4000;

// ── Instrumentation state ────────────────────────────────────
const httpTraces = [];
let requestSeq = 0;

// ── Failure classification ───────────────────────────────────
const FAILURE_CATEGORIES = {
  NETWORK: 'Network',
  DNS: 'DNS',
  TIMEOUT: 'Timeout',
  CLOUDFLARE: 'Cloudflare challenge',
  CAPTCHA: 'CAPTCHA',
  HTTP_403: 'HTTP 403',
  HTTP_404: 'HTTP 404',
  HTTP_429: 'HTTP 429',
  HTTP_5XX: 'HTTP 5xx',
  SELECTOR_MISMATCH: 'Selector mismatch',
  MISSING_IFRAME: 'Missing iframe',
  MIRROR_UNAVAILABLE: 'Mirror unavailable',
  PLAYER_EXTRACTION: 'Player extraction failure',
  STREAM_EXTRACTION: 'Stream extraction failure',
  UNKNOWN: 'Unknown',
};

function extractRayId(headers) {
  const h = headers || {};
  return h['cf-ray'] || h['cf_Ray'] || null;
}

function extractCftypeValues(headers) {
  const h = headers || {};
  return {
    'server': h['server'] || null,
    'cf-cache-status': h['cf-cache-status'] || null,
    'cf-ray': h['cf-ray'] || null,
    'cf-mitigated': h['cf-mitigated'] || null,
    'cf-chl-bypass': h['cf-chl-bypass'] || null,
    'set-cookie': Array.isArray(h['set-cookie']) ? h['set-cookie'] : (h['set-cookie'] ? [h['set-cookie']] : []),
  };
}

function detectCloudflareChallenge(html, headers) {
  const body = String(html || '').toLowerCase();
  const h = headers || {};
  const hasCfMarkers = !!(h['cf-ray'] || h['cf-mitigated'] || h['server'] === 'cloudflare');
  const title = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const mlTitle = title.toLowerCase();

  const flags = {
    checkingBrowser: /checking your browser/i.test(body),
    justAMoment: /just a moment/i.test(body),
    attentionRequired: /attention required/i.test(body),
    cloudflare: /cloudflare/i.test(body),
    captcha: /captcha/i.test(body),
    turnstile: /_cf_chl_opt|turnstile|cf-please-wait/i.test(body),
    accessDenied: /access denied/i.test(body),
    cfChallenge: /cf-challenge|cf_chl|challenge-platform/i.test(body),
    jsChallenge: /setTimeout|challenge\.run|a\.js|cdn-cgi\/challenge-platform/i.test(body),
  };
  const anyFlag = Object.values(flags).some(Boolean) || hasCfMarkers || /just a moment/i.test(mlTitle);

  return {
    detected: anyFlag,
    rayId: extractRayId(headers),
    title,
    responseLength: String(html || '').length,
    flags,
    hasCfMarkers,
    headerValues: extractCftypeValues(headers),
    challengeType: flags.turnstile || flags.captcha ? 'captcha/turnstile'
      : flags.jsChallenge ? 'javascript'
      : flags.attentionRequired ? 'attention-required'
      : flags.checkingBrowser || flags.justAMoment ? 'browser-verification'
      : anyFlag ? 'unknown' : null,
  };
}

function classifyStageFailure({ status, headers, html, error }) {
  const cf = detectCloudflareChallenge(html, headers);
  if (error) {
    const msg = String(error.message || error).toLowerCase();
    if (/timeout|timed out|econnaborted|etimedout/i.test(msg)) return FAILURE_CATEGORIES.TIMEOUT;
    if (/enotfound|getaddrinfo|dns/i.test(msg)) return FAILURE_CATEGORIES.DNS;
    if (/econnrefused|econnreset|network|socket|proxy/i.test(msg)) return FAILURE_CATEGORIES.NETWORK;
    if (/captcha/i.test(msg)) return FAILURE_CATEGORIES.CAPTCHA;
    if (/cloudflare|cf_i|captcha/i.test(msg)) return FAILURE_CATEGORIES.CLOUDFLARE;
  }
  if (cf.detected) return FAILURE_CATEGORIES.CLOUDFLARE;
  if (status === 403) return FAILURE_CATEGORIES.HTTP_403;
  if (status === 404) return FAILURE_CATEGORIES.HTTP_404;
  if (status === 429) return FAILURE_CATEGORIES.HTTP_429;
  if (status >= 500) return FAILURE_CATEGORIES.HTTP_5XX;
  return FAILURE_CATEGORIES.UNKNOWN;
}

// ── Monkeypatch the HTTP layer ───────────────────────────────
const providerHttp = require('./utils/providerHttp');
const originalRequest = providerHttp.request;

providerHttp.request = async function (config, options) {
  const seq = ++requestSeq;
  const url = config.url || '';
  const method = (config.method || 'get').toUpperCase();
  const started = Date.now();
  const trace = {
    seq,
    request: { method, url, headers: { ...(config.headers || {}), ...(options?.extraHeaders || {}) } },
    startedAt: new Date().toISOString(),
  };
  try {
    const res = await originalRequest.call(providerHttp, config, options);
    trace.response = {
      status: Number(res.status || 0),
      statusText: res.statusText || '',
      headers: res.headers || {},
      setCookie: Array.isArray(res.headers?.['set-cookie']) ? res.headers['set-cookie'] : (res.headers?.['set-cookie'] ? [res.headers['set-cookie']] : []),
      finalUrl: res.config?.url || url,
      dataLength: String(res.data || '').length,
    };
    trace.cloudflare = detectCloudflareChallenge(String(res.data || ''), res.headers || {});
    trace.durationMs = Date.now() - started;
    httpTraces.push(trace);
    return res;
  } catch (err) {
    trace.error = {
      message: err.message,
      code: err.code || null,
      status: err.response?.status || 0,
      providerContext: err.providerContext || null,
    };
    trace.response = {
      status: Number(err.response?.status || 0),
      headers: err.response?.headers || {},
      setCookie: [],
      dataLength: 0,
    };
    trace.cloudflare = detectCloudflareChallenge(String(err.response?.data || ''), err.response?.headers || {});
    trace.durationMs = Date.now() - started;
    httpTraces.push(trace);
    throw err;
  }
};

// ── Selector diagnostic helpers ──────────────────────────────
function selectorDiag(html, selectors) {
  const out = [];
  const $ = cheerio.load(String(html || ''));
  for (const sel of selectors) {
    const els = $(sel);
    const matches = els.length;
    const first = els.first();
    let firstText = '';
    let firstHtml = '';
    if (matches > 0) {
      firstText = (first.text().trim() || first.attr('href') || first.attr('src') || first.attr('onclick') || '').slice(0, 200);
      firstHtml = $.html(first).slice(0, MAX_SAVED_SNIPPET);
    }
    out.push({ selector: sel, matches, firstText, snippet: firstHtml });
  }
  return out;
}

function htmlTitle(html) {
  return (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
}

// ── Evidence saving ──────────────────────────────────────────
function ensureDir() { fs.mkdirSync(OUT_DIR, { recursive: true }); }

function saveEvidence(name, { html, headers, cookies, redirects, meta }) {
  ensureDir();
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  try {
    if (html != null) {
      fs.writeFileSync(path.join(OUT_DIR, `${safe}.html`), String(html).slice(0, MAX_SAVED_HTML));
    }
    fs.writeFileSync(path.join(OUT_DIR, `${safe}.headers.json`), JSON.stringify(headers || {}, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `${safe}.meta.json`), JSON.stringify({ cookies, redirects, ...meta }, null, 2));
    return true;
  } catch (e) {
    console.error('  [evidence] failed to save:', e.message);
    return false;
  }
}

// ── Main diagnostic driver ───────────────────────────────────
async function main() {
  console.log(`\n=== AnimeHeaven FULL PIPELINE DIAGNOSTIC ===`);
  console.log(`Title: "${TITLE}"  Episode: ${EPISODE}\n`);
  ensureDir();

  const { provider } = require('./services/animeHeavenProvider');

  // ── STAGE 1: SEARCH ──────────────────────────────────────
  let searchRows = [];
  let searchError = null;
  try {
    searchRows = await provider.searchAnime(TITLE, 10);
  } catch (e) { searchError = e; }
  const searchTraces = httpTraces.slice();
  const searchHtmlCandidates = searchTraces.filter(t => /search|fastsearch|anime\.php|\/$/.test(t.request.url)).map(t => t.response || {});
  const searchPassed = searchRows.length > 0;
  saveEvidence('search', {
    html: null,
    headers: searchHtmlCandidates[0]?.headers || {},
    cookies: searchHtmlCandidates[0]?.setCookie || [],
    redirects: [],
    meta: { stage: 'search', title: TITLE, resultCount: searchRows.length, error: searchError?.message || null },
  });
  console.log(`[1/7] SEARCH → ${searchPassed ? '✓' : '✗'} (${searchRows.length} results)`);

  // ── STAGE 2: ANIME PAGE (details) ────────────────────────
  let details = null;
  let detailsError = null;
  let detailsIdentifier = searchRows[0]?.identifier || searchRows[0]?.id || null;
  if (!detailsIdentifier && searchError) {
    detailsIdentifier = TITLE.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  try {
    details = await provider.getAnimeDetails(detailsIdentifier || TITLE);
  } catch (e) { detailsError = e; }
  const detailsTraces = httpTraces.slice();
  const animeTrace = detailsTraces[detailsTraces.length - 1] || null;
  const animePassed = !!(details && Array.isArray(details.episodes) && details.episodes.length > 0);
  console.log(`[2/7] ANIME PAGE → ${animePassed ? '✓' : '✗'} (${details?.episodes?.length || 0} episodes)`);

  // ── STAGE 3: EPISODE/GATE PAGE ───────────────────────────
  let resolved = null;
  let resolveError = null;
  try {
    resolved = await provider.resolveEpisode({ title: TITLE, episode: EPISODE, identifier: detailsIdentifier || undefined });
  } catch (e) { resolveError = e; }
  const gateTrace = httpTraces.slice();
  const gatePageTrace = [...gateTrace].reverse().find(t => /gate\.php/.test(t.request.url)) || gateTrace[gateTrace.length - 1] || null;
  const selectors_diag = {
    iframe: selectorDiag(resolved?.html || '', ['iframe[src]', 'embed[src]', 'object[data]', 'param[name="movie"]']),
    video: selectorDiag(resolved?.html || '', ['video[src]', 'source[src]']),
    links: selectorDiag(resolved?.html || '', ['a[href*=".m3u8"]', 'a[href*=".mp4"]']),
  };
  const gatePassed = !!(resolved && resolved.html && !resolved.reason);
  const gateCf = detectCloudflareChallenge(resolved?.html || '', gatePageTrace?.response?.headers || {});
  saveEvidence('gate-page', {
    html: resolved?.html || '',
    headers: gatePageTrace?.response?.headers || {},
    cookies: gatePageTrace?.response?.setCookie || [],
    redirects: [],
    meta: { stage: 'episode-page/gate', episode: EPISODE, gateUrl: gatePageTrace?.request?.url, reason: resolved?.reason || null },
  });
  console.log(`[3/7] EPISODE/GATE PAGE → ${gatePassed ? '✓' : '✗'} (reason: ${resolved?.reason || 'none'})`);

  // ── STAGE 4: IFRAME EXTRACTION ───────────────────────────
  let player = null;
  let playerError = null;
  try {
    player = await provider.resolvePlayer({ title: TITLE, episode: EPISODE, identifier: detailsIdentifier || undefined });
  } catch (e) { playerError = e; }
  const playerTraces = httpTraces.slice();
  const iframeDiag = selectorDiag(resolved?.html || '', ['iframe[src]', 'embed[src]', 'object[data]', 'param[name="movie"]']);
  const iframeCount = iframeDiag.reduce((a, b) => a + b.matches, 0);
  const iframePassed = !!player && Array.isArray(player.sources) && player.sources.length > 0;
  console.log(`[4/7] IFRAME EXTRACTION → ${iframePassed ? '✓' : '✗'} (${player?.sources?.length || 0} sources, ${iframeCount} iframes found)`);

  // ── STAGE 5: MIRROR RESOLUTION + STREAM ─────────────────
  let streams = null;
  let streamError = null;
  try {
    streams = await provider.extractStreams({ title: TITLE, episode: EPISODE, identifier: detailsIdentifier || undefined });
  } catch (e) { streamError = e; }
  const playableSources = (streams?.sources || []).filter(s => /\.(m3u8|mp4|mpd)(\?|$)/i.test(s.url) || /video\.mp4\?/i.test(s.url));
  const mirrorDiag = selectorDiag(resolved?.html || '', ['a[href*="vidstream"]', 'a[href*="filemoon"]', 'a[href*="mp4upload"]', 'a[href*="dood"]', 'a[href*="streamwish"]', 'a[href*="filelions"]']);
  const mirrorPassed = playableSources.length > 0;
  console.log(`[5/7] MIRROR/STREAM → ${mirrorPassed ? '✓' : '✗'} (${streams?.sources?.length || 0} total, ${playableSources.length} playable)`);

  // ── STAGE 6: PLAYER ──────────────────────────────────────
  const playerPassed = !!(player && (player.playerUrl || (player.sources && player.sources.length)));
  console.log(`[6/7] PLAYER → ${playerPassed ? '✓' : '✗'} (playerUrl: ${player?.playerUrl || player?.sources?.[0]?.url || 'none'})`);

  // ── STAGE 7: STREAM EXTRACTION ───────────────────────────
  const streamPassed = !!streams && !!streams.streamUrl;
  const subtitleCount = streams?.subtitles?.length || 0;
  console.log(`[7/7] STREAM EXTRACTION → ${streamPassed ? '✓' : '✗'} (streamUrl: ${streams?.streamUrl || 'none'}, subtitles: ${subtitleCount})`);

  // ── Determine FIRST FAILING STAGE ────────────────────────
  const orderedResults = [
    { name: 'Search', passed: searchPassed },
    { name: 'Anime page', passed: animePassed },
    { name: 'Episode/gate page', passed: gatePassed },
    { name: 'Iframe extraction', passed: iframePassed },
    { name: 'Mirror resolution', passed: mirrorPassed },
    { name: 'Player', passed: playerPassed },
    { name: 'Stream extraction', passed: streamPassed },
  ];
  const firstFail = orderedResults.find(r => !r.passed);

  // ── Build the full report object ─────────────────────────
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      title: TITLE,
      episode: EPISODE,
      provider: 'animeheaven',
      script: '_diag_animeheaven_full.js',
    },
    summary: {
      firstFailingStage: firstFail ? firstFail.name : null,
      firstFailingTag: firstFail ? firstFail.name.toUpperCase().replace(/\s+/g, '_').replace('/g', '_').replace('ANIME_PAGE', 'ANIME_PAGE') + '_FAILED' : null,
      stages: orderedResults.map(r => ({ name: r.name, passed: r.passed })),
    },
    stages: {
      search: {
        result: searchPassed ? 'success' : 'failure',
        resultCount: searchRows.length,
        error: searchError?.message || null,
        classification: searchPassed ? null : FAILURE_CATEGORIES.UNKNOWN,
        topResults: searchRows.slice(0, 5).map(r => ({ id: r.id, title: r.title, url: r.url, score: r.score })),
        traces: searchTraces.map(tr => ({ seq: tr.seq, url: tr.request.url, status: tr.response?.status, durationMs: tr.durationMs, cloudflare: tr.cloudflare?.detected, rayId: tr.cloudflare?.rayId })),
      },
      animePage: {
        result: animePassed ? 'success' : 'failure',
        identifier: detailsIdentifier,
        title: details?.title || null,
        episodeCount: details?.episodes?.length || 0,
        error: detailsError?.message || null,
        classification: animePassed ? null : classifyStageFailure({ error: detailsError }),
        episodes: (details?.episodes || []).slice(0, 5).map(e => ({ id: e.id, number: e.number, title: e.title, url: e.url })),
        traces: detailsTraces.slice(Math.max(0, detailsTraces.length - 5)).map(tr => ({ seq: tr.seq, url: tr.request.url, status: tr.response?.status, durationMs: tr.durationMs, cloudflare: tr.cloudflare?.detected, rayId: tr.cloudflare?.rayId })),
      },
      episodePage: {
        result: gatePassed ? 'success' : 'failure',
        episode: EPISODE,
        reason: resolved?.reason || null,
        gateUrl: gatePageTrace?.request?.url || null,
        gateStatus: gatePageTrace?.response?.status || null,
        cloudflare: gateCf,
        error: resolveError?.message || null,
        classification: gatePassed ? null : classifyStageFailure({ status: gatePageTrace?.response?.status || 0, headers: gatePageTrace?.response?.headers, html: resolved?.html, error: resolveError }),
        selectors: { iframe: iframeDiag, video: selectors_diag.video, links: selectors_diag.links },
        traces: playerTraces.slice(Math.max(0, playerTraces.length - 6)).map(tr => ({ seq: tr.seq, url: tr.request.url, status: tr.response?.status, durationMs: tr.durationMs, cloudflare: tr.cloudflare?.detected, rayId: tr.cloudflare?.rayId })),
      },
      iframe: {
        result: iframePassed ? 'success' : 'failure',
        iframeCountFound: iframeCount,
        sourceCount: player?.sources?.length || 0,
        playerUrl: player?.playerUrl || null,
        reason: player?.reason || null,
        error: playerError?.message || null,
        classification: iframePassed ? null : (iframeCount === 0 ? FAILURE_CATEGORIES.MISSING_IFRAME : classifyStageFailure({ status: gatePageTrace?.response?.status || 0, headers: gatePageTrace?.response?.headers, html: '', error: playerError })),
        sources: (player?.sources || []).slice(0, 10).map(s => ({ url: s.url, quality: s.quality, sourceType: s.sourceType })),
        selectors: { iframe: iframeDiag },
      },
      mirror: {
        result: mirrorPassed ? 'success' : 'failure',
        totalSources: streams?.sources?.length || 0,
        playableSources: playableSources.length,
        streamUrl: streams?.streamUrl || null,
        reason: streams?.reason || null,
        error: streamError?.message || null,
        classification: mirrorPassed ? null : classifyStageFailure({ error: streamError }),
        mirrorsDetected: mirrorDiag.map(d => ({ selector: d.selector, matches: d.matches })),
        sources: (streams?.sources || []).slice(0, 10).map(s => ({ url: s.url, quality: s.quality, sourceType: s.sourceType })),
      },
      player: {
        result: playerPassed ? 'success' : 'failure',
        playerUrl: player?.playerUrl || player?.sources?.[0]?.url || null,
        sourceCount: player?.sources?.length || 0,
        reason: player?.reason || null,
      },
      stream: {
        result: streamPassed ? 'success' : 'failure',
        streamUrl: streams?.streamUrl || null,
        subtitleMode: streams?.subtitleMode || null,
        externalTracks: streams?.externalTracks || null,
        subtitleCount,
        reason: streams?.reason || null,
        classification: streamPassed ? null : classifyStageFailure({ error: streamError }),
        subtitles: (streams?.subtitles || []).slice(0, 10).map(s => ({ lang: s.lang, url: s.url, format: s.format })),
      },
    },
    httpTraces: httpTraces.map(t => ({
      seq: t.seq,
      method: t.request.method,
      url: t.request.url,
      status: t.response?.status,
      durationMs: t.durationMs,
      finalUrl: t.response?.finalUrl,
      dataLength: t.response?.dataLength,
      cloudflareDetected: t.cloudflare?.detected,
      rayId: t.cloudflare?.rayId,
      challengeType: t.cloudflare?.challengeType,
      setCookie: t.response?.setCookie || [],
      error: t.error || null,
    })),
  };

  // ── Write structured JSON ────────────────────────────────
  fs.writeFileSync(path.join(__dirname, 'animeheaven-diagnostic.json'), JSON.stringify(report, null, 2));
  console.log('\n📄 animeheaven-diagnostic.json written');

  // ── Write Markdown report ────────────────────────────────
  const md = buildMarkdown(report, {
    firstFail, gateCf, gatePageTrace, resolved, details, iframeDiag,
    searchPassed, animePassed, gatePassed, iframePassed, mirrorPassed, playerPassed, streamPassed,
    searchRows, streams, player, subtitleCount,
  });
  fs.writeFileSync(path.join(__dirname, 'ANIMEHEAVEN_PROVIDER_DIAGNOSTIC.md'), md);
  console.log('📄 ANIMEHEAVEN_PROVIDER_DIAGNOSTIC.md written');
  console.log(`\n📁 Evidence saved to ${OUT_DIR}`);

  // ── Final verdict ────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`FIRST FAILING STAGE: ${firstFail ? firstFail.name : 'NONE — all stages passed'}`);
  console.log('══════════════════════════════════════════════════');
}

function buildMarkdown(report, c) {
  const L = [];
  L.push(`# AnimeHeaven Resolution Pipeline`);
  L.push(``);
  L.push(`**Subject:** \`${report.meta.title}\` — Episode ${report.meta.episode}`);
  L.push(`**Generated:** ${report.meta.generatedAt}`);
  L.push(`**Provider:** \`animeheaven\``);
  L.push(``);

  // ── Pipeline summary at top ──────────────────────────────
  L.push(`## Provider Resolution Pipeline`);
  L.push(``);
  const mark = (ok) => (ok ? '✓' : '✗');
  L.push(`${mark(c.searchPassed)} Search`);
  L.push(`${mark(c.animePassed)} Anime page (${c.animePassed ? `${c.details?.episodes?.length || 0} episodes` : 'failed'})`);
  L.push(`${mark(c.gatePassed)} Episode page`);
  L.push(`${mark(c.iframePassed)} Iframe extraction`);
  L.push(`${mark(c.mirrorPassed)} Mirror resolution`);
  L.push(`${mark(c.playerPassed)} Player`);
  L.push(`${mark(c.streamPassed)} Stream extraction`);
  L.push(``);

  if (c.firstFail) {
    L.push(`## ❌ First Failing Stage: **${c.firstFail.name}**`);
    L.push(``);
    if (c.firstFail.name === 'Iframe extraction') {
      L.push(`**Reason:** Selector no longer exists`);
      L.push(``);
      L.push(`**Selectors searched:**`);
      L.push(``);
      L.push(`| Selector | Matches |`);
      L.push(`|----------|---------|`);
      for (const d of c.iframeDiag) L.push(`| \`${d.selector}\` | ${d.matches} |`);
      L.push(``);
      L.push(`**HTML title:** \`${htmlTitle(c.resolved?.html) || '(none)'}\``);
      L.push(`**HTML length:** ${String(c.resolved?.html || '').length}`);
    } else if (c.firstFail.name === 'Episode/gate page' && c.gateCf.detected) {
      L.push(`**Reason:** Cloudflare challenge`);
      L.push(``);
      L.push(`**Status:** ${c.gateCf.headerValues['cf-ray'] ? '403' : (c.gatePageTrace?.response?.status || 'unknown')}`);
      L.push(`**Ray ID:** ${c.gateCf.rayId || 'xxxxxxxx'}`);
      L.push(`**Cookies received:** \`${JSON.stringify(c.gateCf.headerValues['set-cookie'] || [])}\``);
      L.push(`**Response length:** ${c.gateCf.responseLength}`);
      L.push(`**Title:** ${c.gateCf.title || '(none)'}`);
      L.push(`**Challenge type:** ${c.gateCf.challengeType || 'unknown'}`);
      L.push(`**Server:** ${c.gateCf.headerValues['server'] || '(none)'}`);
} else {
      const key = stageKey(c.firstFail.name);
      L.push(`**Reason:** ${report.stages[key]?.classification || 'Unknown'}`);
      L.push(``);
      L.push(`**Status:** ${report.stages[key]?.gateStatus || report.stages[key]?.traces?.slice(-1)[0]?.status || 'unknown'}`);
    }
    L.push(``);
    L.push(`**Suggested next action:** Investigate the ${c.firstFail.name} stage — see evidence under \`diagnostics/animeheaven/\` and the structured JSON trace.`);
  } else {
    L.push(`## ✅ All stages passed`);
    L.push(``);
    L.push(`**Stream URL:** \`${c.streams?.streamUrl || '(playback handled via proxy)'}\``);
    L.push(`**Sources:** ${c.streams?.sources?.length || 0}`);
    L.push(`**Subtitles:** ${c.subtitleCount}`);
  }
  L.push(``);

  // ── Detailed stage report ────────────────────────────────
  L.push(`---`);
  L.push(`## Detailed Stage Report`);
  L.push(``);

  L.push(`### 1. Search`);
  L.push(`${c.searchPassed ? '✅ **PASSED**' : '❌ **FAILED**'} — ${c.searchRows.length} results`);
  if (c.searchRows.length) {
    L.push(``);
    L.push(`**Top results:**`);
    for (const r of c.searchRows.slice(0, 5)) L.push(`- \`${r.id}\` ${r.title} (score ${r.score})`);
  }
  L.push(``);

  L.push(`### 2. Anime page`);
  L.push(`${c.animePassed ? '✅ **PASSED**' : '❌ **FAILED**'} — title: ${c.details?.title || '(none)'}, episodes: ${c.details?.episodes?.length || 0}`);
  if (c.details?.episodes?.length) {
    L.push(``);
    L.push(`**First episodes:**`);
    for (const e of c.details.episodes.slice(0, 5)) L.push(`- \`${e.id}\` #${e.number} ${e.title}`);
  }
  L.push(``);

  L.push(`### 3. Episode/gate page`);
  L.push(`${c.gatePassed ? '✅ **PASSED**' : '❌ **FAILED**'} — reason: ${c.resolved?.reason || 'none'}`);
  if (c.gateCf.detected) {
    L.push(``);
    L.push(`**Cloudflare detected:** yes`);
    L.push(`- Ray ID: ${c.gateCf.rayId || 'xxxxxxxx'}`);
    L.push(`- Title: ${c.gateCf.title || '(none)'}`);
    L.push(`- Length: ${c.gateCf.responseLength}`);
    L.push(`- Challenge type: ${c.gateCf.challengeType || 'unknown'}`);
    L.push(`- Server: ${c.gateCf.headerValues['server'] || '(none)'}`);
    L.push(`- Cookies: \`${JSON.stringify(c.gateCf.headerValues['set-cookie'] || [])}\``);
  }
  L.push(``);

  L.push(`### 4. Iframe extraction`);
  L.push(`${c.iframePassed ? '✅ **PASSED**' : '❌ **FAILED**'} — ${c.player?.sources?.length || 0} sources`);
  L.push(``);
  L.push(`**Iframe selectors:**`);
  L.push(`| Selector | Matches |`);
  L.push(`|----------|---------|`);
  for (const d of c.iframeDiag) L.push(`| \`${d.selector}\` | ${d.matches} |`);
  L.push(``);

  L.push(`### 5. Mirror resolution`);
  L.push(`${c.mirrorPassed ? '✅ **PASSED**' : '❌ **FAILED**'} — ${c.streams?.sources?.length || 0} total sources, ${(c.streams?.sources || []).filter(s => /\.(m3u8|mp4)(\?|$)/i.test(s.url)).length || 0} playable`);
  L.push(``);

  L.push(`### 6. Player`);
  L.push(`${c.playerPassed ? '✅ **PASSED**' : '❌ **FAILED**'} — playerUrl: ${c.player?.playerUrl || c.player?.sources?.[0]?.url || 'none'}`);
  L.push(``);

  L.push(`### 7. Stream extraction`);
  L.push(`${c.streamPassed ? '✅ **PASSED**' : '❌ **FAILED**'} — streamUrl: ${c.streams?.streamUrl || 'none'}, subtitleMode: ${c.streams?.subtitleMode || 'none'}, subtitles: ${c.subtitleCount}`);
  L.push(``);

  // ── HTTP trace table ─────────────────────────────────────
  L.push(`---`);
  L.push(`## HTTP Request Trace`);
  L.push(``);
  L.push(`| # | Method | URL | Status | ms | Cloudflare | Ray ID |`);
  L.push(`|---|--------|-----|--------|----|-----------|--------|`);
  for (const t of report.httpTraces) {
    const short = t.url.length > 80 ? t.url.slice(0, 77) + '...' : t.url;
    L.push(`| ${t.seq} | ${t.method} | \`${short}\` | ${t.status || '-'} | ${t.durationMs} | ${t.cloudflareDetected ? '🛡' : 'no'} | ${t.rayId || '-'} |`);
  }
  L.push(``);

  L.push(`---`);
  L.push(`*Full structured trace: \`animeheaven-diagnostic.json\`*`);
  L.push(`*Saved evidence: \`diagnostics/animeheaven/\`*`);
  return L.join('\n');
}

function stageKey(name) {
  return {
    'Search': 'search',
    'Anime page': 'animePage',
    'Episode/gate page': 'episodePage',
    'Iframe extraction': 'iframe',
    'Mirror resolution': 'mirror',
    'Player': 'player',
    'Stream extraction': 'stream',
  }[name];
}

main().catch((e) => {
  console.error('DIAGNOSTIC FATAL:', e);
  process.exit(1);
});
