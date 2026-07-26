// ============================================================
//  controllers/streamController.js — Multi-API Stream Endpoints
//  Provides:
//    1. GET /api/stream/:animeTitle/:episodeNumber
//       → Auto-fallback best stream for user's tier
//    2. GET /api/stream/providers/:animeTitle/:episodeNumber
//       → List all providers for the "Switch Server" dropdown
// ============================================================
const db = require('../config/db');
const streamingService = require('../services/streamingService');

/**
 * GET /api/stream/:animeTitle/:episodeNumber
 * Resolves the best stream using priority-ordered providers.
 * Enforces quality tier: free ≤720p, premium up to 4K.
 *
 * Query params:
 *   preferredProvider — optional, forces a specific provider
 *
 * Response:
 *   { provider, streamUrl, sources, subtitles, bestQuality, tier }
 */
exports.getStream = async (req, res) => {
  const { animeTitle, episodeNumber } = req.params;
  const { preferredProvider } = req.query;

  if (!animeTitle || !episodeNumber) {
    return res.status(400).json({ error: 'animeTitle and episodeNumber are required.' });
  }

  // Determine user's premium status (from auth middleware or optional token)
  const isPremium = req.user?.isPremium === true || req.user?.isAdmin === true;

  try {
    const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
      isPremium,
      preferredProvider: preferredProvider || undefined,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('[StreamController] getStream error:', err.message);
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
 *   { providers: [{ provider, streamUrl, bestQuality }] }
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
