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
const REQUEST_TIMEOUT_MS = 7000;
const PROVIDER_CALL_TIMEOUT_MS = 12000;
const EPISODE_PROCESS_TIMEOUT_MS = 30000;
const MAX_SOURCE_CHAIN_PROBES = 3;
const MAX_ENDPOINT_PROBES_PER_EPISODE = 2;
const MAX_ENDPOINT_CANDIDATES_PER_EPISODE = 20;
const MAX_DISCOVERED_URLS_PER_EPISODE = 160;

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

function decodeBase64Maybe(value) {
  const token = String(value || '').trim();
  if (!token || token.length < 16) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(token)) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    return decoded || null;
  } catch {
    return null;
  }
}

function extractBase64DecodedUrls(raw) {
  const text = String(raw || '');
  const out = new Set();
  const tokenRx = /['"]([A-Za-z0-9+/=]{20,})['"]/g;
  let m;
  while ((m = tokenRx.exec(text)) !== null) {
    const decoded = decodeBase64Maybe(m[1]);
    if (!decoded) continue;
    const urls = decoded.match(/https?:\/\/[^'"\s<>]+/gi) || [];
    for (const u of urls) out.add(u);
  }
  return [...out];
}

function extractJsonStrings(raw) {
  const text = String(raw || '');
  const snippets = text.match(/\{[\s\S]{20,4000}?\}|\[[\s\S]{20,4000}?\]/g) || [];
  const out = [];
  for (const snippet of snippets) {
    try {
      const parsed = JSON.parse(snippet);
      out.push(parsed);
    } catch {
      // ignore invalid JSON-like snippets
    }
  }
  return out;
}

function collectUrlsFromObject(root, out = new Set()) {
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }

    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        const urls = value.match(/https?:\/\/[^'"\s<>]+/gi) || [];
        for (const u of urls) out.add(u);
      } else if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }
  return out;
}

function analyzeDynamicSignals(rawHtml) {
  const html = String(rawHtml || '');
  const lower = html.toLowerCase();
  return {
    hasFetch: /fetch\s*\(/i.test(html),
    hasXHR: /xmlhttprequest|\bxhr\b|new\s+xhr/i.test(html),
    hasAjax: /\$\.ajax|jquery\.ajax|axios\.|\bajax\s*\(/i.test(html),
    hasEmbeddedJson: /<script[^>]+type=['"]application\/(ld\+json|json)['"]/i.test(html),
    hasBase64Payloads: /[A-Za-z0-9+/=]{24,}/.test(html),
    hasRedirectPatterns: /location\.(assign|replace|href)|window\.location|http-equiv=['"]refresh/i.test(html),
    hasGatePattern: /gate\.php|\bgatea\s*\(/i.test(lower),
  };
}

function extractEndpointCandidates(rawHtml, baseUrl) {
  const html = String(rawHtml || '');
  const out = new Set();

  const directAbs = html.match(/https?:\/\/[^'"\s<>]+/gi) || [];
  for (const url of directAbs) {
    if (/\/(api|ajax|embed|player|stream|source|mirror|gate)\b/i.test(url)) out.add(url);
  }

  const relRx = /['"](\/(?:api|ajax|embed|player|stream|source|mirror|gate)[^'"\s<>]*)['"]/gi;
  let m;
  while ((m = relRx.exec(html)) !== null) {
    const abs = toAbs(baseUrl, m[1]);
    if (abs) out.add(abs);
  }

  return [...out].slice(0, MAX_ENDPOINT_CANDIDATES_PER_EPISODE);
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
          dontTrackHealth: true,
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

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

async function crawlNestedEvidence(html, baseUrl, depth = 0, visited = new Set()) {
  if (depth > MAX_IFRAME_DEPTH) {
    return {
      maxDepth: Math.max(0, depth - 1),
      urls: [],
      mirrorUrls: [],
      endpointCandidates: [],
      iframeTrace: [],
      dynamicSignals: {
        hasFetch: false,
        hasXHR: false,
        hasAjax: false,
        hasEmbeddedJson: false,
        hasBase64Payloads: false,
        hasRedirectPatterns: false,
        hasGatePattern: false,
      },
    };
  }

  const urls = new Set();
  const mirrorUrls = new Set();
  const endpointCandidates = new Set();
  const iframeTrace = [];

  const mergeSignals = (lhs, rhs) => ({
    hasFetch: lhs.hasFetch || rhs.hasFetch,
    hasXHR: lhs.hasXHR || rhs.hasXHR,
    hasAjax: lhs.hasAjax || rhs.hasAjax,
    hasEmbeddedJson: lhs.hasEmbeddedJson || rhs.hasEmbeddedJson,
    hasBase64Payloads: lhs.hasBase64Payloads || rhs.hasBase64Payloads,
    hasRedirectPatterns: lhs.hasRedirectPatterns || rhs.hasRedirectPatterns,
    hasGatePattern: lhs.hasGatePattern || rhs.hasGatePattern,
  });

  let dynamicSignals = analyzeDynamicSignals(html);

  const directUrls = extractAllUrls(html);
  const decodedUrls = extractBase64DecodedUrls(html);
  const jsonPayloads = extractJsonStrings(html);
  const jsonUrls = new Set();
  for (const payload of jsonPayloads) {
    for (const u of collectUrlsFromObject(payload)) jsonUrls.add(u);
  }

  for (const u of [...directUrls, ...decodedUrls, ...jsonUrls]) {
    const abs = /^https?:\/\//i.test(u) ? u : toAbs(baseUrl, u);
    if (!abs) continue;
    urls.add(abs);
    if (isMirrorUrl(abs)) mirrorUrls.add(abs);
  }

  for (const ep of extractEndpointCandidates(html, baseUrl)) endpointCandidates.add(ep);

  let maxDepth = depth;
  const iframeUrls = extractIframeUrls(html, baseUrl);
  for (const iframeUrl of iframeUrls) {
    if (!iframeUrl || visited.has(iframeUrl)) continue;
    visited.add(iframeUrl);

    const fetched = await fetchWithRedirects(iframeUrl, baseUrl);
    iframeTrace.push({
      depth,
      iframeUrl,
      finalUrl: fetched.finalUrl,
      status: fetched.finalStatus,
      redirectCount: fetched.redirectCount,
      redirectChain: fetched.hops,
      error: fetched.error,
    });

    if (!fetched.ok || !fetched.html) continue;
    const nested = await crawlNestedEvidence(fetched.html, fetched.finalUrl || iframeUrl, depth + 1, visited);
    maxDepth = Math.max(maxDepth, nested.maxDepth);
    dynamicSignals = mergeSignals(dynamicSignals, nested.dynamicSignals);

    for (const u of nested.urls) {
      urls.add(u);
      if (isMirrorUrl(u)) mirrorUrls.add(u);
    }
    for (const ep2 of nested.endpointCandidates) endpointCandidates.add(ep2);
    for (const t of nested.iframeTrace) iframeTrace.push(t);
  }

  return {
    maxDepth,
    urls: [...urls],
    mirrorUrls: [...mirrorUrls],
    endpointCandidates: [...endpointCandidates].slice(0, MAX_ENDPOINT_CANDIDATES_PER_EPISODE),
    iframeTrace,
    dynamicSignals,
  };
}

async function probeEndpoints(urls, referer) {
  const out = [];
  for (const endpointUrl of (urls || []).slice(0, MAX_ENDPOINT_PROBES_PER_EPISODE)) {
    const hit = await fetchWithRedirects(endpointUrl, referer, 4);
    out.push({
      url: endpointUrl,
      success: !!hit.ok,
      status: hit.finalStatus,
      finalUrl: hit.finalUrl,
      redirectCount: hit.redirectCount,
      redirectChain: hit.hops,
      responseSample: String(hit.html || '').slice(0, 220),
      error: hit.error,
    });
  }
  return out;
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
      const episodes = await withTimeout(
        provider.getEpisodeList(title.identifier),
        PROVIDER_CALL_TIMEOUT_MS,
        `episode_list:${title.identifier}`
      );
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
  const discoveredUrlsSeen = new Set();
  const globalRedirectChains = [];
  const playerEvidenceSummary = {
    episodesWithFetchSignal: 0,
    episodesWithXHRSignal: 0,
    episodesWithAjaxSignal: 0,
    episodesWithEmbeddedJson: 0,
    episodesWithBase64Payloads: 0,
    episodesWithRedirectPatterns: 0,
    episodesWithGatePattern: 0,
    episodesWithNestedIframes: 0,
  };

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
      discoveredUrls: [],
      mirrorCandidates: [],
      redirectChains: [],
      endpointProbeResults: [],
      iframeDepth: 0,
      iframeTrace: [],
      playerEvidence: null,
      pageUrl: null,
    };

    try {
      await withTimeout((async () => {
      const player = await withTimeout(provider.resolvePlayer({
        title: target.title,
        identifier: target.identifier,
        episode: target.episodeNumber,
      }), PROVIDER_CALL_TIMEOUT_MS, `resolve_player:${target.identifier}:${target.episodeNumber}`);

      episodeRow.resolvePlayerStatus = (player && !player.reason) ? 'success' : 'failure';
      episodeRow.resolveReason = player ? (player.reason || null) : 'null_player';
      episodeRow.pageUrl = player && player.pageUrl ? player.pageUrl : null;

      const sourceUrls = [];
      const sources = Array.isArray(player && player.sources) ? player.sources : [];
      const sourceChainProbes = [];

      for (const s of sources) {
        if (!s || !s.url) continue;
        sourceUrls.push(s.url);
        if (sourceChainProbes.length < MAX_SOURCE_CHAIN_PROBES) {
          sourceChainProbes.push({
            url: s.url,
            quality: s.quality || null,
            language: s.language || s.lang || null,
            priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : null,
          });
        }
      }

      if (player && player.html) {
        for (const u of extractAllUrls(player.html)) sourceUrls.push(u);
        for (const u of extractBase64DecodedUrls(player.html)) sourceUrls.push(u);
        const jsonPayloads = extractJsonStrings(player.html);
        for (const payload of jsonPayloads) {
          for (const u of collectUrlsFromObject(payload)) sourceUrls.push(u);
        }
      }

      const nestedEvidence = await crawlNestedEvidence(player && player.html ? player.html : '', player.pageUrl || null, 0, new Set());
      for (const u of nestedEvidence.urls) sourceUrls.push(u);

      const uniqueSourceUrls = [...new Set(sourceUrls)]
        .filter(Boolean)
        .slice(0, MAX_DISCOVERED_URLS_PER_EPISODE);
      episodeRow.sourceCount = uniqueSourceUrls.length;
      episodeRow.iframeDepth = nestedEvidence.maxDepth;
      episodeRow.iframeTrace = nestedEvidence.iframeTrace;

      const dynamicSignals = nestedEvidence.dynamicSignals;
      episodeRow.playerEvidence = {
        ...dynamicSignals,
        iframeCount: extractIframeUrls(player && player.html ? player.html : '', player.pageUrl || null).length,
        endpointCandidates: nestedEvidence.endpointCandidates,
      };

      if (dynamicSignals.hasFetch) playerEvidenceSummary.episodesWithFetchSignal += 1;
      if (dynamicSignals.hasXHR) playerEvidenceSummary.episodesWithXHRSignal += 1;
      if (dynamicSignals.hasAjax) playerEvidenceSummary.episodesWithAjaxSignal += 1;
      if (dynamicSignals.hasEmbeddedJson) playerEvidenceSummary.episodesWithEmbeddedJson += 1;
      if (dynamicSignals.hasBase64Payloads) playerEvidenceSummary.episodesWithBase64Payloads += 1;
      if (dynamicSignals.hasRedirectPatterns) playerEvidenceSummary.episodesWithRedirectPatterns += 1;
      if (dynamicSignals.hasGatePattern) playerEvidenceSummary.episodesWithGatePattern += 1;
      if ((episodeRow.playerEvidence.iframeCount || 0) > 0 || episodeRow.iframeTrace.length > 0) {
        playerEvidenceSummary.episodesWithNestedIframes += 1;
      }

      const playerChain = player.pageUrl
        ? await fetchWithRedirects(player.pageUrl, null, MAX_REDIRECT_HOPS)
        : null;
      if (playerChain) {
        episodeRow.redirectChains.push({
          type: 'player_page',
          originUrl: player.pageUrl,
          finalUrl: playerChain.finalUrl,
          redirectCount: playerChain.redirectCount,
          chain: playerChain.hops,
        });
      }

      for (const sourceProbe of sourceChainProbes) {
        const chain = await fetchWithRedirects(sourceProbe.url, player.pageUrl || null, 4);
        const chainRow = {
          type: 'source_url',
          originUrl: sourceProbe.url,
          quality: sourceProbe.quality,
          language: sourceProbe.language,
          priority: sourceProbe.priority,
          finalUrl: chain.finalUrl,
          redirectCount: chain.redirectCount,
          chain: chain.hops,
        };
        episodeRow.redirectChains.push(chainRow);
      }

      episodeRow.endpointProbeResults = await probeEndpoints(
        nestedEvidence.endpointCandidates,
        player.pageUrl || null
      );

      for (const chainRow of episodeRow.redirectChains) {
        globalRedirectChains.push({
          identifier: target.identifier,
          episodeNumber: target.episodeNumber,
          ...chainRow,
        });
      }

      const sourceHosts = new Set();
      for (const u of uniqueSourceUrls) {
        const host = getHost(u);
        if (host) sourceHosts.add(host);
        if (u) discoveredUrlsSeen.add(u);
      }
      episodeRow.discoveredSourceHosts = [...sourceHosts];
      episodeRow.discoveredUrls = uniqueSourceUrls;

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

      for (const u of nestedEvidence.mirrorUrls) {
        mirrorCandidates.add(u);
        mirrorUrlSeen.add(u);
        const host = getHost(u);
        if (host) mirrorHostSeen.add(host);
      }

      episodeRow.discoveredMirrorUrls = [...mirrorCandidates];
      episodeRow.mirrorCandidates = [...mirrorCandidates].map((url) => {
        const sourceMeta = sources.find((s) => s && s.url === url) || null;
        return {
          host: getHost(url) || null,
          url,
          quality: sourceMeta ? (sourceMeta.quality || null) : null,
          language: sourceMeta ? (sourceMeta.language || sourceMeta.lang || null) : null,
          priority: sourceMeta && Number.isFinite(Number(sourceMeta.priority)) ? Number(sourceMeta.priority) : null,
          availability: null,
        };
      });

      for (const mirrorUrl of mirrorCandidates) {
        const mirrorRow = await validateMirror(mirrorUrl, {
          title: target.title,
          identifier: target.identifier,
          episodeNumber: target.episodeNumber,
          pageUrl: player.pageUrl || null,
        });
        mirrorResults.push(mirrorRow);

        const idx = episodeRow.mirrorCandidates.findIndex((x) => x.url === mirrorUrl);
        if (idx >= 0) {
          episodeRow.mirrorCandidates[idx].availability = mirrorRow.success ? 'available' : 'unavailable';
        }
      }
      })(), EPISODE_PROCESS_TIMEOUT_MS, `episode_process:${target.identifier}:${target.episodeNumber}`);
    } catch (error) {
      episodeRow.resolvePlayerStatus = 'failure';
      episodeRow.resolveReason = error.message || String(error);
    }

    episodes.push(episodeRow);

    if (episodes.length % 5 === 0) {
      console.log('PROGRESS', episodes.length, '/', Math.min(TARGET_EPISODES, episodeTargets.length));
    }
  }

  const successCount = mirrorResults.filter((m) => m.success).length;
  const failureCount = mirrorResults.filter((m) => !m.success).length;

  const mirrorNeverAppeared = mirrorResults.length === 0;
  const mirrorCount = mirrorUrlSeen.size;

  const dynamicSignalEpisodes = [
    playerEvidenceSummary.episodesWithFetchSignal,
    playerEvidenceSummary.episodesWithXHRSignal,
    playerEvidenceSummary.episodesWithAjaxSignal,
    playerEvidenceSummary.episodesWithGatePattern,
  ].reduce((a, b) => a + (b > 0 ? 1 : 0), 0);

  const episodesWithAnyDynamicSignal = episodes.filter((ep) => {
    const p = ep.playerEvidence || {};
    return !!(p.hasFetch || p.hasXHR || p.hasAjax || p.hasGatePattern);
  }).length;

  const conclusion = mirrorCount > 0
    ? 'mirrors_exposed'
    : (episodesWithAnyDynamicSignal > Math.floor(Math.max(1, episodes.length) * 0.6)
      ? 'mirrors_likely_dynamically_loaded_or_hidden_behind_runtime_api'
      : 'no_runtime_evidence_of_mirror_exposure');

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
      mirrorCount,
      discoveredMirrorUrls: [...mirrorUrlSeen],
      discoveredMirrorHosts: [...mirrorHostSeen],
      discoveredNonMirrorHosts: [...nonMirrorHostsSeen],
      discoveredUrls: [...discoveredUrlsSeen],
      mirrorNeverAppeared,
    },
    playerEvidence: {
      episodesWithAnyDynamicSignal,
      signalCoverage: {
        fetch: playerEvidenceSummary.episodesWithFetchSignal,
        xhr: playerEvidenceSummary.episodesWithXHRSignal,
        ajax: playerEvidenceSummary.episodesWithAjaxSignal,
        embeddedJson: playerEvidenceSummary.episodesWithEmbeddedJson,
        base64Payloads: playerEvidenceSummary.episodesWithBase64Payloads,
        redirectPatterns: playerEvidenceSummary.episodesWithRedirectPatterns,
        gatePattern: playerEvidenceSummary.episodesWithGatePattern,
        nestedIframes: playerEvidenceSummary.episodesWithNestedIframes,
      },
      dynamicSignalFamiliesObserved: dynamicSignalEpisodes,
    },
    redirectChains: {
      totalChainsCaptured: globalRedirectChains.length,
      chains: globalRedirectChains,
    },
    iframeDepth: {
      maxObservedDepth: episodes.reduce((max, ep) => Math.max(max, Number(ep.iframeDepth || 0)), 0),
      episodesWithIframeTraversal: episodes.filter((ep) => Array.isArray(ep.iframeTrace) && ep.iframeTrace.length > 0).length,
    },
    conclusion,
    mirrorValidationSummary: {
      mirrorCount,
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
