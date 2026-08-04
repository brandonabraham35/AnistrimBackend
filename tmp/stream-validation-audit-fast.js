const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const EPISODE_TARGET = 100;
const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_CONCURRENCY = 40;

function detectFormat(url, contentType) {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (/\.m3u8(\?|$)/.test(u) || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) return 'M3U8';
  if (/\.mpd(\?|$)/.test(u) || ct.includes('application/dash+xml')) return 'DASH';
  if (/\.mp4(\?|$)/.test(u) || ct.includes('video/mp4')) return 'MP4';
  if (/\.mp3(\?|$)|\.m4a(\?|$)|\.aac(\?|$)|\.ogg(\?|$)|\.wav(\?|$)/.test(u) || ct.startsWith('audio/')) return 'AUDIO';
  return 'UNKNOWN';
}

function parseCodec(contentType, snippet, format) {
  const ct = String(contentType || '');
  const m = ct.match(/codecs?="?([^";]+)"?/i);
  if (m) return m[1].trim();

  const text = String(snippet || '');
  if (format === 'M3U8') {
    const c = text.match(/CODECS="([^"]+)"/i);
    if (c) return c[1].trim();
  }
  if (format === 'DASH') {
    const c = text.match(/codecs="([^"]+)"/i);
    if (c) return c[1].trim();
  }
  return null;
}

function parseContentLength(headers) {
  const v = headers.get('content-length');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isAudio(format, contentType, codec) {
  if (format === 'AUDIO') return true;
  const ct = String(contentType || '').toLowerCase();
  const c = String(codec || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  if (c.includes('mp4a') && !c.includes('avc') && !c.includes('hvc') && !c.includes('vp9') && !c.includes('av01')) return true;
  return false;
}

async function fetchOnce(url, method, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method, headers, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRedirects(url, method = 'HEAD', headers = {}) {
  let current = url;
  let redirectCount = 0;
  const chain = [];

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    let res;
    try {
      res = await fetchOnce(current, method, headers);
    } catch (e) {
      return { ok: false, status: 0, error: e.message || String(e), finalUrl: current, redirectCount, chain, headers: null, bodySnippet: null };
    }

    const status = Number(res.status || 0);
    const location = res.headers.get('location');
    chain.push({ url: current, status, location: location || null });

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      current = new URL(location, current).toString();
      redirectCount += 1;
      continue;
    }

    let bodySnippet = null;
    if (method !== 'HEAD') {
      try {
        bodySnippet = await res.text();
      } catch {
        bodySnippet = null;
      }
    }

    return { ok: status >= 200 && status < 400, status, error: null, finalUrl: current, redirectCount, chain, headers: res.headers, bodySnippet };
  }

  return { ok: false, status: 0, error: 'redirect_limit_exceeded', finalUrl: current, redirectCount, chain, headers: null, bodySnippet: null };
}

async function probeUrl(url) {
  let r = await fetchWithRedirects(url, 'HEAD');
  if (!r.ok && [0, 403, 405].includes(r.status)) {
    r = await fetchWithRedirects(url, 'GET', { Range: 'bytes=0-4095' });
  }

  const contentType = r.headers ? (r.headers.get('content-type') || null) : null;
  const contentLength = r.headers ? parseContentLength(r.headers) : null;
  const format = detectFormat(r.finalUrl || url, contentType);
  const codec = parseCodec(contentType, r.bodySnippet, format);

  return {
    url,
    finalUrl: r.finalUrl || url,
    format,
    audio: isAudio(format, contentType, codec),
    contentLength,
    contentType,
    httpStatus: r.status,
    redirectCount: r.redirectCount,
    codec,
    broken: !r.ok || ![200, 206].includes(Number(r.status || 0)),
    brokenReason: (!r.ok || ![200, 206].includes(Number(r.status || 0))) ? (r.error || `http_${r.status || 0}`) : null,
    redirectChain: r.chain,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;

  async function runOne() {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (e) {
        out[i] = { __error: e.message || String(e) };
      }
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) runners.push(runOne());
  await Promise.all(runners);
  return out;
}

function seedsFromMetadata() {
  const file = 'metadata-completeness.json';
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed.records) ? parsed.records : [];
    return rows.filter((r) => r && r.identifier && r.title).map((r) => ({ identifier: r.identifier, title: r.title }));
  } catch {
    return [];
  }
}

async function discoverFallback() {
  const out = new Map();
  const chars = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
  for (const q of chars) {
    if (out.size >= 150) break;
    try {
      const rows = await provider.searchAnime(q, 10);
      for (const row of rows || []) {
        if (!row || !row.identifier || !row.title || out.has(row.identifier)) continue;
        out.set(row.identifier, { identifier: row.identifier, title: row.title });
        if (out.size >= 150) break;
      }
    } catch {
      // ignore
    }
  }
  return [...out.values()];
}

async function buildEpisodeTargets() {
  const seeds = seedsFromMetadata();
  const source = seeds.length ? seeds : await discoverFallback();
  const episodes = [];

  for (const s of source) {
    if (episodes.length >= EPISODE_TARGET) break;
    try {
      const list = await provider.getEpisodeList(s.identifier);
      if (!Array.isArray(list) || !list.length) continue;
      for (const ep of list.slice(0, 3)) {
        episodes.push({ title: s.title, identifier: s.identifier, episode: ep.number });
        if (episodes.length >= EPISODE_TARGET) break;
      }
    } catch {
      // ignore
    }
  }

  return episodes.slice(0, EPISODE_TARGET);
}

async function run() {
  const targets = await buildEpisodeTargets();
  if (targets.length < EPISODE_TARGET) throw new Error(`insufficient_episode_targets:${targets.length}`);

  const episodes = [];
  const streamRefs = [];

  for (const t of targets) {
    let result = null;
    let err = null;
    try {
      result = await provider.extractStreams({ title: t.title, identifier: t.identifier, episode: t.episode });
    } catch (e) {
      err = e.message || String(e);
    }

    const sources = Array.isArray(result && result.sources) ? result.sources : [];
    const ep = {
      title: t.title,
      identifier: t.identifier,
      episode: t.episode,
      extractReason: (result && result.reason) || err || null,
      streamCount: sources.length,
      streamIndexes: [],
    };

    for (let i = 0; i < sources.length; i += 1) {
      const s = sources[i];
      if (!s || !s.url) continue;
      streamRefs.push({
        episodeRef: `${t.identifier}|${t.episode}`,
        title: t.title,
        identifier: t.identifier,
        episode: t.episode,
        url: s.url,
        qualityLabel: s.quality || null,
      });
      ep.streamIndexes.push(streamRefs.length - 1);
    }

    episodes.push(ep);
  }

  const uniqueUrls = [...new Set(streamRefs.map((s) => s.url))];
  const probeResults = await mapWithConcurrency(uniqueUrls, PROBE_CONCURRENCY, async (url) => probeUrl(url));
  const probeMap = new Map(uniqueUrls.map((u, i) => [u, probeResults[i]]));

  const streams = streamRefs.map((ref) => {
    const p = probeMap.get(ref.url) || {
      url: ref.url,
      finalUrl: ref.url,
      format: 'UNKNOWN',
      audio: false,
      contentLength: null,
      contentType: null,
      httpStatus: 0,
      redirectCount: 0,
      codec: null,
      broken: true,
      brokenReason: 'probe_missing',
      redirectChain: [],
    };

    return {
      ...ref,
      finalUrl: p.finalUrl,
      format: p.format,
      audio: p.audio,
      contentLength: p.contentLength,
      contentType: p.contentType,
      httpStatus: p.httpStatus,
      redirectCount: p.redirectCount,
      codec: p.codec,
      broken: p.broken,
      brokenReason: p.brokenReason,
      redirectChain: p.redirectChain,
    };
  });

  const formatCounts = streams.reduce((a, s) => { a[s.format] = (a[s.format] || 0) + 1; return a; }, {});
  const statusCounts = streams.reduce((a, s) => { const k = String(s.httpStatus || 0); a[k] = (a[k] || 0) + 1; return a; }, {});
  const broken = streams.filter((s) => s.broken).length;

  const summary = {
    episodesTested: episodes.length,
    totalExtractedStreams: streams.length,
    uniqueUrlsProbed: uniqueUrls.length,
    formatCounts,
    audioStreams: streams.filter((s) => s.audio).length,
    brokenStreams: broken,
    healthyStreams: streams.length - broken,
    avgRedirectCount: streams.length ? Number((streams.reduce((a, s) => a + Number(s.redirectCount || 0), 0) / streams.length).toFixed(3)) : 0,
    statusCounts,
    qualityLabels: [...new Set(streams.map((s) => s.qualityLabel).filter(Boolean))],
  };

  const output = {
    generatedAt: new Date().toISOString(),
    provider: 'services/animeHeavenProvider.js',
    constraints: {
      requestedEpisodes: EPISODE_TARGET,
      validatedEpisodes: episodes.length,
    },
    summary,
    episodes,
    streams,
  };

  fs.writeFileSync('stream-validation.json', JSON.stringify(output, null, 2));
  console.log('WROTE stream-validation.json');
  console.log('EPISODES', episodes.length, 'STREAMS', streams.length, 'BROKEN', broken);
  console.log('FORMATS', JSON.stringify(formatCounts));
}

run().catch((err) => {
  console.error('STREAM_VALIDATION_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
