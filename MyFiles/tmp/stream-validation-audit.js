const fs = require('fs');

const logger = require('../utils/logger');
['info', 'warn', 'stream', 'streamAttempt', 'debugStream', 'debug', 'error'].forEach((k) => {
  if (logger[k]) logger[k] = () => {};
});

const { provider } = require('../services/animeHeavenProvider');

const EPISODE_TARGET = 100;
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 15000;

function detectFormat(url, contentType) {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();

  if (/\.m3u8(\?|$)/.test(u) || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) return 'M3U8';
  if (/\.mpd(\?|$)/.test(u) || ct.includes('application/dash+xml')) return 'DASH';
  if (/\.mp4(\?|$)/.test(u) || ct.includes('video/mp4')) return 'MP4';
  if (/\.mp3(\?|$)|\.m4a(\?|$)|\.aac(\?|$)|\.ogg(\?|$)|\.wav(\?|$)/.test(u)) return 'AUDIO';
  if (ct.startsWith('audio/')) return 'AUDIO';
  return 'UNKNOWN';
}

function parseCodec(contentType, bodySnippet, format) {
  const ct = String(contentType || '');
  const codecInCt = ct.match(/codecs?="?([^";]+)"?/i);
  if (codecInCt) return codecInCt[1].trim();

  const text = String(bodySnippet || '');

  if (format === 'M3U8') {
    const m = text.match(/CODECS="([^"]+)"/i);
    if (m) return m[1].trim();
  }

  if (format === 'DASH') {
    const m = text.match(/codecs="([^"]+)"/i);
    if (m) return m[1].trim();
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
  const ct = String(contentType || '').toLowerCase();
  const c = String(codec || '').toLowerCase();
  if (format === 'AUDIO') return true;
  if (ct.startsWith('audio/')) return true;
  if (c && !c.includes('avc') && !c.includes('hvc') && !c.includes('vp9') && !c.includes('av01') && c.includes('mp4a')) return true;
  return false;
}

async function fetchOnce(url, method, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRedirects(url, options = {}) {
  const method = options.method || 'HEAD';
  const headers = options.headers || {};

  let current = url;
  let redirectCount = 0;
  const chain = [];

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    let res;
    try {
      res = await fetchOnce(current, method, headers);
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        status: 0,
        finalUrl: current,
        redirectCount,
        chain,
        headers: null,
        bodySnippet: null,
      };
    }

    const status = Number(res.status || 0);
    const location = res.headers.get('location');
    chain.push({ url: current, status, location: location || null });

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      const next = new URL(location, current).toString();
      redirectCount += 1;
      current = next;
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

    return {
      ok: status >= 200 && status < 400,
      error: null,
      status,
      finalUrl: current,
      redirectCount,
      chain,
      headers: res.headers,
      bodySnippet,
    };
  }

  return {
    ok: false,
    error: 'redirect_limit_exceeded',
    status: 0,
    finalUrl: current,
    redirectCount,
    chain,
    headers: null,
    bodySnippet: null,
  };
}

async function probeStream(url, qualityLabel) {
  let res = await fetchWithRedirects(url, { method: 'HEAD' });

  // Some hosts reject HEAD; fallback to GET small range.
  if (!res.ok && [0, 403, 405].includes(res.status)) {
    res = await fetchWithRedirects(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-8191' },
    });
  }

  const headers = res.headers;
  const contentType = headers ? (headers.get('content-type') || null) : null;
  const contentLength = headers ? parseContentLength(headers) : null;
  const format = detectFormat(res.finalUrl || url, contentType);

  let codec = parseCodec(contentType, res.bodySnippet, format);

  if (!codec && (format === 'M3U8' || format === 'DASH') && res.ok) {
    const follow = await fetchWithRedirects(res.finalUrl || url, {
      method: 'GET',
      headers: { Range: 'bytes=0-65535' },
    });
    if (follow.bodySnippet) {
      codec = parseCodec(contentType, follow.bodySnippet, format);
      if (!res.bodySnippet) res.bodySnippet = follow.bodySnippet;
    }
  }

  const broken = !res.ok || ![200, 206, 301, 302, 303, 307, 308].includes(Number(res.status || 0));
  const reason = broken ? (res.error || `http_${res.status || 0}`) : null;

  return {
    url,
    finalUrl: res.finalUrl || url,
    qualityLabel: qualityLabel || null,
    format,
    audio: isAudio(format, contentType, codec),
    contentLength,
    contentType,
    httpStatus: res.status,
    redirectCount: res.redirectCount,
    codec,
    broken,
    brokenReason: reason,
    redirectChain: res.chain,
  };
}

function getSeedsFromFile() {
  const file = 'metadata-completeness.json';
  if (!fs.existsSync(file)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rec = Array.isArray(parsed.records) ? parsed.records : [];
    return rec
      .filter((r) => r && r.identifier && r.title)
      .map((r) => ({ identifier: r.identifier, title: r.title }));
  } catch {
    return [];
  }
}

async function discoverSeedsFallback() {
  const out = new Map();
  const letters = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789'];
  for (const q of letters) {
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
  const seeds = getSeedsFromFile();
  const source = seeds.length ? seeds : await discoverSeedsFallback();

  const episodes = [];
  for (const s of source) {
    if (episodes.length >= EPISODE_TARGET) break;

    try {
      const list = await provider.getEpisodeList(s.identifier);
      if (!Array.isArray(list) || !list.length) continue;

      for (const ep of list.slice(0, 3)) {
        episodes.push({
          title: s.title,
          identifier: s.identifier,
          episode: ep.number,
        });
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
  if (targets.length < EPISODE_TARGET) {
    throw new Error(`insufficient_episode_targets:${targets.length}`);
  }

  const episodes = [];
  const streams = [];

  for (const t of targets) {
    let result = null;
    let err = null;

    try {
      result = await provider.extractStreams({
        title: t.title,
        identifier: t.identifier,
        episode: t.episode,
      });
    } catch (e) {
      err = e.message || String(e);
    }

    const sourceList = Array.isArray(result && result.sources) ? result.sources : [];

    const epRow = {
      title: t.title,
      identifier: t.identifier,
      episode: t.episode,
      extractReason: result && result.reason ? result.reason : (err || null),
      streamCount: sourceList.length,
      streamIndexes: [],
    };

    for (let i = 0; i < sourceList.length; i += 1) {
      const src = sourceList[i];
      const url = src && src.url ? src.url : null;
      if (!url) continue;

      // eslint-disable-next-line no-await-in-loop
      const probed = await probeStream(url, src.quality || null);
      const row = {
        episodeRef: `${t.identifier}|${t.episode}`,
        title: t.title,
        identifier: t.identifier,
        episode: t.episode,
        ...probed,
      };
      streams.push(row);
      epRow.streamIndexes.push(streams.length - 1);
    }

    episodes.push(epRow);
  }

  const formatCounts = streams.reduce((acc, s) => {
    const k = s.format || 'UNKNOWN';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const brokenCount = streams.filter((s) => s.broken).length;
  const audioCount = streams.filter((s) => s.audio).length;

  const summary = {
    episodesTested: episodes.length,
    totalStreams: streams.length,
    formatCounts,
    audioStreams: audioCount,
    brokenStreams: brokenCount,
    healthyStreams: streams.length - brokenCount,
    avgRedirectCount: streams.length
      ? Number((streams.reduce((a, s) => a + Number(s.redirectCount || 0), 0) / streams.length).toFixed(3))
      : 0,
    statusCounts: streams.reduce((acc, s) => {
      const k = String(s.httpStatus || 0);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
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
  console.log('EPISODES', episodes.length, 'STREAMS', streams.length, 'BROKEN', brokenCount);
  console.log('FORMATS', JSON.stringify(formatCounts));
}

run().catch((err) => {
  console.error('STREAM_VALIDATION_FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
