'use strict';

const cheerio = require('cheerio');
const logger = require('../utils/logger');
const { request } = require('../utils/providerHttp');
const { PROVIDER_IDS } = require('./providerRegistry');

const PROVIDER_NAME = PROVIDER_IDS.ANIME_HEAVEN;

const CACHE_TTL_MS = 120 * 1000;
const SEARCH_CACHE_TTL_MS = 90 * 1000;
const BASE_URL_TTL_MS = 10 * 60 * 1000;
const COOKIE_TTL_MS = 8 * 60 * 1000;
const MAX_REDIRECT_DEPTH = 4;
const MAX_NESTED_IFRAME_DEPTH = 2;
const MAX_MIRROR_FETCHES = 4;
const MAX_FETCH_RETRIES = 2;

const DOMAIN_CANDIDATES = [
  process.env.ANIMEHEAVEN_BASE_URL,
  'https://animeheaven.me',
  'https://animeheaven.ru',
  'https://www.animeheaven.me',
]
  .filter(Boolean)
  .map(v => String(v).trim().replace(/\/+$/, ''));

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

const CLOUDFLARE_PATTERNS = [
  /cloudflare/i,
  /checking your browser/i,
  /just a moment/i,
  /cf-challenge/i,
  /attention required/i,
  /browser verification/i,
  /access denied/i,
  /captcha/i,
  /please wait while we verify/i,
  /cf-ray/i,
];

const REASON = Object.freeze({
  INVALID_URL: 'invalid_url',
  CLOUDFLARE: 'cloudflare',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  INVALID_HTML: 'invalid_html',
  PLAYER_MISSING: 'player_missing',
  STREAM_MISSING: 'stream_missing',
  EPISODE_MISSING: 'episode_missing',
  SEARCH_EMPTY: 'search_empty',
  RESOLVE_ERROR: 'resolve_error',
});

const pageCache = new Map();
const redirectCache = new Map();
const cookieJar = new Map();

const providerStats = {
  attempts: 0,
  success: 0,
  failures: 0,
  timeouts: 0,
  cloudflare: 0,
  totalLatencyMs: 0,
};

function cacheGet(key) {
  const hit = pageCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    pageCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  pageCache.set(key, {
    value,
    expiresAt: Date.now() + ttl,
  });
}

function getDomainKey(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getCookiesForUrl(url) {
  const key = getDomainKey(url);
  if (!key) return null;
  const row = cookieJar.get(key);
  if (!row || Date.now() > row.expiresAt) {
    cookieJar.delete(key);
    return null;
  }
  const parts = [];
  for (const [name, value] of Object.entries(row.cookies || {})) {
    parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function mergeCookies(url, rawSetCookie) {
  const key = getDomainKey(url);
  if (!key) return;
  const current = cookieJar.get(key);
  const jar = {
    cookies: Object.assign({}, current?.cookies || {}),
    expiresAt: Date.now() + COOKIE_TTL_MS,
  };

  const lines = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
  for (const line of lines.filter(Boolean)) {
    const segment = String(line).split(';')[0] || '';
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    const name = segment.slice(0, idx).trim();
    const val = segment.slice(idx + 1).trim();
    if (name && val) jar.cookies[name] = val;
  }

  cookieJar.set(key, jar);
}

function normalizeEpisodeNumber(input) {
  if (input === undefined || input === null || input === '') return 1;
  const raw = String(input).trim();
  if (!raw) return 1;

  const special = raw.match(/(ova|special|movie)\s*(\d+)?/i);
  if (special) {
    const n = Number(special[2] || '1');
    return 9000 + n;
  }

  const match = raw.match(/(\d+(?:\.\d+)?)/);
  const value = match ? Number(match[1]) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function stripDiacritics(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTitle(input) {
  return stripDiacritics(String(input || ''))
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(input) {
  return String(input || '')
    .replace(/\s*Anime\s*\|\s*AnimeHeaven\.Me\s*$/i, '')
    .replace(/\s*\|\s*AnimeHeaven\.Me\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = normalizeTitle(a);
  const t = normalizeTitle(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const dp = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) dp[j] = j;

  for (let i = 1; i <= s.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const temp = dp[j];
      if (s[i - 1] === t[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
  }

  return dp[t.length];
}

function expandSearchTerms(query) {
  const base = String(query || '').trim();
  if (!base) return [];

  const out = new Set([base]);
  out.add(base.replace(/&/g, ' and '));
  out.add(base.replace(/\band\b/gi, '&'));
  out.add(base.replace(/\bseason\b/gi, 's'));
  out.add(base.replace(/\s+/g, ' '));

  const map = {
    aot: 'attack on titan',
    snk: 'shingeki no kyojin',
    mha: 'my hero academia',
  };
  const words = base.toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (map[w]) out.add(map[w]);
  }

  return [...out].map(v => v.trim()).filter(Boolean);
}

function safeAbsoluteUrl(baseUrl, maybeRelative) {
  if (!maybeRelative) return null;
  const raw = String(maybeRelative).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function detectCloudflare(html) {
  const body = String(html || '').toLowerCase();
  return CLOUDFLARE_PATTERNS.some(rx => rx.test(body));
}

function isRedirectShell(html) {
  const body = String(html || '');
  return /<div\s+id=['"]root['"]><\/div>/i.test(body)
    && /aHR0cHM6\/\//i.test(body)
    && /location\.(assign|replace)|location\[['"]href['"]\]/i.test(body);
}

function extractMetaRedirect(html, baseUrl) {
  const m = String(html || '').match(/<meta[^>]+http-equiv=['"]refresh['"][^>]+content=['"][^;]+;\s*url=([^'">]+)['"]/i);
  return m ? safeAbsoluteUrl(baseUrl, m[1]) : null;
}

function decodeBase64Maybe(value) {
  const token = String(value || '').trim();
  if (!token || token.length < 12) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(token)) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
    return null;
  } catch {
    return null;
  }
}

function extractJsRedirect(html, baseUrl) {
  const body = String(html || '');

  const encodedMatches = body.match(/aHR0cHM6L[^'"\s<]+/gi) || [];
  for (const encoded of encodedMatches) {
    const decoded = decodeBase64Maybe(encoded);
    const url = safeAbsoluteUrl(baseUrl, decoded);
    if (url) return url;
  }

  const direct = body.match(/location\.(?:href|assign|replace)\s*\(?\s*['"]([^'"]+)['"]/i)
    || body.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i);
  return direct ? safeAbsoluteUrl(baseUrl, direct[1]) : null;
}

function extractAllUrls(blob) {
  const raw = String(blob || '');
  const out = new Set();

  const directRx = /https?:\/\/[^'"\s<>]+/gi;
  let m;
  while ((m = directRx.exec(raw)) !== null) out.add(m[0]);

  const b64Rx = /['"]([A-Za-z0-9+/=]{24,})['"]/g;
  while ((m = b64Rx.exec(raw)) !== null) {
    const decoded = decodeBase64Maybe(m[1]);
    if (decoded) out.add(decoded);
  }

  return [...out];
}

function scoreTitleCandidate(candidate, query, aliases = []) {
  const c = normalizeTitle(candidate);
  const q = normalizeTitle(query);
  if (!c || !q) return 0;

  if (c === q) return 130;
  if (c.startsWith(q)) return 115;
  if (c.includes(q)) return 105;

  const cTokens = new Set(c.split(' ').filter(Boolean));
  const qTokens = q.split(' ').filter(Boolean);
  let overlap = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) overlap++;
  }

  let score = overlap * 9;
  if (overlap >= Math.max(2, Math.floor(qTokens.length * 0.65))) score += 24;

  const distance = levenshtein(c, q);
  const maxLen = Math.max(c.length, q.length) || 1;
  const similarity = 1 - (distance / maxLen);
  score += Math.max(0, Math.round(similarity * 40));

  for (const alias of aliases) {
    const a = normalizeTitle(alias);
    if (!a) continue;
    if (a === q) score = Math.max(score, 120);
    else if (a.includes(q) || q.includes(a)) score = Math.max(score, 98);
  }

  return score;
}

function classifyFailure({ status, message, html }) {
  const text = String(message || '');
  const body = String(html || '');
  if (detectCloudflare(body) || /cloudflare|challenge|captcha/i.test(text)) return REASON.CLOUDFLARE;
  if (status === 404) return REASON.NOT_FOUND;
  if (status === 403) return REASON.FORBIDDEN;
  if (status === 429) return REASON.RATE_LIMITED;
  if (/timeout|timed out|etimedout/i.test(text)) return REASON.TIMEOUT;
  if (/enotfound|eai_again|network|socket|connreset|unable to connect/i.test(text)) return REASON.NETWORK;
  return REASON.RESOLVE_ERROR;
}

function recordProviderMetric(kind, latencyMs = 0) {
  providerStats.attempts += 1;
  providerStats.totalLatencyMs += Math.max(0, Number(latencyMs) || 0);
  if (kind === 'success') providerStats.success += 1;
  if (kind === 'timeout') providerStats.timeouts += 1;
  if (kind === 'cloudflare') providerStats.cloudflare += 1;
  if (kind === 'failure') providerStats.failures += 1;
}

function normalizeSearchRow(baseUrl, title, href, image, query, aliases = []) {
  const absolute = safeAbsoluteUrl(baseUrl, href);
  if (!absolute) return null;
  const identifier = absolute.match(/anime\.php\?([^&#]+)/i)?.[1] || null;
  if (!identifier) return null;

  const clean = cleanTitle(title);
  if (!clean) return null;

  const cover = safeAbsoluteUrl(baseUrl, image);

  return {
    id: identifier,
    identifier,
    slug: identifier,
    title: clean,
    url: absolute,
    image: cover,
    cover,
    provider: PROVIDER_NAME,
    score: scoreTitleCandidate(clean, query, aliases),
  };
}

function parseSearchHtml(baseUrl, html, query) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];

  const selectors = [
    'a[href*="anime.php?"]',
    '.fastitem a[href*="anime.php?"]',
    '.similaritem a[href*="anime.php?"]',
    '.p1 a[href*="anime.php?"]',
  ];

  $(selectors.join(',')).each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).find('.fastname,.title,.name').first().text().trim()
      || $(el).attr('title')
      || $(el).find('img').attr('alt')
      || $(el).text().trim();
    const aliases = [
      $(el).find('.jtitle,.jp,.romaji,.en').first().text().trim(),
      $(el).find('small').first().text().trim(),
    ].filter(Boolean);
    const image = $(el).find('img').attr('src')
      || $(el).closest('.similarimg,.fastitem,.p1,.item').find('img').attr('src')
      || null;

    const row = normalizeSearchRow(baseUrl, title, href, image, query, aliases);
    if (row) rows.push(row);
  });

  return rows;
}

function uniqueByIdentifier(items) {
  const best = new Map();
  for (const item of items) {
    if (!item || !item.identifier) continue;
    const prev = best.get(item.identifier);
    if (!prev || Number(item.score || 0) > Number(prev.score || 0)) {
      best.set(item.identifier, item);
    }
  }
  return [...best.values()];
}

function parseEpisodeFromElement($el, fallbackIndex) {
  const text = ($el.find('.watch2,.episode,.ep').first().text().trim() || $el.text().trim());
  const n = normalizeEpisodeNumber(text || fallbackIndex);
  const isSpecial = /ova|special|movie/i.test(text || '');
  return {
    number: n,
    title: text || `Episode ${n}`,
    isSpecial,
  };
}

function parseEpisodes($, baseUrl) {
  const episodes = [];
  const seen = new Set();
  let index = 0;

  const selectors = [
    'a[onclick*="gatea("]',
    'button[onclick*="gatea("]',
    '[data-key][onclick*="gate"]',
    'a[href*="gate.php"]',
    '.watch2',
  ];

  $(selectors.join(',')).each((_, el) => {
    index += 1;
    const $el = $(el);
    const onclick = $el.attr('onclick') || '';
    const key = onclick.match(/gatea\(["']([a-f0-9]{16,})["']\)/i)?.[1]
      || $el.attr('data-key')
      || null;

    if (!key || seen.has(key)) return;

    const href = $el.attr('href') || 'gate.php';
    const ep = parseEpisodeFromElement($el, index);
    seen.add(key);
    episodes.push({
      id: key,
      identifier: key,
      key,
      number: ep.number,
      title: ep.title,
      isSpecial: ep.isSpecial,
      url: safeAbsoluteUrl(baseUrl, href),
    });
  });

  return episodes.sort((a, b) => Number(a.number) - Number(b.number));
}

function parseQualityHint(value) {
  const raw = String(value || '').toLowerCase();
  if (!raw) return 'Unknown';
  if (raw.includes('1080') || raw.includes('fullhd')) return '1080p';
  if (raw.includes('720') || raw.includes('hd')) return '720p';
  if (raw.includes('480')) return '480p';
  if (raw.includes('360')) return '360p';
  if (raw.includes('2160') || raw.includes('4k')) return '2160p';
  return String(value || 'Unknown').trim() || 'Unknown';
}

function qualityRank(quality) {
  const q = String(quality || '').toLowerCase();
  if (q.includes('2160') || q.includes('4k')) return 6;
  if (q.includes('1080')) return 5;
  if (q.includes('720')) return 4;
  if (q.includes('480')) return 3;
  if (q.includes('360')) return 2;
  if (q.includes('auto')) return 1;
  return 0;
}

function sortSourcesByQuality(sources) {
  return [...sources].sort((a, b) => {
    const qa = qualityRank(a.quality);
    const qb = qualityRank(b.quality);
    if (qa !== qb) return qb - qa;
    return String(a.url).localeCompare(String(b.url));
  });
}

function isPlayableMediaUrl(url) {
  const value = String(url || '');
  return /\.(m3u8|mp4|mpd)(\?|$)/i.test(value) || /video\.mp4\?/i.test(value);
}

function looksLikeMirror(url) {
  const host = String(url || '').toLowerCase();
  return MIRROR_HINTS.some(h => host.includes(h));
}

function parseSources(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const out = [];

  const push = (url, quality = 'auto', sourceType = 'direct') => {
    const absolute = safeAbsoluteUrl(baseUrl, url);
    if (!absolute) return;
    if (!/^https?:\/\//i.test(absolute)) return;
    if (out.some(x => x.url === absolute)) return;
    out.push({
      url: absolute,
      quality: parseQualityHint(quality),
      sourceType,
    });
  };

  $('video[src], source[src]').each((_, el) => {
    const src = $(el).attr('src');
    const quality = $(el).attr('label') || $(el).attr('res') || $(el).attr('data-quality') || 'auto';
    push(src, quality, 'video');
  });

  $('track[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && isPlayableMediaUrl(src)) push(src, 'auto', 'track-media');
  });

  $('iframe[src], embed[src]').each((_, el) => {
    push($(el).attr('src'), 'auto', 'iframe');
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (isPlayableMediaUrl(href) || looksLikeMirror(href)) {
      push(href, $(el).attr('data-quality') || $(el).text().trim() || 'auto', 'link');
    }
  });

  const blob = String(html || '');

  const fileRegex = /(?:file|src|source|manifest)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  let fm;
  while ((fm = fileRegex.exec(blob)) !== null) {
    push(fm[1].replace(/\\\//g, '/'), 'auto', 'config');
  }

  const jsonArrayRegex = /(window\.(?:player|sources|__PLAYER__|__INITIAL_STATE__)\s*=\s*\{[\s\S]{0,8000}?\})/gi;
  let jm;
  while ((jm = jsonArrayRegex.exec(blob)) !== null) {
    const urls = extractAllUrls(jm[1]);
    for (const u of urls) {
      if (isPlayableMediaUrl(u) || looksLikeMirror(u)) push(u, 'auto', 'json-config');
    }
  }

  const allUrls = extractAllUrls(blob);
  for (const u of allUrls) {
    if (isPlayableMediaUrl(u) || looksLikeMirror(u)) push(u, 'auto', 'regex');
  }

  return sortSourcesByQuality(out);
}

function normalizeSubtitleLang(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Unknown';
  const lower = raw.toLowerCase();
  if (lower === 'en' || lower.includes('english')) return 'English';
  if (lower === 'jp' || lower.includes('japanese')) return 'Japanese';
  if (lower === 'es' || lower.includes('spanish')) return 'Spanish';
  if (lower === 'fr' || lower.includes('french')) return 'French';
  if (lower === 'de' || lower.includes('german')) return 'German';
  return raw;
}

function parseSubtitles(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const out = [];

  const push = (url, lang, meta = {}) => {
    const absolute = safeAbsoluteUrl(baseUrl, url);
    if (!absolute) return;
    if (out.some(x => x.url === absolute)) return;
    const lowerMeta = String(lang || '').toLowerCase();
    out.push({
      lang: normalizeSubtitleLang(lang),
      url: absolute,
      default: !!meta.default || /default/i.test(lowerMeta),
      forced: !!meta.forced || /forced/i.test(lowerMeta),
    });
  };

  $('track[kind="subtitles"], track[kind="captions"], track[src]').each((_, el) => {
    push(
      $(el).attr('src'),
      $(el).attr('label') || $(el).attr('srclang') || 'Unknown',
      {
        default: $(el).attr('default') !== undefined,
        forced: /forced/i.test($(el).attr('label') || ''),
      }
    );
  });

  const blob = String(html || '');
  const rx = /https?:\/\/[^'"\s<>]+\.(vtt|srt|ass)(\?[^'"\s<>]*)?/gi;
  let m;
  while ((m = rx.exec(blob)) !== null) {
    push(m[0], 'Unknown');
  }

  const subtitleJsonRegex = /(subtitles|tracks)\s*:\s*(\[[\s\S]{0,4000}?\])/gi;
  while ((m = subtitleJsonRegex.exec(blob)) !== null) {
    const urls = extractAllUrls(m[2]);
    for (const u of urls) {
      if (/\.(vtt|srt|ass)(\?|$)/i.test(u)) push(u, 'Unknown');
    }
  }

  return out;
}

function normalizeEmptyStream(reason) {
  const payload = {
    provider: PROVIDER_NAME,
    streamUrl: null,
    sources: [],
    subtitles: [],
  };
  if (reason) payload.reason = reason;
  return payload;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url, options = {}) {
  const {
    cookieKey = null,
    referer = null,
    depth = 0,
    allowRedirectParse = true,
    skipCache = false,
    attempts = MAX_FETCH_RETRIES,
  } = options;

  if (!url) {
    return { ok: false, status: 0, url, html: '', cloudflare: false, redirectShell: false, reason: REASON.INVALID_URL };
  }

  const cacheKey = `page:${url}:${cookieKey || '-'}:${referer || '-'}`;
  if (!skipCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const redirectHit = redirectCache.get(url);
  if (redirectHit && Date.now() < redirectHit.expiresAt) {
    return fetchHtml(redirectHit.to, {
      cookieKey,
      referer: referer || url,
      depth: depth + 1,
      allowRedirectParse,
      skipCache,
      attempts,
    });
  }

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const started = Date.now();
    const extraHeaders = {};
    const cookieParts = [];
    const jarCookies = getCookiesForUrl(url);
    if (jarCookies) cookieParts.push(jarCookies);
    if (cookieKey) cookieParts.push(`key=${cookieKey}`);
    if (cookieParts.length) extraHeaders.Cookie = cookieParts.join('; ');
    if (referer) extraHeaders.Referer = referer;

    try {
      const origin = new URL(url).origin;
      extraHeaders.Origin = origin;
    } catch {
      // Ignore URL parse failures.
    }

    try {
      const res = await request(
        { method: 'get', url },
        {
          providerName: PROVIDER_NAME,
          streaming: true,
          timeout: 12000,
          extraHeaders,
        }
      );

      mergeCookies(url, res.headers?.['set-cookie']);
      const html = String(res.data || '');
      const reason = classifyFailure({ status: res.status, html, message: '' });

      const page = {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        url,
        html,
        cloudflare: detectCloudflare(html),
        redirectShell: isRedirectShell(html),
        redirectedTo: null,
        reason: reason === REASON.RESOLVE_ERROR ? null : reason,
        durationMs: Date.now() - started,
      };

      if (allowRedirectParse && depth < MAX_REDIRECT_DEPTH) {
        const next = extractMetaRedirect(html, url) || extractJsRedirect(html, url);
        if (next && next !== url) {
          logger.info('[AnimeHeaven] Redirect detected', { from: url, to: next });
          redirectCache.set(url, { to: next, expiresAt: Date.now() + CACHE_TTL_MS });
          const followed = await fetchHtml(next, {
            cookieKey,
            referer: url,
            depth: depth + 1,
            allowRedirectParse,
          });
          const redirected = Object.assign({}, followed, { redirectedTo: next });
          cacheSet(cacheKey, redirected);
          return redirected;
        }
      }

      cacheSet(cacheKey, page);
      return page;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const reason = classifyFailure({ status, message: error.message, html: '' });

      if (attempt < attempts && [REASON.NETWORK, REASON.TIMEOUT, REASON.RATE_LIMITED, REASON.CLOUDFLARE].includes(reason)) {
        logger.warn('[AnimeHeaven] Retry attempt', { attempt: attempt + 1, url, reason });
        await wait((attempt + 1) * 400);
        continue;
      }

      return {
        ok: false,
        status,
        url,
        html: '',
        cloudflare: reason === REASON.CLOUDFLARE,
        redirectShell: false,
        redirectedTo: null,
        reason,
        durationMs: Date.now() - started,
      };
    }
  }

  return {
    ok: false,
    status: 0,
    url,
    html: '',
    cloudflare: false,
    redirectShell: false,
    redirectedTo: null,
    reason: REASON.RESOLVE_ERROR,
  };
}

async function pickBaseUrl() {
  const cached = cacheGet('base:url');
  if (cached) return cached;

  for (const candidate of DOMAIN_CANDIDATES) {
    const page = await fetchHtml(candidate, {
      allowRedirectParse: true,
      skipCache: true,
      attempts: 1,
    });
    if (page.ok && !page.cloudflare && !page.redirectShell) {
      cacheSet('base:url', candidate, BASE_URL_TTL_MS);
      return candidate;
    }
  }

  const fallback = DOMAIN_CANDIDATES[0] || 'https://animeheaven.me';
  cacheSet('base:url', fallback, 30 * 1000);
  return fallback;
}

function buildAnimeUrl(baseUrl, identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^anime\.php\?/i.test(value)) return safeAbsoluteUrl(baseUrl, `/${value}`);
  if (/^[a-z0-9]{5,}$/i.test(value)) return `${baseUrl}/anime.php?${value}`;
  return safeAbsoluteUrl(baseUrl, value);
}

async function runSearch(baseUrl, query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = `search:${normalizeTitle(q)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const terms = expandSearchTerms(q).slice(0, 4);
  const rows = [];

  for (const term of terms) {
    const urls = [
      `${baseUrl}/fastsearch.php?xhr=1&s=${encodeURIComponent(term)}`,
      `${baseUrl}/search.php?s=${encodeURIComponent(term)}`,
      `${baseUrl}/?s=${encodeURIComponent(term)}`,
      `${baseUrl}/`,
    ];

    for (const url of urls) {
      const page = await fetchHtml(url, { referer: baseUrl });
      if (!page.ok || !page.html) continue;
      const parsed = parseSearchHtml(baseUrl, page.html, q);
      rows.push(...parsed);

      if (url.endsWith('/') && parsed.length === 0) {
        const $ = cheerio.load(page.html);
        $('a[href*="anime.php?"]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const title = $(el).attr('title') || $(el).text().trim() || '';
          const row = normalizeSearchRow(baseUrl, title, href, $(el).find('img').attr('src'), q);
          if (row && row.score >= 55) rows.push(row);
        });
      }
    }
  }

  const finalRows = uniqueByIdentifier(rows)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.title.localeCompare(b.title));

  cacheSet(cacheKey, finalRows, SEARCH_CACHE_TTL_MS);
  return finalRows;
}

function parseInfoMap($) {
  const map = {};
  const lines = [];

  $('.infoyear,.infodata,.info,li,p,.line').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3 || text.length > 220) return;
    lines.push(text);
    const m = text.match(/^([A-Za-z\s]+)\s*:\s*(.+)$/);
    if (m) map[normalizeTitle(m[1])] = m[2].trim();
  });

  return { map, lines };
}

function parseAliases($, title) {
  const aliases = new Set();
  const add = v => {
    const clean = cleanTitle(v);
    if (clean && clean.length > 1) aliases.add(clean);
  };

  add(title);
  add($('meta[property="og:title"]').attr('content'));
  add($('h1,.linetitle .c2,.linetitle .c').first().text());

  $('.aliases,.alias,.alternative,.jtitle,.jp,.romaji,.english').each((_, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    txt.split(/[|,/]/).map(v => v.trim()).filter(Boolean).forEach(add);
  });

  return [...aliases];
}

function parseDetails(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const fallbackTitle = cleanTitle(
    $('meta[property="og:title"]').attr('content')
      || $('title').text()
      || $('.linetitle .c2').first().text()
      || $('.linetitle .c').first().text()
      || ''
  );

  const { map, lines } = parseInfoMap($);

  const synopsis = $('.infodes,.description,.summary').first().text().trim()
    || $('meta[property="og:description"]').attr('content')
    || $('meta[name="description"]').attr('content')
    || '';

  const genres = $('.infotags a[href*="tags.php"], .infotags .boxitem, .genres a, a[href*="genre"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const yearText = map.year || map.aired || map.release || lines.join(' ');
  const releaseYear = String(yearText || '').match(/(19|20)\d{2}/)?.[0] || null;

  const episodeText = map.episodes || map.episode || map['episode count'] || lines.join(' ');
  const episodeCount = String(episodeText || '').match(/episodes?\s*:?\s*(\d+)/i)?.[1]
    || String(episodeText || '').match(/\b(\d{1,4})\b/)?.[1]
    || null;

  const statusText = [map.status, lines.join(' ')].filter(Boolean).join(' ');
  const status = /ongoing|airing/i.test(statusText)
    ? 'Ongoing'
    : (/completed|finished/i.test(statusText) ? 'Completed' : null);

  const ratingText = map.rating || map.score || map.imdb || $('meta[itemprop="ratingValue"]').attr('content') || '';
  const rating = String(ratingText).match(/\d+(?:\.\d+)?/)?.[0] || null;

  const studios = (map.studio || map.studios || '')
    .split(/[,|/]/)
    .map(v => v.trim())
    .filter(Boolean);

  const season = map.season || (lines.join(' ').match(/\b(spring|summer|fall|autumn|winter)\b/i)?.[0] || null);
  const duration = map.duration || (lines.join(' ').match(/\b\d+\s*(min|minutes|m)\b/i)?.[0] || null);

  const cover = safeAbsoluteUrl(
    pageUrl,
    $('meta[property="og:image"]').attr('content')
      || $('.coverimg,.poster img,img.cover').first().attr('src')
      || $('img').first().attr('src')
      || null
  );

  const banner = safeAbsoluteUrl(
    pageUrl,
    $('meta[property="og:image:secure_url"]').attr('content')
      || $('.banner img,.backdrop img,.hero img').first().attr('src')
      || cover
  );

  const identifier = pageUrl.match(/anime\.php\?([^&#]+)/i)?.[1] || null;
  const episodes = parseEpisodes($, pageUrl);
  const aliases = parseAliases($, fallbackTitle);

  return {
    id: identifier,
    identifier,
    slug: identifier,
    title: fallbackTitle,
    description: synopsis,
    synopsis,
    genres,
    status,
    releaseYear,
    cover,
    image: cover,
    banner,
    rating,
    studios,
    season,
    duration,
    aliases,
    totalEpisodes: episodeCount,
    episodeCount,
    provider: PROVIDER_NAME,
    url: pageUrl,
    episodes,
  };
}

async function resolveMirrorSources(primarySources, context) {
  const mirrors = primarySources
    .filter(src => src && src.url && looksLikeMirror(src.url) && !isPlayableMediaUrl(src.url))
    .slice(0, MAX_MIRROR_FETCHES);

  if (!mirrors.length) return [];

  const extracted = [];
  for (const mirror of mirrors) {
    logger.info('[AnimeHeaven] Mirror selected', { mirror: mirror.url });
    const page = await fetchHtml(mirror.url, {
      referer: context.referer,
      allowRedirectParse: true,
      attempts: 1,
    });
    if (!page.ok || !page.html) continue;
    const nested = parseSources(page.html, page.url || mirror.url)
      .filter(src => isPlayableMediaUrl(src.url));

    for (const src of nested) {
      if (!extracted.some(x => x.url === src.url)) {
        extracted.push(Object.assign({}, src, { sourceType: 'mirror' }));
      }
    }
  }

  return extracted;
}

async function extractNestedIframeSources(html, pageUrl, depth = 0) {
  if (depth > MAX_NESTED_IFRAME_DEPTH) return [];

  const $ = cheerio.load(String(html || ''));
  const iframeUrls = $('iframe[src], embed[src]')
    .map((_, el) => safeAbsoluteUrl(pageUrl, $(el).attr('src')))
    .get()
    .filter(Boolean);

  const out = [];
  for (const iframeUrl of iframeUrls) {
    const page = await fetchHtml(iframeUrl, { referer: pageUrl, attempts: 1 });
    if (!page.ok || !page.html) continue;

    const direct = parseSources(page.html, page.url || iframeUrl)
      .filter(src => isPlayableMediaUrl(src.url));
    for (const src of direct) {
      if (!out.some(x => x.url === src.url)) out.push(Object.assign({}, src, { sourceType: 'nested-iframe' }));
    }

    const deeper = await extractNestedIframeSources(page.html, page.url || iframeUrl, depth + 1);
    for (const src of deeper) {
      if (!out.some(x => x.url === src.url)) out.push(src);
    }
  }

  return out;
}

async function resolveGatePage(baseUrl, details, episode) {
  const gateCandidates = [
    `${baseUrl}/gate.php`,
    episode.url,
    `${baseUrl}/gate.php?xhr=1`,
  ].filter(Boolean);

  let last = null;
  for (const gateUrl of gateCandidates) {
    const page = await fetchHtml(gateUrl, {
      cookieKey: episode.key,
      referer: details.url || `${baseUrl}/anime.php?${details.identifier || ''}`,
      attempts: 2,
    });
    last = page;
    if (page.ok && page.html) return page;
  }
  return last || {
    ok: false,
    status: 0,
    url: gateCandidates[0] || null,
    html: '',
    cloudflare: false,
    redirectShell: false,
    reason: REASON.PLAYER_MISSING,
  };
}

class AnimeHeavenProvider {
  constructor() {
    this.provider = PROVIDER_NAME;
  }

  getHealthSnapshot() {
    const attempts = providerStats.attempts || 1;
    return {
      provider: PROVIDER_NAME,
      successRate: Number(((providerStats.success / attempts) * 100).toFixed(2)),
      avgResponseMs: Number((providerStats.totalLatencyMs / attempts).toFixed(2)),
      timeouts: providerStats.timeouts,
      cloudflareHits: providerStats.cloudflare,
      streamExtractionSuccess: providerStats.success,
      failures: providerStats.failures,
    };
  }

  async searchAnime(query, limit = 10) {
    const q = String(query || '').trim();
    if (!q) return [];

    logger.info('[AnimeHeaven] Search started', { query: q });
    const started = Date.now();
    try {
      const baseUrl = await pickBaseUrl();
      const rows = await runSearch(baseUrl, q);
      const sliced = rows.slice(0, Math.max(1, Number(limit) || 10));
      logger.info('[AnimeHeaven] Search success', {
        query: q,
        count: sliced.length,
        latencyMs: Date.now() - started,
      });
      return sliced;
    } catch (error) {
      logger.warn('[AnimeHeavenProvider] searchAnime failed', { query: q, error: error.message });
      return [];
    }
  }

  async getAnimeDetails(identifier) {
    const value = String(identifier || '').trim();
    if (!value) {
      return {
        id: null,
        identifier: null,
        slug: null,
        title: '',
        description: '',
        synopsis: '',
        genres: [],
        status: null,
        releaseYear: null,
        cover: null,
        image: null,
        totalEpisodes: null,
        episodeCount: null,
        provider: PROVIDER_NAME,
        url: null,
        episodes: [],
      };
    }

    try {
      const baseUrl = await pickBaseUrl();
      const animeUrl = buildAnimeUrl(baseUrl, value);
      const page = await fetchHtml(animeUrl, { referer: baseUrl, attempts: 2 });

      if (!page.ok || !page.html) {
        logger.warn('[AnimeHeaven] Metadata fetch failed', {
          identifier: value,
          status: page.status,
          reason: page.reason,
        });
        return {
          id: value,
          identifier: value,
          slug: value,
          title: value,
          description: '',
          synopsis: '',
          genres: [],
          status: null,
          releaseYear: null,
          cover: null,
          image: null,
          totalEpisodes: null,
          episodeCount: null,
          provider: PROVIDER_NAME,
          url: animeUrl,
          episodes: [],
        };
      }

      if (page.cloudflare || page.redirectShell) {
        logger.warn('[AnimeHeaven] Cloudflare detected', { stage: 'details', url: page.url });
      }

      const parsed = parseDetails(page.html, page.url || animeUrl);
      return parsed;
    } catch (error) {
      logger.warn('[AnimeHeavenProvider] getAnimeDetails failed', { identifier: value, error: error.message });
      return {
        id: value,
        identifier: value,
        slug: value,
        title: value,
        description: '',
        synopsis: '',
        genres: [],
        status: null,
        releaseYear: null,
        cover: null,
        image: null,
        totalEpisodes: null,
        episodeCount: null,
        provider: PROVIDER_NAME,
        url: null,
        episodes: [],
      };
    }
  }

  async getEpisodeList(identifier) {
    const details = await this.getAnimeDetails(identifier);
    return Array.isArray(details.episodes) ? details.episodes : [];
  }

  async resolveEpisode({ title, episode, identifier, slug }) {
    const started = Date.now();
    try {
      const baseUrl = await pickBaseUrl();
      const episodeNumber = normalizeEpisodeNumber(episode);

      let targetIdentifier = identifier || slug || null;
      if (!targetIdentifier && title) {
        const rows = await this.searchAnime(title, 8);
        targetIdentifier = rows[0]?.identifier || null;
      }

      if (!targetIdentifier) {
        recordProviderMetric('failure', Date.now() - started);
        return {
          anime: { title: title || '', provider: PROVIDER_NAME },
          episode: null,
          pageUrl: null,
          html: '',
          reason: REASON.SEARCH_EMPTY,
        };
      }

      const details = await this.getAnimeDetails(targetIdentifier);
      const episodes = Array.isArray(details.episodes) ? details.episodes : [];
      const selected = episodes.find(ep => Number(ep.number) === Number(episodeNumber))
        || episodes.find(ep => String(ep.number) === String(episodeNumber))
        || null;

      if (!selected) {
        logger.warn('[AnimeHeaven] Episode not found', {
          anime: details.title || targetIdentifier,
          episode: episodeNumber,
        });
        recordProviderMetric('failure', Date.now() - started);
        return {
          anime: details,
          episode: null,
          pageUrl: details.url || null,
          html: '',
          reason: REASON.EPISODE_MISSING,
        };
      }

      const gatePage = await resolveGatePage(baseUrl, details, selected);
      if (gatePage.cloudflare || gatePage.redirectShell) {
        logger.warn('[AnimeHeaven] Cloudflare detected', { stage: 'gate', episode: selected.number });
      }

      logger.info('[AnimeHeaven] Episode resolved', {
        anime: details.title,
        episode: selected.number,
        hasHtml: !!gatePage.html,
      });

      if (gatePage.reason === REASON.CLOUDFLARE) recordProviderMetric('cloudflare', Date.now() - started);
      else if (gatePage.reason === REASON.TIMEOUT) recordProviderMetric('timeout', Date.now() - started);
      else if (gatePage.ok && gatePage.html) recordProviderMetric('success', Date.now() - started);
      else recordProviderMetric('failure', Date.now() - started);

      return {
        anime: details,
        episode: selected,
        pageUrl: gatePage.url || `${baseUrl}/gate.php`,
        html: gatePage.html || '',
        reason: gatePage.reason || null,
      };
    } catch (error) {
      logger.warn('[AnimeHeavenProvider] resolveEpisode failed', { error: error.message });
      recordProviderMetric('failure', Date.now() - started);
      return {
        anime: { title: title || '', provider: PROVIDER_NAME },
        episode: null,
        pageUrl: null,
        html: '',
        reason: REASON.RESOLVE_ERROR,
      };
    }
  }

  async resolvePlayer({ title, episode, identifier, slug }) {
    try {
      const resolved = await this.resolveEpisode({ title, episode, identifier, slug });
      if (!resolved || !resolved.html) {
        return {
          anime: resolved?.anime || { title: title || '', provider: PROVIDER_NAME },
          episode: resolved?.episode || null,
          pageUrl: resolved?.pageUrl || null,
          playerUrl: null,
          sources: [],
          html: '',
          reason: resolved?.reason || REASON.PLAYER_MISSING,
        };
      }

      const baseUrl = resolved.pageUrl || (await pickBaseUrl());
      const direct = parseSources(resolved.html, baseUrl);
      const nested = await extractNestedIframeSources(resolved.html, baseUrl);

      const merged = [];
      for (const src of [...direct, ...nested]) {
        if (!merged.some(x => x.url === src.url)) merged.push(src);
      }

      logger.info('[AnimeHeaven] Player resolved', {
        episode: resolved.episode?.number || null,
        sources: merged.length,
      });

      return {
        anime: resolved.anime,
        episode: resolved.episode,
        pageUrl: resolved.pageUrl,
        playerUrl: merged[0]?.url || null,
        sources: sortSourcesByQuality(merged),
        html: resolved.html,
        reason: merged.length ? null : (resolved.reason || REASON.PLAYER_MISSING),
      };
    } catch (error) {
      logger.warn('[AnimeHeavenProvider] resolvePlayer failed', { error: error.message });
      return {
        anime: { title: title || '', provider: PROVIDER_NAME },
        episode: null,
        pageUrl: null,
        playerUrl: null,
        sources: [],
        html: '',
        reason: REASON.RESOLVE_ERROR,
      };
    }
  }

  async extractStreams({ title, episode, identifier, slug }) {
    const started = Date.now();
    try {
      const player = await this.resolvePlayer({ title, episode, identifier, slug });

      if (!player || player.reason === REASON.CLOUDFLARE) {
        logger.warn('[AnimeHeaven] Cloudflare detected');
        recordProviderMetric('cloudflare', Date.now() - started);
        return normalizeEmptyStream(REASON.CLOUDFLARE);
      }

      let sources = Array.isArray(player.sources) ? player.sources : [];
      const mirrorSources = await resolveMirrorSources(sources, {
        referer: player.pageUrl || (await pickBaseUrl()),
      });
      for (const src of mirrorSources) {
        if (!sources.some(x => x.url === src.url)) sources.push(src);
      }

      sources = sortSourcesByQuality(sources)
        .filter(src => isPlayableMediaUrl(src.url) || looksLikeMirror(src.url));

      if (!sources.length) {
        logger.info('[AnimeHeaven] Stream missing', { title, episode });
        recordProviderMetric('failure', Date.now() - started);
        return normalizeEmptyStream(player.reason || REASON.STREAM_MISSING);
      }

      const subtitles = parseSubtitles(player.html || '', player.pageUrl || (await pickBaseUrl()));
      if (subtitles.length) {
        logger.info('[AnimeHeaven] Subtitle found', { count: subtitles.length });
      }

      const streamUrl = sources[0]?.url || player.playerUrl || null;

      logger.info('[AnimeHeaven] Stream extracted', {
        title,
        episode,
        sources: sources.length,
      });

      recordProviderMetric('success', Date.now() - started);
      return {
        provider: PROVIDER_NAME,
        streamUrl,
        sources,
        subtitles,
      };
    } catch (error) {
      const msg = String(error?.message || '');
      const reason = classifyFailure({ status: 0, message: msg, html: '' });
      if (reason === REASON.TIMEOUT) recordProviderMetric('timeout', Date.now() - started);
      else if (reason === REASON.CLOUDFLARE) recordProviderMetric('cloudflare', Date.now() - started);
      else recordProviderMetric('failure', Date.now() - started);
      logger.warn('[AnimeHeavenProvider] extractStreams failed', { error: msg, reason });
      return normalizeEmptyStream(reason);
    }
  }

  async resolveStream({ title, episode }) {
    return this.extractStreams({ title, episode });
  }
}

module.exports = {
  AnimeHeavenProvider,
  provider: new AnimeHeavenProvider(),
};
