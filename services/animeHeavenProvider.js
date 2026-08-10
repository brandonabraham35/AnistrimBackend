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
const MAX_NESTED_IFRAME_DEPTH = Math.max(1, Number(process.env.ANIMEHEAVEN_MAX_NESTED_DEPTH || 3));
const MAX_MIRROR_FETCHES = 4;
const MAX_FETCH_RETRIES = 2;
const MIRROR_CACHE_TTL_MS = Math.max(15 * 1000, Number(process.env.ANIMEHEAVEN_MIRROR_CACHE_TTL_MS || 10 * 60 * 1000));

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

// A realistic browser User-Agent used for hotlink-protected CDN playback.
// This is the SAME class of UA the scraper presents when fetching pages, so
// the CDN authorises the proxy's media requests. Kept as a single constant so
// the provider and the proxy derive it from ONE source of truth.
const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The backend reverse-proxy endpoint that the provider emits for every stream
// URL. The browser never talks to the AnimeHeaven CDNs directly — it only ever
// sees this same-origin proxy URL, which injects the server-side playback
// context (cookies/referer/origin/UA) that hotlink-protected CDNs require.
// MUST match the route registered in routes/streamRoutes.js.
const STREAM_PROXY_PATH = '/api/stream/proxy';
const STREAM_PROXY_PROVIDER = 'animeheaven';

/**
 * Build a stateless, same-origin proxy URL for a target AnimeHeaven CDN URL.
 *
 * The proxy receives the encoded target URL and the referer (the AnimeHeaven
 * gate/embed/mirror page that served the media). Hotlink protection is
 * satisfied server-side when the proxy makes the upstream request, so the
 * browser never needs (or sees) cookies/referers/origins.
 *
 * @param {string} targetUrl - The upstream CDN/media URL to proxy.
 * @param {string} [referer] - The page that referred the media (gate/iframe/mirror).
 * @returns {string} `/api/stream/proxy?provider=animeheaven&url=<encoded>&referer=<encoded>`
 */
function buildProxyUrl(targetUrl, referer = null) {
  const params = new URLSearchParams({
    provider: STREAM_PROXY_PROVIDER,
    url: String(targetUrl || ''),
  });
  if (referer) params.set('referer', String(referer));
  return `${STREAM_PROXY_PATH}?${params.toString()}`;
}

const COMMON_ANIME_SYNONYMS = Object.freeze({
  aot: ['attack on titan', 'shingeki no kyojin', '進撃の巨人'],
  snk: ['shingeki no kyojin', 'attack on titan', '進撃の巨人'],
  mha: ['my hero academia', 'boku no hero academia', '僕のヒーローアカデミア'],
  op: ['one piece', 'ワンピース'],
  sao: ['sword art online', 'ソードアートオンライン'],
  hxh: ['hunter x hunter', 'ハンター ハンター'],
  fmab: ['fullmetal alchemist brotherhood', 'hagane no renkinjutsushi', '鋼の錬金術師'],
  jjk: ['jujutsu kaisen', '呪術廻戦'],
  kny: ['kimetsu no yaiba', 'demon slayer', '鬼滅の刃'],
  rezero: ['re zero', 'rezero', 're zero kara hajimeru isekai seikatsu', 're ゼロ から始める異世界生活'],
  oregairu: ['my teen romantic comedy snafu', 'yahari ore no seishun love comedy wa machigatteiru'],
  monogatari: ['bakemonogatari', '物語'],
});

const ROMAJI_ALIASES = Object.freeze({
  shingeki: ['attack'],
  kyojin: ['titan'],
  kimetsu: ['demon'],
  yaiba: ['slayer'],
  boku: ['my'],
  hero: ['academia'],
  jujutsu: ['sorcery'],
  kaisen: ['battle'],
  kusuriya: ['apothecary'],
  hitorigoto: ['diaries'],
  kokurasetai: ['love is war'],
});

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
  /turnstile/i,
];

// Weighted components of the composite relevance score used to break score
// ties. Higher-weight components dominate: an exact title match always beats a
// prefix match, which beats a substring match, etc. This REPLACES the old
// alphabetical (localeCompare) tie-break so ranking reflects search relevance.
const RELEVANCE_WEIGHTS = Object.freeze({
  EXACT_RAW: 1000,        // case-insensitive exact title match
  EXACT_NORMALIZED: 900,  // normalized exact match (punctuation/spaces removed)
  ALIAS_MATCH: 850,       // alias/variant match (english/romaji/japanese/synonym)
  PREFIX_MATCH: 700,      // candidate starts with query
  WHOLE_WORD: 600,        // query is a whole word within candidate
  SUBSTRING: 500,         // candidate contains query substring
  TOKEN_OVERLAP: 400,     // token overlap / jaccard
  LEVENSHTEIN: 300,       // edit-distance similarity
  EPISODE_AVAIL: 200,     // title string contains the requested episode
});

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
  REDIRECT_LOOP: 'redirect_loop',
  MIRROR_FAILED: 'mirror_failed',
  HTTP_FAILURE: 'http_failure',
  PLAYER_FAILED: 'player_failed',
});

const pageCache = new Map();
const redirectCache = new Map();
const cookieJar = new Map();
const mirrorHealth = new Map();
const subtitleProbeCache = new Map();

const SUBTITLE_PROBE_TTL_MS = 20 * 60 * 1000;
const MAX_SUBTITLE_SOURCE_PROBES = 2;
const MAX_SUBTITLE_URL_PROBES = 12;

const providerStats = {
  attempts: 0,
  success: 0,
  failures: 0,
  timeouts: 0,
  cloudflare: 0,
  totalLatencyMs: 0,
  httpFailures: 0,
  redirectLoops: 0,
  mirrorFailures: 0,
  playerFailures: 0,
  subtitleSuccess: 0,
  streamSuccess: 0,
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

/**
 * Build the complete playback context (headers/cookies) needed to fetch a
 * given stream/mirror URL directly from the upstream CDN. This is the SINGLE
 * source of truth used by the reverse proxy (controllers/streamProxyController.js)
 * so the browser playback path reuses EXACTLY the cookie jar + origin/referer
 * logic the scraper uses — no duplicate cookie logic.
 *
 * If `url` is the CDN/media URL, cookies are sourced from that URL's domain.
 * `referer` (the AnimeHeaven gate/embed/mirror page that served the media) is
 * used to derive the Origin and to send a Referer to the CDN, which hotlink
 * protection typically requires.
 *
* @param {string} url - The upstream media/mirror URL to fetch.
 * @param {string} [referer] - The page that referred the media (gate/iframe/mirror).
 * @returns {{ referer: string|null, origin: string|null, cookies: string|null, userAgent: string|null }}
 */
function getPlaybackContext(url, referer = null) {
  let origin = null;
  let effectiveReferer = referer || null;
  try {
    if (effectiveReferer) {
      origin = new URL(effectiveReferer).origin;
    } else if (url) {
      origin = new URL(url).origin;
    }
  } catch {
    origin = null;
  }

  const cookies = getCookiesForUrl(effectiveReferer || url);

  return {
    referer: effectiveReferer,
    origin,
    cookies,
    userAgent: PLAYBACK_USER_AGENT,
  };
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

function toHiragana(input) {
  return String(input || '').replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeJapanese(input) {
  const normalized = toHiragana(String(input || '').normalize('NFKC'));
  return normalized
    .replace(/[ー〜～・･]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeRomaji(input) {
  return stripDiacritics(String(input || ''))
    .toLowerCase()
    .normalize('NFKC')
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ii/g, 'i')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(input) {
  return stripDiacritics(String(input || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalized(input) {
  return normalizeTitle(input).split(' ').filter(Boolean);
}

function sortedTokenSignature(input) {
  const tokens = tokenizeNormalized(input);
  return tokens.sort().join(' ');
}

function hasJapaneseChars(input) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(input || ''));
}

function buildSynonymMap() {
  const map = new Map();
  for (const [key, values] of Object.entries(COMMON_ANIME_SYNONYMS)) {
    const bucket = [key, ...values].map(v => normalizeTitle(v)).filter(Boolean);
    for (const term of bucket) {
      const row = map.get(term) || new Set();
      for (const b of bucket) row.add(b);
      map.set(term, row);
    }
  }
  return map;
}

const SYNONYM_LOOKUP = buildSynonymMap();

function expandWithSynonyms(terms) {
  const out = new Set(terms.filter(Boolean));
  for (const t of terms) {
    const n = normalizeTitle(t);
    if (!n) continue;
    const hit = SYNONYM_LOOKUP.get(n);
    if (hit) {
      for (const v of hit) out.add(v);
    }

    const tokens = n.split(' ').filter(Boolean);
    for (const tok of tokens) {
      const hit2 = SYNONYM_LOOKUP.get(tok);
      if (hit2) {
        for (const v of hit2) out.add(v);
      }
      const ra = ROMAJI_ALIASES[tok];
      if (ra) {
        for (const rv of ra) out.add(normalizeTitle(rv));
      }
    }
  }
  return [...out].filter(Boolean);
}

function buildMatchVariants(input) {
  const raw = String(input || '');
  const base = normalizeTitle(raw);
  const variants = new Set();
  if (base) variants.add(base);

  const romaji = normalizeRomaji(raw);
  if (romaji) variants.add(romaji);

  const sorted = sortedTokenSignature(raw);
  if (sorted) variants.add(sorted);

  if (hasJapaneseChars(raw)) {
    const ja = normalizeJapanese(raw);
    if (ja) variants.add(ja);
  }

  const expanded = expandWithSynonyms([...variants]);
  for (const ex of expanded) {
    variants.add(ex);
    const s2 = sortedTokenSignature(ex);
    if (s2) variants.add(s2);
  }

  return [...variants].filter(Boolean);
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

  const out = new Set([base, collapseWhitespace(base)]);
  out.add(base.replace(/&/g, ' and '));
  out.add(base.replace(/\band\b/gi, '&'));
  out.add(base.replace(/\bseason\b/gi, 's'));
  out.add(base.replace(/[\-_:]/g, ' '));

  const words = normalizeTitle(base).split(/\s+/).filter(Boolean);
  for (const w of words) {
    const hit = COMMON_ANIME_SYNONYMS[w];
    if (hit) hit.forEach(v => out.add(v));
    const romajiHints = ROMAJI_ALIASES[w];
    if (romajiHints) romajiHints.forEach(v => out.add(v));
  }

  if (hasJapaneseChars(base)) {
    const jp = normalizeJapanese(base);
    if (jp) out.add(jp);
  }

  const romaji = normalizeRomaji(base);
  if (romaji && romaji !== normalizeTitle(base)) {
    out.add(romaji);
  }

  const expanded = expandWithSynonyms([...out]);
  for (const e of expanded) {
    out.add(e);
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
  const queryVariants = buildMatchVariants(query);
  const candidateVariants = buildMatchVariants(candidate);
  if (!queryVariants.length || !candidateVariants.length) return 0;

  let best = 0;
  const baseCandidate = candidateVariants[0] || normalizeTitle(candidate);

  for (const q of queryVariants) {
    for (const c of candidateVariants) {
      let score = 0;

      if (c === q) score = Math.max(score, 140);
      else if (c.startsWith(q)) score = Math.max(score, 122);
      else if (c.includes(q)) score = Math.max(score, 108);

      const cTokens = new Set(c.split(' ').filter(Boolean));
      const qTokens = q.split(' ').filter(Boolean);
      const qTokenSet = new Set(qTokens);
      let overlap = 0;
      for (const token of qTokens) {
        if (cTokens.has(token)) overlap += 1;
      }

      const union = new Set([...cTokens, ...qTokenSet]);
      const jaccard = union.size ? (overlap / union.size) : 0;
      score += overlap * 9;
      if (overlap >= Math.max(2, Math.floor(qTokens.length * 0.65))) score += 24;
      score += Math.round(jaccard * 35);

      const distance = levenshtein(c, q);
      const maxLen = Math.max(c.length, q.length) || 1;
      const similarity = 1 - (distance / maxLen);
      score += Math.max(0, Math.round(similarity * 42));

      const sortedC = sortedTokenSignature(c);
      const sortedQ = sortedTokenSignature(q);
      if (sortedC && sortedQ && sortedC === sortedQ) score += 18;

      if (hasJapaneseChars(q) && hasJapaneseChars(c)) {
        const jaQ = normalizeJapanese(q);
        const jaC = normalizeJapanese(c);
        if (jaQ && jaC && (jaQ === jaC || jaC.includes(jaQ) || jaQ.includes(jaC))) {
          score += 28;
        }
      }

      best = Math.max(best, score);
    }
  }

  for (const alias of aliases) {
    const aliasVariants = buildMatchVariants(alias);
    for (const av of aliasVariants) {
      for (const qv of queryVariants) {
        if (!av || !qv) continue;
        if (av === qv) best = Math.max(best, 130);
        else if (av.includes(qv) || qv.includes(av)) best = Math.max(best, 104);
      }
    }
  }

  if (baseCandidate && queryVariants.some(qv => baseCandidate.includes(qv))) {
    best += 2;
  }

  return best;
}

// Highest-priority tier matched by a candidate, per the mandated ordering:
//   0 exact-true, 1 exact-normalized, 2 alias, 3 prefix, 4 whole-word,
//   5 substring, 6 levenshtein, 7 token-overlap, 8 episode-available,
//   9 no match.
const TIER = Object.freeze({
  EXACT_RAW: 0,
  EXACT_NORMALIZED: 1,
  ALIAS: 2,
  PREFIX: 3,
  WHOLE_WORD: 4,
  SUBSTRING: 5,
  LEVENSHTEIN: 6,
  TOKEN_OVERLAP: 7,
  EPISODE: 8,
  NONE: 9,
});

/**
 * Compute the composite relevance score + highest-priority tier for a search
 * candidate against a query. The weighted composite `total` is the SOLE
 * semantic tie-breaker used by runSearch()'s final sort (after the provider
 * score). `tier` and `flags` are retained ONLY for diagnostics, explainability
 * and the debug output — they never influence ranking.
 *
 * @param {string} candidate - candidate title (raw, as displayed)
 * @param {string} query - the user's search query
 * @param {string[]} [aliases] - known aliases for the candidate
 * @param {number|string} [requestedEpisode] - optional requested episode number
 * @returns {{ total: number, tier: number, flags: object }}
 */
function computeRelevanceScore(candidate, query, aliases = [], requestedEpisode) {
  const rawC = String(candidate || '').trim();
  const rawQ = String(query || '').trim().toLowerCase();

  const normC = normalizeTitle(rawC);
  const normQ = normalizeTitle(rawQ);

  const flags = {
    exactRaw: false,
    exactNormalized: false,
    aliasMatch: false,
    prefix: false,
    wholeWord: false,
    substring: false,
    tokenOverlap: 0,
    editDistance: 0,
    episodeAvailable: false,
  };

  let tier = TIER.NONE;
  let total = 0;

  // 1. Exact raw title match (case-insensitive)
  if (rawC && rawQ && rawC.toLowerCase() === rawQ) {
    flags.exactRaw = true;
    tier = Math.min(tier, TIER.EXACT_RAW);
    total += RELEVANCE_WEIGHTS.EXACT_RAW;
  }

  // 2. Exact normalized title match
  if (normC && normQ && normC === normQ) {
    flags.exactNormalized = true;
    tier = Math.min(tier, TIER.EXACT_NORMALIZED);
    total += RELEVANCE_WEIGHTS.EXACT_NORMALIZED;
  }

  if (normC && normQ) {
    // 3. Alias / variant match (english, romaji, japanese, synonyms, provided aliases)
    const candidateVariants = buildMatchVariants(rawC);
    const queryVariants = buildMatchVariants(rawQ);
    let aliasHit = false;
    for (const qv of queryVariants) {
      if (!qv) continue;
      for (const cv of candidateVariants) {
        if (cv === qv) { aliasHit = true; break; }
      }
      if (aliasHit) break;
    }
    if (!aliasHit) {
      for (const alias of (aliases || [])) {
        const av = normalizeTitle(alias);
        if (!av) continue;
        if (av === normQ || queryVariants.includes(av) || normQ === av) {
          aliasHit = true;
          break;
        }
      }
    }
    if (aliasHit) {
      flags.aliasMatch = true;
      tier = Math.min(tier, TIER.ALIAS);
      total += RELEVANCE_WEIGHTS.ALIAS_MATCH;
    }

    // 4. Prefix match (candidate normalized string starts with query)
    if (normC.startsWith(normQ)) {
      flags.prefix = true;
      tier = Math.min(tier, TIER.PREFIX);
      total += RELEVANCE_WEIGHTS.PREFIX_MATCH;
    }

    // 5. Whole-word match (query is a complete word token within candidate)
    const cTokens = normC.split(' ').filter(Boolean);
    if (cTokens.includes(normQ)) {
      flags.wholeWord = true;
      tier = Math.min(tier, TIER.WHOLE_WORD);
      total += RELEVANCE_WEIGHTS.WHOLE_WORD;
    }

    // 6. Substring match
    if (normC.includes(normQ)) {
      flags.substring = true;
      tier = Math.min(tier, TIER.SUBSTRING);
      total += RELEVANCE_WEIGHTS.SUBSTRING;
    }

    // 7. Levenshtein similarity (only meaningful when otherwise unmatched)
    const distance = levenshtein(normC, normQ);
    flags.editDistance = distance;
    const maxLen = Math.max(normC.length, normQ.length) || 1;
    const similarity = 1 - (distance / maxLen);
    if (similarity > 0.5) {
      tier = Math.min(tier, TIER.LEVENSHTEIN);
    }
    total += Math.round(Math.max(0, similarity) * RELEVANCE_WEIGHTS.LEVENSHTEIN);

    // 8. Token overlap
    const qTokens = normQ.split(' ').filter(Boolean);
    const cTokenSet = new Set(cTokens);
    let overlap = 0;
    for (const token of qTokens) {
      if (cTokenSet.has(token)) overlap += 1;
    }
    flags.tokenOverlap = overlap;
    const union = new Set([...cTokenSet, ...qTokens]);
    const jaccard = union.size ? (overlap / union.size) : 0;
    if (overlap > 0) {
      tier = Math.min(tier, TIER.TOKEN_OVERLAP);
    }
    total += Math.round((overlap + jaccard) * RELEVANCE_WEIGHTS.TOKEN_OVERLAP);
  }

  // 9. Episode availability — prefer the title containing the requested episode
  if (requestedEpisode !== undefined && requestedEpisode !== null && requestedEpisode !== '') {
    const ep = String(requestedEpisode);
    const titleHasEpisode = new RegExp(`(^|[^0-9])${ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`).test(rawC)
      || new RegExp(`(?:episode|ep|ep\.|第)\\s*${ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(rawC);
    if (titleHasEpisode) {
      flags.episodeAvailable = true;
      tier = Math.min(tier, TIER.EPISODE);
      total += RELEVANCE_WEIGHTS.EPISODE_AVAIL;
    }
  }

  return { total, tier, flags };
}

/**
 * Estimate how confidently the #1 result is the correct one, based on the gap
 * between the top two candidates' (score + relevance) totals. Returns 0..1.
 */
function computeSearchConfidence(top, second) {
  if (!top) return 0;
  const topTotal = Number(top.finalRankingScore);
  const secondTotal = second ? Number(second.finalRankingScore) : 0;
  if (!Number.isFinite(topTotal) || topTotal <= 0) return 0;
  const gapRatio = (topTotal - secondTotal) / topTotal;
  // Clamp into [0, 1]; a 30%+ margin saturates near-certain.
  return Math.min(1, Math.max(0, gapRatio / 0.3));
}

function classifyFailure({ status, message, html }) {
  const text = String(message || '');
  const body = String(html || '');
  if (detectCloudflare(body) || /cloudflare|challenge|captcha/i.test(text)) return REASON.CLOUDFLARE;
  if (status === 404) return REASON.NOT_FOUND;
  if (status === 403) return REASON.FORBIDDEN;
  if (status === 429) return REASON.RATE_LIMITED;
  if ([500, 502, 503, 504].includes(Number(status))) return REASON.HTTP_FAILURE;
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
  if (kind === 'http_failure') providerStats.httpFailures += 1;
  if (kind === 'redirect_loop') providerStats.redirectLoops += 1;
  if (kind === 'mirror_failure') providerStats.mirrorFailures += 1;
  if (kind === 'player_failure') providerStats.playerFailures += 1;
  if (kind === 'subtitle_success') providerStats.subtitleSuccess += 1;
  if (kind === 'stream_success') providerStats.streamSuccess += 1;
}

function getMirrorHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getMirrorHealth(host) {
  if (!host) return null;
  const hit = mirrorHealth.get(host);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    mirrorHealth.delete(host);
    return null;
  }
  return hit;
}

function updateMirrorHealth(host, payload) {
  if (!host) return;
  const cur = getMirrorHealth(host) || {
    successes: 0,
    failures: 0,
    timeouts: 0,
    cloudflare: 0,
    httpErrors: 0,
    avgLatencyMs: 0,
  };
  const next = Object.assign({}, cur);
  if (payload.success) next.successes += 1;
  if (payload.failure) next.failures += 1;
  if (payload.timeout) next.timeouts += 1;
  if (payload.cloudflare) next.cloudflare += 1;
  if (payload.httpError) next.httpErrors += 1;
  if (Number.isFinite(payload.latencyMs) && payload.latencyMs > 0) {
    const baseline = next.avgLatencyMs || payload.latencyMs;
    next.avgLatencyMs = Math.round((baseline * 0.75) + (payload.latencyMs * 0.25));
  }
  mirrorHealth.set(host, Object.assign(next, { expiresAt: Date.now() + MIRROR_CACHE_TTL_MS }));
}

function scoreMirror(url) {
  const host = getMirrorHost(url);
  const state = getMirrorHealth(host);
  if (!state) return 60;
  const successPenalty = Math.max(0, 20 - (state.successes * 2));
  const failurePenalty = state.failures * 5;
  const timeoutPenalty = state.timeouts * 6;
  const cloudflarePenalty = state.cloudflare * 7;
  const httpPenalty = state.httpErrors * 4;
  const latencyPenalty = Math.min(20, Math.floor((state.avgLatencyMs || 0) / 400));
  return 100 - successPenalty - failurePenalty - timeoutPenalty - cloudflarePenalty - httpPenalty - latencyPenalty;
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
    aliases: Array.isArray(aliases) ? aliases.filter(Boolean) : [],
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
  const isSpecial = /ova|special|movie|ona|extra|recap/i.test(text || '');
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
    'a[href*="watch"],a[href*="player"],button[data-episode]',
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
  if (raw.includes('2160') || raw.includes('4k')) return '2160p';
  if (raw.includes('1440') || raw.includes('2k')) return '1440p';
  if (raw.includes('1080') || raw.includes('fullhd')) return '1080p';
  if (raw.includes('720') || raw.includes('hd')) return '720p';
  if (raw.includes('480')) return '480p';
  if (raw.includes('360')) return '360p';
  if (raw.includes('auto') || raw.includes('default')) return 'auto';
  return String(value || 'Unknown').trim() || 'Unknown';
}

function qualityRank(quality) {
  const q = String(quality || '').toLowerCase();
  if (q.includes('2160') || q.includes('4k')) return 6;
  if (q.includes('1440') || q.includes('2k')) return 5;
  if (q.includes('1080')) return 4;
  if (q.includes('720')) return 3;
  if (q.includes('480')) return 2;
  if (q.includes('360')) return 1;
  if (q.includes('auto')) return 0;
  return 0;
}

/**
 * Detect a confirmed AnimeHeaven onerror placeholder by inspecting the packed
 * query-string structure of the URL. Based on the live forensic evidence, the
 * gate page's `<video>` markup carries `&error` / `&error2` onerror-fallback
 * suffixes that resolve to HTTP 404 and are NOT playable. This operates on the
 * URL's query markers (the actual source structure), NOT a blind substring
 * match on the word "error" — so a legitimate token/query parameter that merely
 * contains letters is never misclassified.
 */
function isConfirmedDeadOnErrorSource(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const q = new URL(value).searchParams;
    // Exactly the confirmed 404 onerror-fallback markers: `error` / `error2`
    // present as a bare query key (i.e. `&error` / `&error2`).
    return q.has('error') || q.has('error2');
  } catch {
    // If the URL cannot be parsed, be conservative and do not classify it as
    // a dead placeholder — only exact structural markers are rejected.
    return false;
  }
}

/**
 * Classify a parsed source for ranking. Returns a number where LOWER is
 * preferred (used as the primary sort key before quality):
 *
 *   1 — GENUINE VIDEO: playable media URL from a real video/stream source
 *       (video, mirror, nested-iframe, config, json-config, escaped-config,
 *       track-media). These are the preferred playback sources.
 *   2 — VALID FALLBACK: playable link/download source (e.g. the confirmed
 *       `&d` download variant that returns HTTP 200 video/mp4) or any other
 *       valid but non-preferred source.
 *   3 — KNOWN DEAD: confirmed AnimeHeaven `&error` / `&error2` onerror
 *       placeholders (HTTP 404). Always ranked last and filtered out before
 *       streamUrl selection.
 */
function sourceClass(src) {
  const url = String((src && src.url) || '');
  if (isConfirmedDeadOnErrorSource(url)) return 3;

  const isMedia = isPlayableMediaUrl(url);
  const type = String((src && src.sourceType) || '').toLowerCase();

  // Genuine video/stream sources (not link/download-only).
  const genuineVideo = ['video', 'mirror', 'nested-iframe', 'config', 'json-config', 'escaped-config', 'track-media'];
  if (isMedia && genuineVideo.includes(type)) return 1;

  // Valid fallback: playable link/download source or other valid source.
  if (isMedia) return 2;

  // Non-playable source (e.g. iframe/embed page) — valid but least preferred
  // among live (non-dead) sources.
  return 2;
}

/**
 * Sort sources by source-class priority (genuine video first), then by quality
 * (descending), then by a deterministic URL lexicographic tie-break. Genuine
 * video sources always win over link/download fallbacks, and confirmed dead
 * onerror placeholders are always pushed last.
 */
function sortSourcesByQuality(sources) {
  return [...sources].sort((a, b) => {
    const ca = sourceClass(a);
    const cb = sourceClass(b);
    if (ca !== cb) return ca - cb;
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

function isStaticAssetUrl(url) {
  const value = String(url || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|ico)(\?|$)/i.test(value);
}

function isLikelyStreamLikeUrl(url) {
  const value = String(url || '').toLowerCase();
  if (!/^https?:\/\//i.test(value)) return false;
  if (value === 'https://' || value === 'http://') return false;
  if (isStaticAssetUrl(value)) return false;
  if (isPlayableMediaUrl(value)) return true;
  if (looksLikeMirror(value)) return true;
  return /stream|play|video|source|manifest|master|playlist|getf\.open|embed|watch/.test(value);
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
    if (!isLikelyStreamLikeUrl(absolute)) return;
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

  const escapedRegex = /(?:file|src|source|manifest)\\x3A\\x22([^\\]+?)\\x22/gi;
  while ((jm = escapedRegex.exec(blob)) !== null) {
    push(jm[1].replace(/\\\//g, '/'), 'auto', 'escaped-config');
  }

  const blobFallbackRegex = /blob:https?:\/\/[^'"\s<>]+/gi;
  while ((jm = blobFallbackRegex.exec(blob)) !== null) {
    // Blob URLs are browser-session scoped. Keep for diagnostics but never rank above real URLs.
    push(jm[0], 'Unknown', 'blob');
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
  if (lower === 'pt' || lower.includes('portuguese')) return 'Portuguese';
  if (lower === 'it' || lower.includes('italian')) return 'Italian';
  if (lower === 'ar' || lower.includes('arabic')) return 'Arabic';
  return raw;
}

function detectSubtitleFormat(url, contentType = '') {
  const value = String(url || '').toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (/\.vtt(\?|$)/.test(value) || type.includes('text/vtt') || type.includes('webvtt')) return 'vtt';
  if (/\.srt(\?|$)/.test(value) || type.includes('application/x-subrip') || type.includes('text/srt')) return 'srt';
  if (/\.ass(\?|$)/.test(value) || type.includes('text/x-ass')) return 'ass';
  if (/\.ssa(\?|$)/.test(value) || type.includes('text/x-ssa')) return 'ssa';
  return 'unknown';
}

function isLikelySubtitleResponse(text, contentType = '') {
  const body = String(text || '').slice(0, 2000);
  const type = String(contentType || '').toLowerCase();
  if (type.includes('text/vtt') || type.includes('webvtt')) return true;
  if (type.includes('application/x-subrip') || type.includes('text/srt') || type.includes('text/x-ass') || type.includes('text/x-ssa')) return true;
  if (/^\s*WEBVTT/i.test(body)) return true;
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(body)) return true;
  return false;
}

function parseSubtitleTracksFromJson(value, baseUrl, out = []) {
  if (!value || typeof value !== 'object') return out;
  const queue = [value];
  const seen = new Set();

  const pushTrack = (url, lang, meta = {}) => {
    const absolute = safeAbsoluteUrl(baseUrl, url);
    if (!absolute) return;
    if (out.some(x => x.url === absolute)) return;
    out.push({
      lang: normalizeSubtitleLang(lang || meta.label || meta.srclang || 'Unknown'),
      url: absolute,
      format: detectSubtitleFormat(absolute),
      default: !!meta.default || /default/i.test(String(meta.kind || '')),
      forced: !!meta.forced || /forced/i.test(String(meta.kind || '')),
    });
  };

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }

    const directUrl = node.file || node.src || node.url || node.uri;
    if (directUrl && /\.(vtt|srt|ass|ssa)(\?|$)/i.test(String(directUrl))) {
      pushTrack(directUrl, node.lang || node.language || node.label || node.srclang || 'Unknown', node);
    }

    const trackLike = node.tracks || node.subtitles || node.captions || node.textTracks || node.subtitleTracks;
    if (trackLike) queue.push(trackLike);

    for (const value2 of Object.values(node)) {
      if (value2 && typeof value2 === 'object') queue.push(value2);
    }
  }

  return out;
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
      format: detectSubtitleFormat(absolute),
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

  const rx2 = /https?:\/\/[^'"\s<>]+\.(ssa|webvtt)(\?[^'"\s<>]*)?/gi;
  while ((m = rx2.exec(blob)) !== null) {
    push(m[0], 'Unknown');
  }

  const subtitleJsonRegex = /(subtitles|tracks)\s*:\s*(\[[\s\S]{0,4000}?\])/gi;
  while ((m = subtitleJsonRegex.exec(blob)) !== null) {
    const urls = extractAllUrls(m[2]);
    for (const u of urls) {
      if (/\.(vtt|srt|ass|ssa)(\?|$)/i.test(u)) push(u, 'Unknown');
    }

    const maybeJson = parseJsonMaybe(m[2]);
    if (maybeJson) {
      const parsed = parseSubtitleTracksFromJson(maybeJson, baseUrl, []);
      for (const track of parsed) {
        push(track.url, track.lang, track);
      }
    }
  }

  const jsonObjRegex = /\{[\s\S]{40,6000}?\}/g;
  while ((m = jsonObjRegex.exec(blob)) !== null) {
    const parsed = parseJsonMaybe(m[0]);
    if (!parsed) continue;
    const tracks = parseSubtitleTracksFromJson(parsed, baseUrl, []);
    for (const track of tracks) {
      push(track.url, track.lang, track);
    }
  }

  return out;
}

function cacheGetSubtitleProbe(key) {
  const hit = subtitleProbeCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    subtitleProbeCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSetSubtitleProbe(key, value) {
  subtitleProbeCache.set(key, {
    value,
    expiresAt: Date.now() + SUBTITLE_PROBE_TTL_MS,
  });
}

async function fetchTextAsset(url, referer = null) {
  const extraHeaders = {};
  const cookie = getCookiesForUrl(url);
  if (cookie) extraHeaders.Cookie = cookie;
  if (referer) extraHeaders.Referer = referer;

  const res = await request(
    { method: 'get', url },
    {
      providerName: PROVIDER_NAME,
      streaming: true,
      timeout: 8000,
      extraHeaders,
      dontTrackHealth: true,
    }
  );

  const contentType = String(res.headers?.['content-type'] || '');
  const body = String(res.data || '');
  return {
    status: Number(res.status || 0),
    contentType,
    body,
  };
}

function parseHlsSubtitleTracks(manifestBody, manifestUrl) {
  const out = [];
  const lines = String(manifestBody || '').split(/\r?\n/);
  for (const line of lines) {
    if (!/^#EXT-X-MEDIA:/i.test(line)) continue;
    if (!/TYPE=SUBTITLES/i.test(line)) continue;
    const uri = line.match(/URI="([^"]+)"/i)?.[1] || line.match(/URI=([^,]+)/i)?.[1] || null;
    if (!uri) continue;
    const lang = line.match(/LANGUAGE="([^"]+)"/i)?.[1]
      || line.match(/NAME="([^"]+)"/i)?.[1]
      || 'Unknown';
    const def = /DEFAULT=YES/i.test(line);
    const forced = /FORCED=YES/i.test(line);
    const abs = safeAbsoluteUrl(manifestUrl, uri);
    if (!abs || out.some(x => x.url === abs)) continue;
    out.push({
      lang: normalizeSubtitleLang(lang),
      url: abs,
      format: detectSubtitleFormat(abs),
      default: def,
      forced,
    });
  }
  return out;
}

async function extractNestedIframeSubtitles(html, pageUrl, depth = 0, visited = new Set()) {
  if (depth > MAX_NESTED_IFRAME_DEPTH) return [];
  if (visited.has(pageUrl)) return [];
  visited.add(pageUrl);

  const $ = cheerio.load(String(html || ''));
  const iframeUrls = $('iframe[src], embed[src], object[data], param[name="movie"]')
    .map((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data') || $(el).attr('value');
      return safeAbsoluteUrl(pageUrl, src);
    })
    .get()
    .filter(Boolean);

  const out = [];
  for (const iframeUrl of iframeUrls) {
    const page = await fetchHtml(iframeUrl, { referer: pageUrl, attempts: 1 });
    if (!page.ok || !page.html) continue;

    const direct = parseSubtitles(page.html, page.url || iframeUrl);
    for (const s of direct) {
      if (!out.some(x => x.url === s.url)) out.push(s);
    }

    const deeper = await extractNestedIframeSubtitles(page.html, page.url || iframeUrl, depth + 1, visited);
    for (const s of deeper) {
      if (!out.some(x => x.url === s.url)) out.push(s);
    }
  }

  return out;
}

// NOTE: Speculative MP4 subtitle probing (guessing `subtitles.vtt` /
// `subtitle.srt` etc. paths on the CDN) has been REMOVED. It caused a burst of
// repeated 404s against the AnimeHeaven CDN for every direct MP4 stream, and
// those guessed URLs are fabricated — not real subtitle tracks. Subtitle
// discovery is now limited to what is genuinely present:
//   1. `<track>` elements / explicit subtitle URLs in gate or iframe HTML
//      (handled by parseSubtitles / extractNestedIframeSubtitles), and
//   2. genuine HLS `#EXT-X-MEDIA` subtitle playlists (handled below).
// No subtitle URL is ever fabricated; a direct MP4 simply reports 'missing'
// external tracks.

async function discoverSubtitlesFromSources(sources, context = {}) {
  const referer = context.referer || null;
  const out = [];

  const add = (row) => {
    if (!row || !row.url) return;
    if (out.some(x => x.url === row.url)) return;
    out.push({
      lang: normalizeSubtitleLang(row.lang || row.language || 'Unknown'),
      url: row.url,
      format: row.format || detectSubtitleFormat(row.url),
      default: !!row.default,
      forced: !!row.forced,
    });
  };

  const limited = (Array.isArray(sources) ? sources : []).slice(0, MAX_SUBTITLE_SOURCE_PROBES);
  for (const src of limited) {
    const sourceUrl = String(src && src.url || '');
    if (!sourceUrl) continue;

    const cacheKey = `subprobe:${sourceUrl}`;
    const cached = cacheGetSubtitleProbe(cacheKey);
    if (cached) {
      for (const row of cached) add(row);
      continue;
    }

    const discovered = [];

    // Only real, manifest-declared HLS subtitle tracks are discovered. No
    // fabricated/guessed subtitle URLs — this does NOT probe arbitrary paths.
    if (/\.m3u8(\?|$)/i.test(sourceUrl)) {
      try {
        const manifest = await fetchTextAsset(sourceUrl, referer);
        const parsed = parseHlsSubtitleTracks(manifest.body, sourceUrl);
        for (const row of parsed) discovered.push(row);
      } catch {
        // ignore m3u8 probe errors
      }
    }

    cacheSetSubtitleProbe(cacheKey, discovered);
    for (const row of discovered) add(row);
  }

  return out;
}

function normalizeEmptyStream(reason) {
  const payload = {
    provider: PROVIDER_NAME,
    streamUrl: null,
    sources: [],
    subtitles: [],
    subtitleMode: 'missing',
    externalTracks: false,
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
    visitedUrls = null,
    allowRedirectParse = true,
    skipCache = false,
    attempts = MAX_FETCH_RETRIES,
  } = options;

  if (!url) {
    return { ok: false, status: 0, url, html: '', cloudflare: false, redirectShell: false, reason: REASON.INVALID_URL };
  }

  const visited = visitedUrls || new Set();
  if (visited.has(url)) {
    recordProviderMetric('redirect_loop');
    return {
      ok: false,
      status: 0,
      url,
      html: '',
      cloudflare: false,
      redirectShell: false,
      redirectedTo: null,
      reason: REASON.REDIRECT_LOOP,
    };
  }
  visited.add(url);

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
      visitedUrls: visited,
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
            visitedUrls: visited,
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

      const retryable = [REASON.NETWORK, REASON.TIMEOUT, REASON.RATE_LIMITED, REASON.CLOUDFLARE, REASON.HTTP_FAILURE];
      if (attempt < attempts && retryable.includes(reason)) {
        logger.warn('[AnimeHeaven] Retry attempt', { attempt: attempt + 1, url, reason });
        await wait((attempt + 1) * 400);
        continue;
      }

      if (reason === REASON.HTTP_FAILURE) recordProviderMetric('http_failure', Date.now() - started);

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

async function runSearch(baseUrl, query, episode) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = `search:${normalizeTitle(q)}:${episode || '-'}`;
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

  const uniq = uniqueByIdentifier(rows);

// Compute the composite relevance score for every candidate. This is used as
// the SOLE semantic tie-breaker, deliberately REPLACING the old alphabetical
// (localeCompare) tie-break so ranking reflects search relevance instead of
// lexicographic order. The weighted composite `relevance` total is the single
// ranking signal on top of the provider score; `relevanceTier` and
// `relevanceFlags` are retained ONLY for diagnostics/explainability and never
// influence the final order.
  const debug = !!(process.env.ANIMEHEAVEN_SEARCH_DEBUG === '1' || process.env.ANIMEHEAVEN_SEARCH_DEBUG === 'true');
  for (const row of uniq) {
    const rel = computeRelevanceScore(row.title, q, row.aliases, episode);
    row.relevance = rel.total;
    row.relevanceTier = rel.tier;
    row.relevanceFlags = rel.flags;
    row.finalRankingScore = Number(row.score || 0) + rel.total;
  }

  // Final ranking order:
  //   1. Provider score (descending)
  //   2. Composite relevance score (descending) — SOLE semantic tie-breaker
  //   3. localeCompare() — deterministic final fallback
  // `relevanceTier` is intentionally NOT compared here; it is diagnostic only.
  const finalRows = uniq
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff) return scoreDiff;
      const relDiff = Number(b.relevance || 0) - Number(a.relevance || 0);
      if (relDiff) return relDiff;
      return String(a.title).localeCompare(String(b.title));
    });

  if (debug && finalRows.length) {
    const top = finalRows.slice(0, 5);
    logger.info('[AnimeHeaven] Search ranking debug', {
      query: q,
      top: top.map(r => ({
        title: r.title,
        identifier: r.identifier,
        providerScore: r.score,
        relevance: r.relevance,
        finalRankingScore: r.finalRankingScore,
        flags: r.relevanceFlags,
      })),
    });
  }

  // Attach a confidence estimate for the #1 result.
  if (finalRows.length) {
    finalRows[0].searchConfidence = computeSearchConfidence(finalRows[0], finalRows[1]);
  }

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

    const pairs = [...text.matchAll(/([A-Za-z][A-Za-z\s]{1,24})\s*:\s*([^:]+?)(?=\s+[A-Za-z][A-Za-z\s]{1,24}\s*:|$)/g)];
    if (pairs.length) {
      for (const pair of pairs) {
        const key = normalizeTitle(pair[1]);
        const value = String(pair[2] || '').trim();
        if (key && value) map[key] = value;
      }
      return;
    }

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

function normalizeStudios(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    const text = String(item || '')
      .replace(/[\[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    const parts = text
      .split(/\s*(?:,|\||\/|;| and )\s*/i)
      .map(v => v.trim())
      .filter(Boolean);

    for (const part of parts) {
      if (part.length < 2 || part.length > 80) continue;
      if (/^https?:\/\//i.test(part)) continue;
      if (/^(n\/a|none|unknown|null)$/i.test(part)) continue;
      out.push(part);
    }
  }
  return [...new Set(out)];
}

function normalizeStatus(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/ongoing|currently\s+airing|airing|broadcasting|releasing/i.test(text)) return 'Ongoing';
  if (/completed|finished|ended|finale/i.test(text)) return 'Completed';
  if (/upcoming|not\s+yet\s+aired|tba|announced|soon/i.test(text)) return 'Upcoming';
  if (/hiatus|on\s+break/i.test(text)) return 'Hiatus';
  return null;
}

function normalizeDuration(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const iso = text.match(/P(?:\d+Y)?(?:\d+M)?(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (iso) {
    const hours = Number(iso[1] || 0);
    const mins = Number(iso[2] || 0);
    const totalMins = (hours * 60) + mins;
    if (totalMins > 0) return `${totalMins} min`;
  }

  const h = text.match(/(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b/i);
  const m = text.match(/(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i);
  const onlyNum = text.match(/^\s*(\d{1,3})\s*$/);
  if (h || m) {
    const mins = (Number(h?.[1] || 0) * 60) + Number(m?.[1] || 0);
    if (mins > 0) return `${mins} min`;
  }
  if (onlyNum) {
    const mins = Number(onlyNum[1]);
    if (mins > 0) return `${mins} min`;
  }

  const rawMin = text.match(/(\d{1,3})\s*(?:min|minutes)\b/i);
  if (rawMin) return `${Number(rawMin[1])} min`;
  return null;
}

function normalizeRating(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const numeric = text.match(/\b(\d+(?:\.\d+)?)\b/);
  if (numeric) return numeric[1];
  const content = text.match(/\b(g|pg|pg-?13|r|r-?17\+|nc-?17|rx|tv-?ma|tv-?14)\b/i);
  if (content) return content[1].toUpperCase().replace(/^TV/, 'TV-').replace('R17+', 'R-17+');
  return null;
}

function parseJsonMaybe(blob) {
  const raw = String(blob || '').trim();
  if (!raw) return null;
  const trimmed = raw
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function collectJsonCandidates($) {
  const candidates = [];

  $('script[type="application/ld+json"],script[type="application/json"]').each((_, el) => {
    const parsed = parseJsonMaybe($(el).contents().text());
    if (parsed) candidates.push(parsed);
  });

  $('script').each((_, el) => {
    const body = $(el).contents().text() || '';
    const snippets = body.match(/\{[\s\S]{40,5000}?\}/g) || [];
    for (const snippet of snippets) {
      const parsed = parseJsonMaybe(snippet);
      if (parsed) candidates.push(parsed);
    }
  });

  return candidates;
}

function walkObjects(root, visit) {
  const queue = [root];
  const seen = new Set();

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visit(node);
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    for (const value of Object.values(node)) queue.push(value);
  }
}

function extractMetadataFromStructuredSources($, html) {
  const out = {
    studios: [],
    rating: null,
    status: null,
    duration: null,
  };

  const lines = [];
  $('[hidden], [style*="display:none"], [style*="display: none"], input[type="hidden"], noscript').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    const valueAttr = $(el).attr('value');
    if (valueAttr) lines.push(String(valueAttr));
  });

  const dataKeys = [
    'studio', 'studios', 'production', 'rating', 'score', 'status', 'duration', 'runtime',
  ];
  $('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!k || !k.startsWith('data-') || !v) continue;
      if (dataKeys.some(key => k.toLowerCase().includes(key))) {
        lines.push(`${k}:${v}`);
      }
    }
  });

  const scriptsText = $('script')
    .map((_, el) => $(el).contents().text() || '')
    .get()
    .join('\n');
  lines.push(scriptsText);

  const rawText = lines.join('\n');

  const studioMatches = [
    ...rawText.matchAll(/(?:studio|studios|production\s*company)\s*[:=]\s*["']([^"'\n]{2,120})["']/gi),
    ...rawText.matchAll(/(?:studio|studios|production\s*company)\s*:\s*([^\n<]{2,120})/gi),
  ];
  for (const m of studioMatches) {
    out.studios.push(...normalizeStudios(m[1]));
  }

  const ratingMatch = rawText.match(/(?:rating|score|imdb|mal|contentrating|ratingvalue)\s*[:=]\s*["']?([^"'\n<]{1,24})/i);
  if (ratingMatch) out.rating = normalizeRating(ratingMatch[1]);

  const statusMatch = rawText.match(/(?:status|airing\s*status|creativeworkstatus)\s*[:=]\s*["']?([^"'\n<]{2,36})/i);
  if (statusMatch) out.status = normalizeStatus(statusMatch[1]);

  const durationMatch = rawText.match(/(?:duration|runtime|episode[_\s-]?runtime|episode[_\s-]?run[_\s-]?time)\s*[:=]\s*["']?([^"'\n<]{1,40})/i)
    || rawText.match(/\bP(?:\d+Y)?(?:\d+M)?(?:\d+D)?T(?:\d+H)?(?:\d+M)?(?:\d+S)?\b/i);
  if (durationMatch) out.duration = normalizeDuration(durationMatch[1] || durationMatch[0]);

  const jsonCandidates = collectJsonCandidates($);
  for (const root of jsonCandidates) {
    walkObjects(root, (node) => {
      const obj = node || {};

      if (!out.rating) {
        const ratingValue = obj.ratingValue
          || obj.contentRating
          || obj.rating
          || obj.score
          || obj.imdbRating
          || obj.averageRating
          || obj.value;
        if (ratingValue) out.rating = normalizeRating(ratingValue);
      }

      if (!out.status) {
        const statusValue = obj.status || obj.airingStatus || obj.creativeWorkStatus;
        if (statusValue) out.status = normalizeStatus(statusValue);
      }

      if (!out.duration) {
        const durationValue = obj.duration || obj.runtime || obj.episode_run_time || obj.episodeRuntime;
        if (durationValue) out.duration = normalizeDuration(durationValue);
      }

      if (!out.studios.length) {
        const studioValue = obj.studio
          || obj.studios
          || obj.productionCompany
          || obj.productionCompanies
          || obj.animation_studio;
        if (studioValue) out.studios.push(...normalizeStudios(asArray(studioValue).map(v => (typeof v === 'object' ? (v.name || v.title || '') : v))));

        const creatorNames = asArray(obj.creator)
          .map(v => (typeof v === 'object' ? (v.name || v.title || '') : v))
          .filter(Boolean);
        if (!out.studios.length && creatorNames.length) {
          out.studios.push(...normalizeStudios(creatorNames));
        }
      }
    });
  }

  out.studios = [...new Set(out.studios)];
  return out;
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
  let status = /ongoing|airing/i.test(statusText)
    ? 'Ongoing'
    : (/completed|finished/i.test(statusText) ? 'Completed' : null);

  const ratingText = map.rating || map.score || map.imdb || $('meta[itemprop="ratingValue"]').attr('content') || '';
  let rating = String(ratingText).match(/\d+(?:\.\d+)?/)?.[0] || null;

  let studios = (map.studio || map.studios || '')
    .split(/[,|/]/)
    .map(v => v.trim())
    .filter(Boolean);

  const season = map.season || (lines.join(' ').match(/\b(spring|summer|fall|autumn|winter)\b/i)?.[0] || null);
  let duration = map.duration || (lines.join(' ').match(/\b\d+\s*(min|minutes|m)\b/i)?.[0] || null);

  const structured = extractMetadataFromStructuredSources($, html);
  if (!status) status = structured.status || null;
  if (!rating) rating = structured.rating || null;
  if (!duration) duration = structured.duration || null;
  if (!studios.length) studios = structured.studios || [];

  status = status ? normalizeStatus(status) || status : null;
  rating = normalizeRating(rating);
  duration = normalizeDuration(duration);
  studios = normalizeStudios(studios);

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
    studios: studios.length ? studios : null,
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
    .sort((a, b) => scoreMirror(b.url) - scoreMirror(a.url))
    .slice(0, MAX_MIRROR_FETCHES);

  if (!mirrors.length) return [];

  const extracted = [];
  for (const mirror of mirrors) {
    const mirrorStart = Date.now();
    const host = getMirrorHost(mirror.url);
    logger.info('[AnimeHeaven] Mirror selected', { mirror: mirror.url });
    const page = await fetchHtml(mirror.url, {
      referer: context.referer,
      allowRedirectParse: true,
      attempts: 1,
    });
    if (!page.ok || !page.html) {
      updateMirrorHealth(host, {
        failure: true,
        timeout: page.reason === REASON.TIMEOUT,
        cloudflare: page.reason === REASON.CLOUDFLARE,
        httpError: page.reason === REASON.HTTP_FAILURE,
        latencyMs: Date.now() - mirrorStart,
      });
      recordProviderMetric('mirror_failure', Date.now() - mirrorStart);
      continue;
    }
    const nested = parseSources(page.html, page.url || mirror.url)
      .filter(src => isPlayableMediaUrl(src.url));

for (const src of nested) {
      if (!extracted.some(x => x.url === src.url)) {
        const ctx = getPlaybackContext(src.url, page.url || mirror.url);
        extracted.push(Object.assign({}, src, {
          sourceType: 'mirror',
          referer: ctx.referer,
          origin: ctx.origin,
          cookies: ctx.cookies,
        }));
      }
    }

    updateMirrorHealth(host, {
      success: nested.length > 0,
      failure: nested.length === 0,
      latencyMs: Date.now() - mirrorStart,
    });
  }

  return extracted;
}

async function extractNestedIframeSources(html, pageUrl, depth = 0, visited = new Set()) {
  if (depth > MAX_NESTED_IFRAME_DEPTH) return [];
  if (visited.has(pageUrl)) return [];
  visited.add(pageUrl);

  const $ = cheerio.load(String(html || ''));
  const iframeUrls = $('iframe[src], embed[src], object[data], param[name="movie"]')
    .map((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data') || $(el).attr('value');
      return safeAbsoluteUrl(pageUrl, src);
    })
    .get()
    .filter(Boolean);

  const out = [];
  for (const iframeUrl of iframeUrls) {
    const page = await fetchHtml(iframeUrl, { referer: pageUrl, attempts: 1 });
    if (!page.ok || !page.html) continue;

    const direct = parseSources(page.html, page.url || iframeUrl)
      .filter(src => isPlayableMediaUrl(src.url));
    for (const src of direct) {
      if (!out.some(x => x.url === src.url)) {
        out.push(Object.assign({}, src, {
          sourceType: 'nested-iframe',
          // Context needed to authorize CDN playback: the referer is the
          // iframe page that embedded the media, cookies/origin are taken
          // from the session captured during the iframe fetch.
          referer: page.url || iframeUrl,
          origin: (() => { try { return new URL(page.url || iframeUrl).origin; } catch { return null; } })(),
          cookies: getCookiesForUrl(page.url || iframeUrl),
        }));
      }
    }

    const deeper = await extractNestedIframeSources(page.html, page.url || iframeUrl, depth + 1, visited);
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
      httpFailures: providerStats.httpFailures,
      redirectLoops: providerStats.redirectLoops,
      mirrorFailures: providerStats.mirrorFailures,
      playerFailures: providerStats.playerFailures,
      subtitleSuccess: providerStats.subtitleSuccess,
      streamSuccess: providerStats.streamSuccess,
    };
  }

async searchAnime(query, limit = 10, episode) {
    const q = String(query || '').trim();
    if (!q) return [];

    logger.info('[AnimeHeaven] Search started', { query: q });
    const started = Date.now();
    try {
      const baseUrl = await pickBaseUrl();
      const rows = await runSearch(baseUrl, q, episode);
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
        const rows = await this.searchAnime(title, 8, episodeNumber);
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
      recordProviderMetric('player_failure');
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
        .filter(src => isPlayableMediaUrl(src.url))
        // Never select a confirmed AnimeHeaven onerror placeholder
        // (`&error` / `&error2`) as the primary playback source. These gate
        // markup placeholders resolve to HTTP 404 even though they sort
        // lexicographically first when all sources are quality "auto".
        .filter(src => !isConfirmedDeadOnErrorSource(src.url));

      // Liveness check: Sequentially verify sources until a playable one is found.
      if (sources.length > 0) {
        logger.info(`[AnimeHeaven] Verifying liveness for ${sources.length} sorted source(s)...`, { title, episode });
        let verifiedSourceIndex = -1;
        for (let i = 0; i < sources.length; i++) {
          const sourceToTest = sources[i];
          logger.info(`[AnimeHeaven] Liveness check [${i + 1}/${sources.length}]`, { quality: sourceToTest.quality, type: sourceToTest.sourceType });
          const liveness = await verifySourceLiveness(sourceToTest);

          if (liveness.live) {
            logger.info(`[AnimeHeaven] Source liveness VERIFIED`, { quality: sourceToTest.quality, status: liveness.status, latencyMs: liveness.durationMs });
            verifiedSourceIndex = i;
            break; // Stop on the first live source
          } else {
            logger.warn(`[AnimeHeaven] Source liveness FAILED`, { quality: sourceToTest.quality, status: liveness.status, reason: liveness.reason });
          }
        }

        if (verifiedSourceIndex > 0) {
          const verifiedSource = sources.splice(verifiedSourceIndex, 1)[0];
          sources.unshift(verifiedSource);
          logger.info(`[AnimeHeaven] Selected verified source at index ${verifiedSourceIndex} as primary.`, { title, episode });
        } else if (verifiedSourceIndex === -1) {
          logger.warn('[AnimeHeaven] All sources failed liveness check. Falling back to original best-guess.', { title, episode });
        }
      }

      if (!sources.length) {
        logger.info('[AnimeHeaven] Stream missing', { title, episode });
        recordProviderMetric('failure', Date.now() - started);
        return normalizeEmptyStream(player.reason || REASON.STREAM_MISSING);
      }

// Attach the full playback context (referer + origin + cookies) to each
      // source so the reverse proxy (controllers/streamProxyController.js) can
      // authorize the CDN request. Hotlink-protected AnimeHeaven CDNs require
      // the matching Referer/Origin and session cookies before serving media.
      const sourceReferer = player.pageUrl || (await pickBaseUrl());
      sources = sources.map(src => {
        if (src.referer && src.origin) return src; // already enriched (nested/mirror)
        const ctx = getPlaybackContext(src.url, sourceReferer);
        return Object.assign({}, src, {
          referer: src.referer || ctx.referer,
          origin: src.origin || ctx.origin,
          cookies: src.cookies || ctx.cookies,
        });
      });

      const subtitles = parseSubtitles(player.html || '', player.pageUrl || (await pickBaseUrl()));
      const nestedSubtitleRows = await extractNestedIframeSubtitles(player.html || '', player.pageUrl || (await pickBaseUrl()));
      for (const row of nestedSubtitleRows) {
        if (!subtitles.some(x => x.url === row.url)) subtitles.push(row);
      }

      if (!subtitles.length) {
        const sourceDerived = await discoverSubtitlesFromSources(sources, {
          referer: player.pageUrl || (await pickBaseUrl()),
        });
        for (const row of sourceDerived) {
          if (!subtitles.some(x => x.url === row.url)) subtitles.push(row);
        }
      }

      if (subtitles.length) {
        logger.info('[AnimeHeaven] Subtitle found', { count: subtitles.length });
        recordProviderMetric('subtitle_success');
      }

      // ── PRE-PROXY RESULT (no proxy rewrite here) ─────────────
      // The provider returns the RAW AnimeHeaven CDN source URLs WITH their
      // server-side playback context (referer/origin/cookies), NOT the
      // ephemeral /api/stream/proxy URL. The persistent stream cache
      // (streamCacheService) stores this pre-proxy data so a later cache HIT
      // can reconstruct the provider result and generate a FRESH proxy URL.
      //
      // The actual proxy URL generation happens ONLY at the boundary where
      // data is returned to the browser (streamController →
      // streamProxy.rewriteResultToProxy()). Never persisting the proxy URL is
      // what fixes the stale-token playback failure: a cached proxy URL
      // embeds an expiring CDN token; caching the raw target + context lets us
      // re-register the source and mint a NEW proxy URL on every playback.
      const rawSubtitles = (subtitles || []).map(track => Object.assign({}, track));
      const streamUrl = sources[0]?.url || null;

      logger.info('[AnimeHeaven] Stream extracted', {
        title,
        episode,
        sources: sources.length,
      });

      recordProviderMetric('success', Date.now() - started);
      recordProviderMetric('stream_success');

      // Subtitle mode reflects only what we can VERIFY. AnimeHeaven's direct
      // MP4 path exposes no separate subtitle tracks, and whether subtitle
      // text is burned into the video frames remains UNVERIFIED — so we report
      // 'missing' (no external tracks found) rather than asserting 'embedded'.
      const externalTracks = rawSubtitles.length > 0;
      const subtitleMode = externalTracks ? 'external' : 'missing';

      return {
        provider: PROVIDER_NAME,
        streamUrl,
        // Raw CDN source (video.mp4?...token) WITH context — never proxied.
        sources,
        subtitles: rawSubtitles,
        subtitleMode,
        externalTracks,
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
  // Exported so the reverse proxy (controllers/streamProxyController.js and
  // controllers/streamProxyQueryController.js) derives the EXACT same playback
  // headers (referer/origin/cookies/userAgent) from ONE source of truth — never
  // stepping outside the provider's cookie jar.
  getPlaybackContext,
  PLAYBACK_USER_AGENT,
  // Exported so the persistent stream cache (config/streamCache.js +
  // services/streamCacheService.js) can clamp its TTL to this provider's
  // known CDN playback-context lifetime. This is the SHORTEST relevant
  // validity period (cookie expiry) that must bound the persistent cache.
  COOKIE_TTL_MS,
  // Exported so the query-based proxy (controllers/streamProxyQueryController.js)
  // rewrites HLS child URIs into the SAME /api/stream/proxy format the provider
  // emits — single source of truth for the proxy URL shape.
  buildProxyUrl,
  STREAM_PROXY_PATH,
  // Exported for the search-ranking regression tests (test-animeheaven-ranking.js)
  // so the composite relevance + confidence logic can be exercised deterministically.
  computeRelevanceScore,
  computeSearchConfidence,
  normalizeTitle,
};
