// services/aniSkipService.js
// AniSkip API integration for fetching anime opening (OP) and ending (ED) timestamps
// Used by the frontend "Skip Intro" / "Skip Outro" buttons during playback.
const axios = require('axios');

const ANISKIP_BASE = 'https://api.aniskip.com/v2';

/**
 * Fetch skip timestamps (OP / ED) for a given anime episode.
 *
 * @param {number|string} malId        - MyAnimeList ID of the anime
 * @param {number|string} episodeNumber - Episode number to query
 * @returns {Promise<{found: boolean, op?: {start: number, end: number}, ed?: {start: number, end: number}>}
 *
 * On success:  { found: true,  op: { start, end }, ed: { start, end } }
 * On 404:      { found: false }
 * On network/server error: throws the error (caller handles it)
 */
async function fetchSkipTimes(malId, episodeNumber) {
  try {
    const url = `${ANISKIP_BASE}/skip-times/${malId}/episodes/${episodeNumber}?types=op&types=ed`;

    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AniStrim2/1.0',
      },
    });

    // AniSkip returns { found: true, results: [...] }
    const { results } = response.data;

    if (!Array.isArray(results) || results.length === 0) {
      return { found: false };
    }

    // Extract OP and ED intervals from the results array
    const opResult = results.find(r => r.type === 'op');
    const edResult = results.find(r => r.type === 'ed');

    const result = { found: true };

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

    return result;
  } catch (err) {
    // Gracefully handle 404 — no skip timestamps exist for this episode
    if (err.response && err.response.status === 404) {
      return { found: false };
    }

    // Re-throw network / server errors so the controller can handle them
    throw err;
  }
}

module.exports = { fetchSkipTimes };

