const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');
const { request } = require('../utils/providerHttp');

const TARGET_EPISODES = 50;
const MAX_REDIRECT_HOPS = 12;
const MAX_IFRAME_DEPTH = 4;
const REQUEST_TIMEOUT_MS = 15000;

const MIRROR_HINTS = [
  'vidstream',
  'filemoon',
  'mp4upload',
  'dood',
  'streamwish',
  'mixdrop',
  'yourupload',
  'filelions',
];

function toAbs(base, maybeRelative) {
  try {
    return new URL(String(maybeRelative || ''), String(base || '')).toString();
  } catch {
    return null;
  }
}

function getHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function detectMirrorName(url) {
  const host = getHost(url);
  const hit = MIRROR_HINTS.find((h) => host.includes(h));
  return hit || host || 'unknown';
}

function isMirrorUrl(url) {
  const host = getHost(url);
  return MIRROR_HINTS.some((h) => host.includes(h));
}

function isPlayableMediaUrl(url) {
  return /\.(m3u8|mp4|mpd)(\?|$)/i.test(String(url || '')) || /video\.mp4\?/i.test(String(url || ''));
}

function extractAllUrls(raw) {
  const html = String(raw || '');
  const out = new Set();

  const direct = html.match(/https?:\/\/[^'"\s<>]+/gi) || [];
  for (const u of direct) out.add(u);

  const attrRx = /(src|href|data)\s*=\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = attrRx.exec(html)) !== null) {
    const value = m[2];
    if (/^https?:\/\//i.test(value)) out.add(value);
  }

  return [...out];
}

function extractIframeUrls(html, baseUrl) {
  const out = new Set();
  const text = String(html || '');

  const rx = /<(iframe|embed|object|param)[^>]+?(src|data|value)=['"]([^'"]+)['"]/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const abs = toAbs(baseUrl, m[3]);
    if (abs) out.add(abs);
  }

  return [...out];
}

function extractPlayableUrls(html, baseUrl) {
  const out = new Set();
  const text = String(html || '');

  const attrRx = /(src|href|file|source|manifest)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = attrRx.exec(text)) !== null) {
    const abs = toAbs(baseUrl, m[2]);
    if (abs && isPlayableMediaUrl(abs)) out.add(abs);
  }

  for (const u of extractAllUrls(text)) {
    if (isPlayableMediaUrl(u)) out.add(u);
  }

  return [...out];
}

async function fetchWithRedirects(url, referer = null, maxHops = MAX_REDIRECT_HOPS) {
  const hops = [];
  let current = url;
  let redirects = 0;

  for (let i = 0; i <= maxHops; i += 1) {
    let res;
    try {
      res = await request(
        {
          method: 'get',
          url: current,
          maxRedirects: 0,
          validateStatus: () => true,
        },
        {
          providerName: 'animeheaven',
          timeout: REQUEST_TIMEOUT_MS,
          streaming: true,
          extraHeaders: referer ? { Referer: referer } : undefined,
        }
      );
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
        finalUrl: current,
        finalStatus: 0,
        redirectCount: redirects,
        hops,
        html: '',
      };
    }

    const status = Number(res.status || 0);
    const location = res.headers && (res.headers.location || res.headers.Location);
    const body = typeof res.data === 'string' ? res.data : String(res.data || '');

    hops.push({ url: current, status, location: location || null });

    const isHttpRedirect = status >= 300 && status < 400 && location;
    const metaRedirect = body.match(/<meta[^>]+http-equiv=['"]refresh['"][^>]*content=['"][^;]+;\s*url=([^'">]+)['"]/i);
    const jsRedirect = body.match(/location\.(?:href|assign|replace)\s*\(?\s*['"]([^'"]+)['"]/i)
      || body.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i);

    const next = isHttpRedirect
      ? toAbs(current, location)
      : (metaRedirect ? toAbs(current, metaRedirect[1]) : (jsRedirect ? toAbs(current, jsRedirect[1]) : null));

    if (next && next !== current) {
      redirects += 1;
      current = next;
      referer = current;
      continue;
    }

    return {
      ok: status >= 200 && status < 400,
      finalUrl: current,
      finalStatus: status,
      redirectCount: redirects,
      hops,
      html: body,
      error: null,
    };
  }

  return {
    ok: false,
    finalUrl: current,
    finalStatus: 0,
    redirectCount: redirects,
    hops,
    html: '',
    error: 'redirect_limit_exceeded',
  };
}

async function crawlNestedIframes(html, baseUrl, depth = 0, visited = new Set(), trace = []) {
  if (depth > MAX_IFRAME_DEPTH) {
    return { streamUrls: [], maxDepth: depth - 1, trace };
  }

  const direct = extractPlayableUrls(html, baseUrl);
  const streamSet = new Set(direct);
  let maxDepth = depth;

  const iframes = extractIframeUrls(html, baseUrl);
  for (const iframeUrl of iframes) {
    if (!iframeUrl || visited.has(iframeUrl)) continue;
    visited.add(iframeUrl);

    const fetched = await fetchWithRedirects(iframeUrl, baseUrl);
    trace.push({
      depth,
      iframeUrl,
      finalUrl: fetched.finalUrl,
      status: fetched.finalStatus,
      redirectCount: fetched.redirectCount,
      error: fetched.error,
    });

    if (!fetched.ok || !fetched.html) continue;

    const nested = await crawlNestedIframes(fetched.html, fetched.finalUrl || iframeUrl, depth + 1, visited, trace);
    maxDepth = Math.max(maxDepth, nested.maxDepth);
    for (const u of nested.streamUrls) streamSet.add(u);
  }

  return {
    streamUrls: [...streamSet],
    maxDepth,
    trace,
  };
}

async function validateMirror(mirrorUrl, context) {
  const mirrorName = detectMirrorName(mirrorUrl);
  const resolved = await fetchWithRedirects(mirrorUrl, context.pageUrl || null);

  const result = {
    title: context.title,
    identifier: context.identifier,
    episodeNumber: context.episodeNumber,
    mirrorUrl,
    mirrorName,
    success: false,
    failureReason: null,
    httpStatus: resolved.finalStatus,
    redirectCount: resolved.redirectCount,
    iframeDepth: 0,
    streamCount: 0,
    finalPlayerUrl: resolved.finalUrl || null,
    redirectChain: resolved.hops,
  };

  if (!resolved.ok) {
    result.failureReason = resolved.error || (resolved.finalStatus ? `http_${resolved.finalStatus}` : 'request_failed');
    return result;
  }

  if (isPlayableMediaUrl(resolved.finalUrl)) {
    result.success = true;
    result.streamCount = 1;
    result.iframeDepth = 0;
    return result;
  }

  if (!resolved.html) {
    result.failureReason = 'empty_response';
    return result;
  }

  const baseStreams = extractPlayableUrls(resolved.html, resolved.finalUrl || mirrorUrl);
  const nested = await crawlNestedIframes(resolved.html, resolved.finalUrl || mirrorUrl);

  const allStreams = new Set([...baseStreams, ...nested.streamUrls]);
  result.streamCount = allStreams.size;
  result.iframeDepth = nested.maxDepth;

  if (result.streamCount > 0) {
    result.success = true;
    return result;
  }

  if (nested.trace.some((t) => t.error)) {
    result.failureReason = 'iframe_fetch_failed';
  } else {
    result.failureReason = 'no_stream_in_mirror_player';
  }

  return result;
}

function loadSeedTitles() {
  const preferred = path.join(process.cwd(), 'tmp', 'subtitle-validation.json');
  if (!fs.existsSync(preferred)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(preferred, 'utf8'));
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const out = [];

    for (const row of rows) {
      if (!row || !row.identifier) continue;
      out.push({ identifier: row.identifier, title: row.title || row.identifier });
      if (out.length >= 120) break;
    }

    return out;
  } catch {
    return [];
  }
}

async function discoverFallbackTitles(limit = 120) {
  const found = new Map();
  const seeds = [...'abcdefghijklmnopqrstuvwxyz0123456789'];

  for (const q of seeds) {
    if (found.size >= limit) break;
    try {
      const rows = await provider.searchAnime(q, 12);
      for (const r of rows || []) {
        if (!r || !r.identifier || found.has(r.identifier)) continue;
        found.set(r.identifier, { identifier: r.identifier, title: r.title || r.identifier });
        if (found.size >= limit) break;
      }
    } catch {
      // continue
    }
  }

  return [...found.values()];
}

async function gatherEpisodeTargets(minEpisodes) {
  const titles = loadSeedTitles();
  const allTitles = titles.length ? titles : await discoverFallbackTitles(120);

  const episodeTargets = [];
  const titleScan = [];

  for (const title of allTitles) {
    if (episodeTargets.length >= minEpisodes) break;

    try {
      const episodes = await provider.getEpisodeList(title.identifier);
      if (!Array.isArray(episodes) || !episodes.length) {
        titleScan.push({ identifier: title.identifier, title: title.title, episodeCount: 0 });
        continue;
      }

      titleScan.push({ identifier: title.identifier, title: title.title, episodeCount: episodes.length });

      for (const ep of episodes.slice(0, 3)) {
        episodeTargets.push({
          identifier: title.identifier,
          title: title.title,
          episodeNumber: ep.number,
          episodeKey: ep.key,
        });
        if (episodeTargets.length >= minEpisodes) break;
      }
    } catch (error) {
      titleScan.push({ identifier: title.identifier, title: title.title, error: error.message || String(error) });
    }
  }

  return { episodeTargets, titleScan, seedTitleCount: allTitles.length };
}

async function run() {
  const startedAt = new Date().toISOString();

  const { episodeTargets, titleScan, seedTitleCount } = await gatherEpisodeTargets(TARGET_EPISODES);

  const episodes = [];
  const mirrorResults = [];
  const mirrorUrlSeen = new Set();
  const mirrorHostSeen = new Set();
  const nonMirrorHostsSeen = new Set();

  for (const target of episodeTargets.slice(0, TARGET_EPISODES)) {
    const episodeRow = {
      title: target.title,
      identifier: target.identifier,
      episodeNumber: target.episodeNumber,
      resolvePlayerStatus: 'not_run',
      resolveReason: null,
      sourceCount: 0,
      discoveredMirrorUrls: [],
      discoveredSourceHosts: [],
      pageUrl: null,
    };

    try {
      const player = await provider.resolvePlayer({
        title: target.title,
        identifier: target.identifier,
        episode: target.episodeNumber,
      });

      episodeRow.resolvePlayerStatus = (player && !player.reason) ? 'success' : 'failure';
      episodeRow.resolveReason = player ? (player.reason || null) : 'null_player';
      episodeRow.pageUrl = player && player.pageUrl ? player.pageUrl : null;

      const sourceUrls = [];
      const sources = Array.isArray(player && player.sources) ? player.sources : [];

      for (const s of sources) {
        if (!s || !s.url) continue;
        sourceUrls.push(s.url);
      }

      if (player && player.html) {
        for (const u of extractAllUrls(player.html)) sourceUrls.push(u);
      }

      const uniqueSourceUrls = [...new Set(sourceUrls)];
      episodeRow.sourceCount = uniqueSourceUrls.length;

      const sourceHosts = new Set();
      for (const u of uniqueSourceUrls) {
        const host = getHost(u);
        if (host) sourceHosts.add(host);
      }
      episodeRow.discoveredSourceHosts = [...sourceHosts];

      const mirrorCandidates = new Set();
      for (const u of uniqueSourceUrls) {
        if (isMirrorUrl(u)) {
          mirrorCandidates.add(u);
          mirrorUrlSeen.add(u);
          mirrorHostSeen.add(getHost(u));
        } else {
          const host = getHost(u);
          if (host) nonMirrorHostsSeen.add(host);
        }
      }

      episodeRow.discoveredMirrorUrls = [...mirrorCandidates];

      for (const mirrorUrl of mirrorCandidates) {
        const mirrorRow = await validateMirror(mirrorUrl, {
          title: target.title,
          identifier: target.identifier,
          episodeNumber: target.episodeNumber,
          pageUrl: player.pageUrl || null,
        });
        mirrorResults.push(mirrorRow);
      }
    } catch (error) {
      episodeRow.resolvePlayerStatus = 'failure';
      episodeRow.resolveReason = error.message || String(error);
    }

    episodes.push(episodeRow);
  }

  const successCount = mirrorResults.filter((m) => m.success).length;
  const failureCount = mirrorResults.filter((m) => !m.success).length;

  const mirrorNeverAppeared = mirrorResults.length === 0;

  const output = {
    generatedAt: new Date().toISOString(),
    startedAt,
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      minEpisodesRequired: TARGET_EPISODES,
      episodesTested: episodes.length,
      maxRedirectHops: MAX_REDIRECT_HOPS,
      maxIframeDepth: MAX_IFRAME_DEPTH,
    },
    discovery: {
      seedTitleCount,
      titleScan,
      discoveredMirrorUrls: [...mirrorUrlSeen],
      discoveredMirrorHosts: [...mirrorHostSeen],
      discoveredNonMirrorHosts: [...nonMirrorHostsSeen],
      mirrorNeverAppeared,
    },
    mirrorValidationSummary: {
      mirrorsValidated: mirrorResults.length,
      successCount,
      failureCount,
    },
    mirrorResults,
    episodes,
  };

  fs.writeFileSync('mirror-validation.json', JSON.stringify(output, null, 2));

  console.log('WROTE mirror-validation.json');
  console.log('EPISODES_TESTED', episodes.length);
  console.log('MIRRORS_DISCOVERED', mirrorUrlSeen.size);
  console.log('MIRRORS_VALIDATED', mirrorResults.length);
}

run().catch((error) => {
  console.error('MIRROR_AUDIT_FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
