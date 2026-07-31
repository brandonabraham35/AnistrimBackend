// services/aniSkipService.js
// Dual-provider skip timestamps service for fetching anime opening (OP) and ending (ED) intervals.
// Primary: AniSkip API (public, 3-second timeout)
// Fallback: Anime-Skip API (requires ANIMESKIP_API_KEY env var)
// Used by the frontend "Skip Intro" / "Skip Outro" buttons during playback.
//
// HTTP LAYER: Uses shared providerHttp client for consistent headers, logging,
// retry, and proxy management. Proxy is intentionally skipped (skipProxy=true)
// since AniSkip/Anime-Skip are metadata APIs, not streaming sources.
const { get } = require('../utils/providerHttp');

const ANISKIP_BASE = 'https://api.aniskip.com/v2';
const ANIMESKIP_BASE = 'https://api.anime-skip.com/v1';

/**
 * Attempt to fetch skip times from the primary AniSkip API.
 * Uses the shared HTTP layer with skipProxy=true (metadata API, not streaming).
 * @param {number|string} malId
 * @param {number|string} episodeNumber
 * @returns {Promise<object|null>} Parsed result or null if unavailable
 */
async function fetchFromAniSkip(malId, episodeNumber) {
  try {
    const url = `${ANISKIP_BASE}/skip-times/${malId}/episodes/${episodeNumber}?types=op&types=ed`;

    const response = await get(url, {
      providerName: 'aniskip',
      timeout: 3000,            // 3-second timeout as required
      maxRetries: 0,            // No retries — fast failover to fallback
      skipProxy: true,          // Metadata API — no proxy needed
      dontTrackHealth: true,    // Skip health tracking (metadata-only)
      extraHeaders: {
        'Accept': 'application/json',
      },
    });

    // AniSkip returns { found: true, results: [...] }
    const { results } = response.data;

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    // Extract OP and ED intervals from the results array
    const opResult = results.find(r => r.type === 'op');
    const edResult = results.find(r => r.type === 'ed');

    const result = {};

    if (opResult?.interval) {
      result.op = {
        start: opResult.interval.startTime,
        end:   opResult.interval.endTime,
      };
    }

    if (edResult?.interval) {
      result.ed = {
        start: edResult.interval.startTime,
        end:   edResult.interval.endTime,
      };
    }

    // Only return found if at least one interval was extracted
    if (result.op || result.ed) {
      return result;
    }

    return null;
  } catch {
    // Any error (timeout, network, 404, 5xx) — return null to trigger fallback
    return null;
  }
}

/**
 * Attempt to fetch skip times from the secondary Anime-Skip API.
 * Uses the shared HTTP layer with skipProxy=true (metadata API, not streaming).
 * @param {number|string} malId
 * @param {number|string} episodeNumber
 * @returns {Promise<object|null>} Parsed result or null if unavailable
 */
async function fetchFromAnimeSkip(malId, episodeNumber) {
  const apiKey = process.env.ANIMESKIP_API_KEY;

  // Skip if no API key is configured
  if (!apiKey) {
    console.warn('[AnimeSkip] ANIMESKIP_API_KEY is not set. Skipping fallback provider.');
    return null;
  }

  try {
    const url = `${ANIMESKIP_BASE}/skip-times/${malId}/${episodeNumber}`;

    const response = await get(url, {
      providerName: 'anime-skip',
      timeout: 5000,            // 5-second timeout for fallback
      maxRetries: 0,            // No retries — both providers exhausted anyway
      skipProxy: true,          // Metadata API — no proxy needed
      dontTrackHealth: true,    // Skip health tracking (metadata-only)
      extraHeaders: {
        'Accept': 'application/json',
        'x-api-key': apiKey,
      },
    });

    const data = response.data;

    // Anime-Skip response structure varies; map known fields
    // Expected shape: { op: { start, end }, ed: { start, end } } or similar
    if (!data || typeof data !== 'object') {
      return null;
    }

    const result = {};

    // Map OP if present
    if (data.op && typeof data.op.start === 'number' && typeof data.op.end === 'number') {
      result.op = {
        start: data.op.start,
        end:   data.op.end,
      };
    }

    // Map ED if present
    if (data.ed && typeof data.ed.start === 'number' && typeof data.ed.end === 'number') {
      result.ed = {
        start: data.ed.start,
        end:   data.ed.end,
      };
    }

    // Also check common alternative key names (intro/outro)
    if (!result.op && data.intro && typeof data.intro.start === 'number' && typeof data.intro.end === 'number') {
      result.op = {
        start: data.intro.start,
        end:   data.intro.end,
      };
    }

    if (!result.ed && data.outro && typeof data.outro.start === 'number' && typeof data.outro.end === 'number') {
      result.ed = {
        start: data.outro.start,
        end:   data.outro.end,
      };
    }

    if (result.op || result.ed) {
      return result;
    }

    return null;
  } catch {
    // Silently fail — both providers exhausted
    return null;
  }
}

/**
 * Fetch skip timestamps (OP / ED) for a given anime episode.
 * Implements a dual-provider fallback strategy:
 *   1. Try AniSkip (primary, 3s timeout)
 *   2. If primary fails → try Anime-Skip (secondary, requires API key)
 *   3. If both fail → return { found: false }
 *
 * @param {number|string} malId        - MyAnimeList ID of the anime
 * @param {number|string} episodeNumber - Episode number to query
 * @returns {Promise<{found: boolean, op?: {start: number, end: number}, ed?: {start: number, end: number}>}
 *
 * On success:  { found: true,  op: { start, end }, ed: { start, end } }
 * On failure:  { found: false }
 */
async function fetchSkipTimes(malId, episodeNumber) {
  // 1. Primary provider: AniSkip
  const aniskipResult = await fetchFromAniSkip(malId, episodeNumber);
  if (aniskipResult) {
    return { found: true, ...aniskipResult };
  }

  // 2. Fallback provider: Anime-Skip
  const animeSkipResult = await fetchFromAnimeSkip(malId, episodeNumber);
  if (animeSkipResult) {
    return { found: true, ...animeSkipResult };
  }

  // 3. Both providers exhausted — graceful failure
  return { found: false };
}

module.exports = { fetchSkipTimes };

