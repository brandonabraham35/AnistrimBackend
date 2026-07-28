// ============================================================
//  controllers/streamController.js — Multi-API Stream Endpoints
//
//  Provides:
//    1. GET /api/stream/:animeTitle/:episodeIdentifier
//       → Auto-fallback best stream for user's tier
//       IMPORTANT: episodeIdentifier should be the EPISODE NUMBER,
//       NOT the database record ID. The frontend MUST distinguish
//       between episodeId (DB record ID) and episodeNumber.
//    2. GET /api/stream/providers/:animeTitle/:episodeNumber
//       → List all providers for the "Switch Server" dropdown
//    3. POST /api/stream/offline-download
//       → Premium-only download authorization
// ============================================================
const db = require('../config/db');
const streamingService = require('../services/streamingService');

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
  const { animeTitle, episodeIdentifier } = req.params;
  const { preferredProvider, ep: queryEp } = req.query;

  if (!animeTitle || !episodeIdentifier) {
    return res.status(400).json({ error: 'animeTitle and episode identifier are required.' });
  }

  // Determine user's premium status
  const isPremium = req.user?.isPremium === true || req.user?.isAdmin === true;

  const startTime = Date.now();

  try {
    // ── Episode Number Resolution ─────────────────────────
    // Priority:
    //   1. Query param ?ep=N (frontend can explicitly pass episode number)
    //   2. Try to look up in DB if episodeIdentifier looks like a DB ID
    //      (check if media_type is MOVIE → use ep 1)
    //   3. Try to map DB record ID → episode_number
    //   4. Fallback: use episodeIdentifier as-is (assume it IS the episode number)

    let episodeNumber;
    let resolvedFrom = 'direct';
    let mediaType = null;

    // Priority 1: explicit ?ep=N query param
    if (queryEp !== undefined && queryEp !== null && queryEp !== '') {
      episodeNumber = Number(queryEp);
      resolvedFrom = 'queryParam';
      console.log(`[StreamController] Using explicit ?ep=${episodeNumber} from query param`);
    } else {
      // Priority 2 & 3: Check database
      try {
        const [mediaRows] = await db.query(
          'SELECT id, media_type FROM anime WHERE title = ? OR title_japanese = ? LIMIT 1',
          [animeTitle, animeTitle]
        );

        if (mediaRows && mediaRows.length > 0) {
          mediaType = (mediaRows[0].media_type || 'TV').toUpperCase();

          if (mediaType === 'MOVIE') {
            console.log(`[StreamController] "${animeTitle}" is a MOVIE — overriding episode to 1`);
            episodeNumber = 1;
            resolvedFrom = 'movieOverride';
          } else {
            // Try to map the identifier as a DB episode record ID
            const [episodes] = await db.query(
              'SELECT episode_number FROM episodes WHERE id = ?',
              [episodeIdentifier]
            );

            if (episodes && episodes.length > 0) {
              episodeNumber = episodes[0].episode_number;
              resolvedFrom = 'dbMapping';
              console.log(`[StreamController] Mapped DB id ${episodeIdentifier} → Episode ${episodeNumber}`);
            } else {
              // Not a valid DB ID — assume it IS the episode number
              episodeNumber = episodeIdentifier;
              resolvedFrom = 'direct';
              console.log(`[StreamController] Using identifier as episode number: ${episodeNumber}`);
            }
          }
        } else {
          // Anime not found in DB — identifier is the episode number
          episodeNumber = episodeIdentifier;
          resolvedFrom = 'direct';
          console.log(`[StreamController] Anime "${animeTitle}" not in DB — using identifier "${episodeIdentifier}" as episode number`);
        }
      } catch (dbErr) {
        // DB error — fallback to using identifier directly
        console.warn(`[StreamController] DB lookup failed: ${dbErr.message} — using identifier as-is`);
        episodeNumber = episodeIdentifier;
        resolvedFrom = 'dbError';
      }
    }

    // Validate episode number is reasonable
    const epNum = Number(episodeNumber);
    if (isNaN(epNum) || epNum < 1 || epNum > 10000) {
      console.warn(`[StreamController] Unreasonable episode number: ${episodeNumber} — using as-is anyway`);
    }

    console.log(`[StreamController] Resolving: "${animeTitle}" Ep ${episodeNumber} (resolvedFrom: ${resolvedFrom}, mediaType: ${mediaType})`);

    const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
      isPremium,
      preferredProvider: preferredProvider || undefined,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[StreamController] ✅ Resolved "${animeTitle}" Ep ${episodeNumber} → ${result.provider} (${elapsed}ms)`);

    res.json({
      success: true,
      ...result,
      episodeNumber,
      resolvedFrom,
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[StreamController] ❌ getStream failed for "${animeTitle}" identifier ${episodeIdentifier} (${elapsed}ms): ${err.message}`);
    res.status(502).json({
      success: false,
      error: err.message,
      message: 'Could not resolve a stream. Try another provider or check back later.',
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
    const providers = await streamingService.resolveAllProviders(animeTitle, episodeNumber, {
      isPremium,
    });

    res.json({
      success: true,
      providers,
    });
  } catch (err) {
    console.error('[StreamController] listProviders error:', err.message);
    res.status(502).json({
      success: false,
      error: err.message,
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

    res.json({
      success: true,
      authorized: true,
      streamUrl: result.streamUrl,
      quality: result.bestQuality,
      provider: result.provider,
      animeTitle,
      episodeNumber,
    });
  } catch (err) {
    console.error('[StreamController] authorizeDownload error:', err.message);
    res.status(502).json({ error: err.message });
  }
};

