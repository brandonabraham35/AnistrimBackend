// ============================================================
//  services/hostedConsumetProvider.js — Hosted Consumet Fallback
//
//  TIER 2 FALLBACK PROVIDER:
//  A dedicated client for a HOSTED Consumet instance (e.g. a self-hosted
//  or public Consumet API server). This provider activates ONLY when the
//  local Consumet sub-providers (Tier 1) fail to resolve a playable stream.
//
//  DESIGN PRINCIPLES:
//    • No hardcoded URLs — every endpoint path is configurable via env vars.
//    • Dedicated axios client (createStreamingInstance) with an INDEPENDENT
//      timeout so it never affects (or is affected by) other providers.
//    • Preserves the EXACT output shape used by streamingService.js:
//        { provider, streamUrl, sources, subtitles }
//    • Health tracking is delegated to the caller (streamingService) via the
//      shared providerHttp helpers, so the "consumet-http" health key stays
//      consistent with the rest of the pipeline.
//
//  CONFIGURATION (all optional, defaults applied):
//    CONSUMET_API_URL                 — base URL of the hosted Consumet instance
//    CONSUMET_HOSTED_TIMEOUT_MS       — independent request timeout (default 10000)
//    CONSUMET_HOSTED_SEARCH_PATH      — search endpoint path template (default /anime/{query})
//    CONSUMET_HOSTED_INFO_PATH        — anime info endpoint path template (default /anime/{id})
//    CONSUMET_HOSTED_SOURCES_PATH     — episode sources endpoint path template
//                                      (default /anime/{id}/episodes/{episodeId})
//
//  Path templates support {query}, {id} and {episodeId} placeholders which are
//  URL-encoded before substitution. This makes the provider compatible with any
//  Consumet-compatible API layout without code changes.
// ============================================================
const { createStreamingInstance } = require('../utils/streamingHttp');
const { PROVIDER_IDS } = require('./providerRegistry');

// ── Configuration ───────────────────────────────────────────
// No hardcoded endpoint URLs. All paths derive from env vars with sensible
// defaults that match the standard Consumet REST API layout.
const CONFIG = {
  baseUrl: process.env.CONSUMET_API_URL || '',
  timeoutMs: parseInt(process.env.CONSUMET_HOSTED_TIMEOUT_MS || '10000', 10),
  searchPath: process.env.CONSUMET_HOSTED_SEARCH_PATH || '/anime/{query}',
  infoPath: process.env.CONSUMET_HOSTED_INFO_PATH || '/anime/{id}',
  sourcesPath: process.env.CONSUMET_HOSTED_SOURCES_PATH || '/anime/{id}/episodes/{episodeId}',
};

// ── Dedicated Axios Client ──────────────────────────────────
// An INDEPENDENT streaming client with its OWN timeout. This guarantees the
// hosted fallback has an isolated timeout budget and does not share proxy
// rotation / retry state with the local Consumet sub-providers.
const client = createStreamingInstance({
  timeout: CONFIG.timeoutMs,
  tag: 'consumet-hosted',
});

// ── Helpers ─────────────────────────────────────────────────

/**
 * Whether the hosted fallback is configured (i.e. a base URL is set).
 * The fallback only activates when CONSUMET_API_URL is present.
 * @returns {boolean}
 */
function isConfigured() {
  // Trim trailing slashes and validate a non-empty base URL.
  const base = (CONFIG.baseUrl || '').trim().replace(/\/+$/, '');
  return base.length > 0;
}

/**
 * Substitute {placeholders} in a path template with URL-encoded values.
 * @param {string} template - e.g. '/anime/{id}/episodes/{episodeId}'
 * @param {object} params - { query, id, episodeId }
 * @returns {string} Resolved path with encoded placeholders
 */
function buildPath(template, params = {}) {
  let path = template || '';
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const encoded = encodeURIComponent(String(value));
    // Replace {key} and {key} with surrounding slashes handled safely.
    path = path.split(`{${key}}`).join(encoded);
  }
  return path;
}

/**
 * Resolve the full URL for a given endpoint template.
 * Joins the base URL and the resolved path, normalizing slashes.
 * @param {string} template - Path template
 * @param {object} params - Placeholder values
 * @returns {string}
 */
function buildUrl(template, params) {
  const base = (CONFIG.baseUrl || '').trim().replace(/\/+$/, '');
  const path = buildPath(template, params);
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}

/**
 * Extract playable sources from a Consumet episodes/sources response.
 * Normalizes source objects into { url, quality }.
 * @param {Array} rawSources - Raw sources array from the API
 * @returns {Array<{url: string, quality: string}>}
 */
function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  return rawSources
    .filter(s => s && (s.url || s.file))
    .map(s => ({
      url: s.url || s.file,
      quality: s.quality || s.qualityLabel || 'auto',
    }));
}

// ── Public API ──────────────────────────────────────────────

/**
 * Resolve a playable stream for an anime episode via the hosted Consumet API.
 *
 * NOTE: This method does NOT perform health tracking itself — the caller
 * (streamingService.js) is responsible for recording success/failure against
 * the shared 'consumet-http' health key, exactly as it does for the other
 * HTTP/Miruro resolvers.
 *
 * @param {object} params
 * @param {string} params.title - Anime title
 * @param {number|string} params.episode - Episode number
 * @returns {Promise<{provider: string, streamUrl: string, sources: Array, subtitles: Array}>}
 */
async function resolveStream({ title, episode }) {
  if (!isConfigured()) {
    const err = new Error('Hosted Consumet fallback is not configured (CONSUMET_API_URL not set).');
    err.code = 'CONSUMET_NOT_CONFIGURED';
    throw err;
  }

  const startTime = Date.now();
  const logTag = `[HostedConsumet]`;

  // 1. Search for the anime.
  const searchUrl = buildUrl(CONFIG.searchPath, { query: title });
  const searchRes = await client.get(searchUrl);
  const results = searchRes.data?.results || [];
  if (!results.length) {
    throw new Error(`Hosted Consumet search returned no results for "${title}"`);
  }

  const target = results[0];
  const animeId = target.id;
  if (!animeId) {
    throw new Error(`Hosted Consumet search returned a result without an id for "${title}"`);
  }

  // 2. Fetch anime info to locate the requested episode.
  const infoUrl = buildUrl(CONFIG.infoPath, { id: animeId });
  const infoRes = await client.get(infoUrl);
  const episodes = infoRes.data?.episodes || [];
  const targetEp = episodes.find(e => e.number === Number(episode));
  if (!targetEp?.id) {
    throw new Error(`Hosted Consumet could not find episode ${episode} for "${title}"`);
  }

  // 3. Fetch streaming sources for the episode.
  const sourcesUrl = buildUrl(CONFIG.sourcesPath, { id: animeId, episodeId: targetEp.id });
  const srcRes = await client.get(sourcesUrl);

  const sources = normalizeSources(srcRes.data?.sources);
  if (!sources.length) {
    throw new Error(`Hosted Consumet returned no playable sources for "${title}" Ep ${episode}`);
  }

  const subtitles = (srcRes.data?.subtitles || []).map(sub => ({
    lang: sub.lang || sub.language || 'Unknown',
    url: sub.url,
  }));

  const best = sources.reduce(
    (a, b) => (parseInt(String(b.quality).replace(/[^0-9k]/g, '') || 0, 10) >
              parseInt(String(a.quality).replace(/[^0-9k]/g, '') || 0, 10) ? b : a),
    sources[0]
  );

  console.log(`${logTag} ✅ Resolved "${title}" Ep ${episode} in ${Date.now() - startTime}ms | ${sources.length} sources | best: ${best.quality || 'auto'}`);

  return {
    provider: PROVIDER_IDS.CONSUMET_HTTP, // 'consumet-http'
    streamUrl: best?.url || sources[0]?.url || null,
    sources,
    subtitles,
  };
}

/**
 * Expose the resolved configuration for diagnostics / logging.
 * @returns {object} Current configuration (baseUrl redacted to a safe host)
 */
function getConfig() {
  let baseUrl = CONFIG.baseUrl;
  try {
    const u = new URL(baseUrl);
    baseUrl = `${u.protocol}//${u.host}`;
  } catch (_) {
    /* keep as-is if not a valid URL */
  }
  return {
    baseUrl,
    timeoutMs: CONFIG.timeoutMs,
    searchPath: CONFIG.searchPath,
    infoPath: CONFIG.infoPath,
    sourcesPath: CONFIG.sourcesPath,
  };
}

module.exports = {
  resolveStream,
  isConfigured,
  getConfig,
};
