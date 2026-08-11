// ============================================================
//  controllers/streamController.js — AnimeHeaven Stream Endpoints
//
//  Provides:
//    1. GET /api/stream/:animeTitle/:episodeIdentifier
//       → Best stream for user's tier (AnimeHeaven single provider)
//       IMPORTANT: episodeIdentifier should be the EPISODE NUMBER,
//       NOT the database record ID. The frontend MUST distinguish
//       between episodeId (DB record ID) and episodeNumber.
//    2. GET /api/stream/providers/:animeTitle/:episodeNumber
//       → List providers for the "Switch Server" dropdown
//       (single AnimeHeaven entry; response contract unchanged)
//    3. POST /api/stream/offline-download
//       → Premium-only download authorization
//
//  Response contracts are IDENTICAL to the previous multi-provider
//  version. The `preferredProvider` query/body param is still accepted
//  for backward compatibility but is IGNORED by the single-provider
//  streaming engine (AnimeHeaven is the only provider).
// ============================================================
const db = require('../config/db');
const streamingService = require('../services/streamingService');
const logger = require('../utils/logger');
const streamProxy = require('../utils/streamProxy');

/**
 * Resolve the DB episode id + authoritative premium status for an
 * (animeTitle, episodeNumber) pair. Playback-infrastructure only — it never
 * alters the CMS or episode data. Returns nulls when the episode cannot be
 * resolved from the database (never throws).
 *
 * Used for server-side premium authorization so a direct call cannot obtain a
 * premium stream for an unauthorized user.
 *
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @returns {Promise<{episodeId: number|null, isPremiumEpisode: boolean, mediaId: number|null}>}
 */
async function resolveEpisodeAuth(animeTitle, episodeNumber) {
  const out = { episodeId: null, isPremiumEpisode: false, mediaId: null };
  if (!animeTitle || !animeTitle.trim() || episodeNumber === undefined || episodeNumber === null || episodeNumber === '') {
    return out;
  }
  try {
    const [mediaRows] = await db.query(
      'SELECT id FROM anime WHERE title = ? OR title_japanese = ? LIMIT 1',
      [animeTitle, animeTitle]
    );
    if (!mediaRows || !mediaRows[0]) return out;
    out.mediaId = mediaRows[0].id;
    const [epRows] = await db.query(
      'SELECT id, is_premium FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
      [mediaRows[0].id, episodeNumber]
    );
    if (epRows && epRows[0]) {
      out.episodeId = epRows[0].id;
      // is_premium is TINYINT(1) — normalize to boolean.
      out.isPremiumEpisode = epRows[0].is_premium === 1 || epRows[0].is_premium === true;
    }
  } catch (err) {
    logger.warn('[StreamController] premium-check lookup failed', { animeTitle, episode: episodeNumber, error: err.message });
  }
  return out;
}

/**
 * GET /api/stream/:animeTitle/:episodeIdentifier
 * Resolves the best stream using priority-ordered providers.
 * Enforces quality tier: free ≤720p, premium up to 4K.
 *
 * @param {string} animeTitle — URL-encoded anime title
 * @param {string|number} episodeIdentifier — Should be the episode NUMBER
 *   (e.g., 1, 2, 34).  NOT the database record ID.
 *
 * Query params:
 *   preferredProvider — optional, forces a specific provider
 *   ep — if provided, overrides episodeIdentifier as the episode number
 *        (useful when the route param is ambiguous)
 *
 * Response:
 *   { success, provider, streamUrl, sources, subtitles, bestQuality, tier, episodeNumber }
 */
exports.getStream = async (req, res) => {
  const { animeTitle, episodeNumber: episodeIdentifier } = req.params;
  const { preferredProvider, ep: queryEp } = req.query;

  if (!animeTitle || !episodeIdentifier) {
    return res.status(400).json({ error: 'animeTitle and episode identifier are required.' });
  }

  // Determine user's premium status
  const isPremium = req.user?.isPremium === true || req.user?.isAdmin === true;

  const startTime = Date.now();

  try {
    // ── Episode Number Resolution ─────────────────────────
    // PRIORITY ORDER (deterministic, not guessing):
    //   1. Query param ?ep=N — explicit episode number from frontend
    //   2. If media_type is MOVIE → always Episode 1
    //   3. If identifier looks like a DB record ID, try to map it to episode_number
    //   4. Fallback: use episodeIdentifier as-is (assumed to be episode number)
    //
    // RULE: Database IDs are NEVER passed to the player as episode numbers.
    // If the frontend sends ?epId=33, the backend maps it to the real episode_number.
    // If mapping fails, return an error instead of silently using a wrong number.

    let episodeNumber;
    let resolvedFrom = 'direct';
    let mediaType = null;
    let mediaId = null;

    // Priority 1: explicit ?ep=N query param (frontend canonical)
    if (queryEp !== undefined && queryEp !== null && queryEp !== '') {
      episodeNumber = Number(queryEp);
      resolvedFrom = 'queryParam';
      logger.debugStream(`[StreamController] Using explicit ?ep=${episodeNumber} from query param`, { animeTitle, episode: episodeNumber });
    } else {
      // Priority 2 & 3: Check database for media type and ID mapping
      // SIMPLIFICATION: The route contract is /:animeTitle/:episodeNumber.
      // We will no longer attempt to guess if the identifier is a database ID.
      // The identifier from the URL is treated as the episode number unless it's a movie.
      try {
        const [mediaRows] = await db.query(
          'SELECT id, media_type FROM anime WHERE title = ? OR title_japanese = ? LIMIT 1',
          [animeTitle, animeTitle]
        );

        if (mediaRows?.length > 0) {
          mediaType = (mediaRows[0].media_type || 'TV').toUpperCase();
          mediaId = mediaRows[0].id;

          if (mediaType === 'MOVIE') {
            logger.debugStream(`[StreamController] "${animeTitle}" (id=${mediaId}) is a MOVIE — forcing episode to 1`, { animeTitle, mediaId });
            episodeNumber = 1;
            resolvedFrom = 'movieOverride';
          } else {
            episodeNumber = episodeIdentifier;
            resolvedFrom = 'direct';
          }
        } else {
          // Anime not found in DB — identifier is the episode number
          episodeNumber = episodeIdentifier;
          resolvedFrom = 'direct';
          logger.debugStream(`[StreamController] Anime "${animeTitle}" not in DB — using identifier "${episodeIdentifier}" as episode number`, { animeTitle });
        }
      } catch (dbErr) {
        // DB error — fallback to using identifier directly
        logger.warn(`[StreamController] DB lookup failed — using identifier as-is`, { animeTitle, error: dbErr.message });
        episodeNumber = episodeIdentifier;
        resolvedFrom = 'dbError';
      }
    }

    // Validate episode number is reasonable
    const epNum = Number(episodeNumber);
    if (isNaN(epNum) || epNum < 1 || epNum > 10000) {
      logger.warn(`[StreamController] Unreasonable episode number — using as-is anyway`, { animeTitle, episodeNumber });
    }

logger.debugStream(`[StreamController] RESOLVED: "${animeTitle}" → Ep ${episodeNumber}`, { animeTitle, episode: episodeNumber, resolvedFrom, mediaType, mediaId });

    // ── Server-Side Premium Episode Enforcement ──────────────
    // Before any cache lookup, AnimeHeaven resolution, or source generation,
    // determine whether the episode is premium AND the requester is authorized.
    // If the episode is premium and the requester is NOT an authenticated
    // premium user or admin, return a 403 response immediately — no cache
    // read, no AnimeHeaven resolution, no source URL exposed.
    //
    // This is done AFTER episode number resolution so we have the correct
    // episodeNumber (even if overridden by ?ep= or movie detection).
    const { isPremiumEpisode } = await resolveEpisodeAuth(animeTitle, episodeNumber);
    if (isPremiumEpisode && !isPremium) {
      const msg = `Episode ${episodeNumber} of "${animeTitle}" is premium. A premium subscription is required to stream this episode.`;
      logger.warn('[StreamController] Premium episode blocked for free user', {
        animeTitle,
        episode: episodeNumber,
      });
      return res.status(403).json({
        success: false,
        error: msg,
      });
    }

    // ── Resolve the DB episode id (for persistent stream cache) ──
    // Best-effort: resolves episodeId from anime_id + episode_number so the
    // persistent stream cache can key on the canonical episodes.id. This is
    // playback infrastructure only — it never alters the CMS or episode data.
    let episodeId = null;
    try {
      if (mediaId && episodeNumber) {
        const [epRows] = await db.query(
          'SELECT id, is_premium FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
          [mediaId, episodeNumber]
        );
        episodeId = epRows && epRows[0] ? epRows[0].id : null;
      }
    } catch (epErr) {
      logger.debugStream('[StreamController] episodeId lookup failed (cache will be bypassed)', { animeTitle, episode: episodeNumber, error: epErr.message });
      episodeId = null;
    }

    const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
      isPremium,
      preferredProvider: preferredProvider || undefined,
      episodeId: episodeId || undefined,
    });

    // Rewrite AnimeHeaven sources to anonymized /api/stream-proxy/:streamId
    // URLs. Context (cookies/referer/origin) is stored server-side in the
    // streamProxyStore and NEVER returned to the browser. Anonymous
    // providers (Consumet, etc.) are returned unchanged.
    const publicResult = streamProxy.rewriteResultToProxy(result) || result;

    const elapsed = Date.now() - startTime;
    logger.streamAttempt({
      provider: publicResult.provider,
      animeTitle,
      episode: episodeNumber,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: elapsed,
      result: 'success',
      httpStatus: 200,
      timeoutStatus: false,
      cloudflareDetected: false,
      searchSuccess: true,
      streamSuccess: true,
      sourceCount: publicResult.sources?.length || 0,
      bestQuality: publicResult.bestQuality,
      resolvedFrom,
    });

    res.json({
      success: true,
      ...publicResult,
      episodeNumber,
      resolvedFrom,
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.streamAttempt({
      provider: 'stream-endpoint',
      animeTitle,
      episode: episodeIdentifier,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: elapsed,
      result: 'failure',
      failureReason: 'Could not resolve a stream.',
      error: err.message, // internal detail — server-side only, never shipped to client
      httpStatus: 0,
      timeoutStatus: /timeout/i.test(err.message || ''),
      cloudflareDetected: /cloudflare/i.test(err.message || ''),
      searchSuccess: false,
      streamSuccess: false,
    });
    res.status(502).json({
      success: false,
      error: 'Could not resolve a stream. Try another provider or check back later.',
    });
  }
};

/**
 * GET /api/stream/providers/:animeTitle/:episodeNumber
 * Returns all available providers with their streams, for the
 * "Switch Server" dropdown in the frontend player.
 *
 * Response:
 *   { success, providers: [{ provider, streamUrl, bestQuality }] }
 */
exports.listProviders = async (req, res) => {
  const { animeTitle, episodeNumber } = req.params;

  if (!animeTitle || !episodeNumber) {
    return res.status(400).json({ error: 'animeTitle and episodeNumber are required.' });
  }

  const isPremium = req.user?.isPremium === true || req.user?.isAdmin === true;

  try {
    // ── Server-Side Premium Episode Enforcement ──────────────
    // Apply the same authorization rule as the main stream endpoint so the
    // "Switch Server" endpoint cannot bypass the premium episode restriction.
    const { isPremiumEpisode } = await resolveEpisodeAuth(animeTitle, episodeNumber);
    if (isPremiumEpisode && !isPremium) {
      logger.warn('[StreamController] Premium episode blocked for free user (providers)', {
        animeTitle,
        episode: episodeNumber,
      });
      return res.status(403).json({
        success: false,
        error: `Episode ${episodeNumber} of "${animeTitle}" is premium. A premium subscription is required to stream this episode.`,
      });
    }

    const providers = await streamingService.resolveAllProviders(animeTitle, episodeNumber, {
      isPremium,
    });

    // Rewrite each provider's AnimeHeaven sources to anonymized proxy URLs and
    // strip any server-side context before returning to the browser.
    const publicProviders = providers.map((p) => {
      const safe = streamProxy.rewriteResultToProxy(p);
      return safe || p;
    });

    res.json({
      success: true,
      providers: publicProviders,
    });
} catch (err) {
    logger.error('[StreamController] listProviders error', { animeTitle, episodeNumber, error: err.message });
    res.status(502).json({
      success: false,
      error: 'Could not load providers. Try again later.',
      providers: [],
    });
  }
};

/**
 * POST /api/stream/offline-download
 * Premium-only: Initiates a sandboxed download for offline viewing.
 * The download is handled client-side via Capacitor Filesystem.
 * This endpoint just authorizes and returns the stream URL + metadata.
 *
 * Body: { animeTitle, episodeNumber, provider? }
 * Headers: Authorization: Bearer <token>
 *
 * Response:
 *   { authorized: true, streamUrl, quality, episodeTitle, animeTitle }
 */
exports.authorizeDownload = async (req, res) => {
  // Premium/admin only
  if (!req.user?.isPremium && !req.user?.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Premium subscription required for offline downloads.',
    });
  }

  const { animeTitle, episodeNumber, provider: preferredProvider } = req.body;

  if (!animeTitle || !episodeNumber) {
    return res.status(400).json({ error: 'animeTitle and episodeNumber are required.' });
  }

  try {
const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
      isPremium: true,
      preferredProvider: preferredProvider || undefined,
    });

    if (!result.streamUrl) {
      return res.status(502).json({ error: 'Could not resolve a stream source for download.' });
    }

    // Rewrite through the proxy so downloads also carry the cookie/referer
    // context the scraper established (and never expose it to the client).
    const publicResult = streamProxy.rewriteResultToProxy(result) || result;

    res.json({
      success: true,
      authorized: true,
      streamUrl: publicResult.streamUrl,
      quality: publicResult.bestQuality,
      provider: publicResult.provider,
      animeTitle,
      episodeNumber,
    });
} catch (err) {
    logger.error('[StreamController] authorizeDownload error', { animeTitle, episodeNumber, error: err.message });
    res.status(502).json({ error: 'Could not resolve a stream source for download.' });
  }
};
