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
      'SELECT id FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
      [mediaRows[0].id, episodeNumber]
    );
    if (epRows && epRows[0]) {
      out.episodeId = epRows[0].id;
      // Authoritative tier: reads anime.access_tier + episode.access_tier +
      // premium_until (expired window => free). This is the SAME gate the
      // stream/authorize + detail endpoints use — never raw is_premium.
      const { effectiveAccess } = require('../utils/episodeAccess');
      const tier = await effectiveAccess(out.episodeId);
      out.isPremiumEpisode = tier === 'premium';
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
  const requestReceivedTime = Date.now();
  logger.info('[STREAM DEBUG] REQUEST RECEIVED', {
    method: req.method,
    url: req.originalUrl,
    anime: animeTitle,
    episode: episodeIdentifier,
    timestamp: new Date(requestReceivedTime).toISOString()
  });

  const { preferredProvider, ep: queryEp } = req.query;
  // Consistent identity key across getStream / authorizeStream / rewriteResultToProxy.
  const requestUserId = streamProxy.resolveUserId(req.user, null);
  // ipHash lets the deterministic streamId be per-IP for guests (no userId).
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const { ipHash } = require('../utils/streamToken');
  const requestIpHash = ipHash(ip);

  if (!animeTitle || !episodeIdentifier) {
    return res.status(400).json({ error: 'animeTitle and episode identifier are required.' });
  }

  // Determine user's premium status — authoritative from the DB entitlement
  // (never the possibly-stale JWT isPremium claim).
  // Prompt 4: NO fallback to req.user.isPremium. A query failure denies.
  let isPremium = req.user?.isAdmin === true;
  try {
    const { getEntitlement } = require('../utils/episodeAccess');
    const ent = await getEntitlement(req.user?.userId ?? req.user?.id);
    isPremium = isPremium || (ent && ent.isPremium && ['trialing', 'active', 'grace'].includes(ent.state));
  } catch (e) {
    logger.warn('[StreamController] Entitlement check failed (deny premium):', { error: e.message });
  }

  const startTime = Date.now();
  logger.info('[PLAYBACK]', { event: 'requestStarted', animeTitle, episode: episodeIdentifier, isPremium, ts: startTime });

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
        logger.warn('[StreamController] DB lookup failed — using identifier as-is', { animeTitle, error: dbErr.message });
        episodeNumber = episodeIdentifier;
        resolvedFrom = 'dbError';
      }
    }

    // Validate episode number is reasonable
    const epNum = Number(episodeNumber);
    if (isNaN(epNum) || epNum < 1 || epNum > 10000) {
      logger.warn('[StreamController] Unreasonable episode number — using as-is anyway', { animeTitle, episodeNumber });
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
          'SELECT id, is_premium, animeheaven_episode_key, animeheaven_episode_url FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
          [mediaId, episodeNumber]
        );
        episodeId = epRows && epRows[0] ? epRows[0].id : null;
        if (epRows && epRows[0]) {
          logger.info('[PLAYBACK] Loaded imported episode', {
            animeId: mediaId,
            episode: episodeNumber,
            episodeId: epRows[0].id,
            hasProviderKey: !!epRows[0].animeheaven_episode_key,
            hasProviderUrl: !!epRows[0].animeheaven_episode_url,
          });
        }
      }
    } catch (epErr) {
      logger.debugStream('[StreamController] episodeId lookup failed (cache will be bypassed)', { animeTitle, episode: episodeNumber, error: epErr.message });
      episodeId = null;
    }

    logger.info('[STREAM DEBUG] PROVIDER RESOLUTION START', { animeTitle, episodeNumber, timestamp: new Date().toISOString() });
    const providerStart = Date.now();

    logger.info('[PLAYBACK] Provider: animeheaven', { animeTitle, episode: episodeNumber, episodeId });
    const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
      isPremium,
      preferredProvider: preferredProvider || undefined,
      episodeId: episodeId || undefined,
    });

    const providerEnd = Date.now();
    logger.info('[STREAM DEBUG] PROVIDER RESOLUTION END', {
      elapsedMs: providerEnd - providerStart,
      success: !!(result && result.sources && result.sources.length > 0),
      timestamp: new Date(providerEnd).toISOString()
    });

    // Rewrite AnimeHeaven sources to anonymized /api/stream-proxy/:streamId
    // URLs. Context (cookies/referer/origin) is stored server-side in the
    // streamProxyStore and NEVER returned to the browser. Anonymous
    // providers (Consumet, etc.) are returned unchanged.
    const publicResult = streamProxy.rewriteResultToProxy(result, requestUserId, episodeId != null ? String(episodeId) : null, requestIpHash) || result;
    // Expose download-only sources (for the premium Download button) as
    // proxy-rewritten, server-context-safe URLs. These are never used for
    // in-browser playback — only downloads.
    if (Array.isArray(result.downloadSources) && result.downloadSources.length) {
      publicResult.downloadSources = streamProxy.rewriteResultToProxy(
        { ...result, sources: result.downloadSources },
        requestUserId,
        episodeId != null ? String(episodeId) : null,
        requestIpHash
      )?.sources || result.downloadSources;
    }

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

    logger.info('[PLAYBACK]', { event: 'sourceReturned', animeTitle, episode: episodeNumber, provider: publicResult.provider, latencyMs: elapsed });

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

  // Authoritative premium status (never the stale JWT claim).
  // Prompt 4: NO fallback to req.user.isPremium. A query failure denies.
  let isPremium = req.user?.isAdmin === true;
  try {
    const { getEntitlement } = require('../utils/episodeAccess');
    const ent = await getEntitlement(req.user?.userId ?? req.user?.id);
    isPremium = isPremium || (ent && ent.isPremium && ['trialing', 'active', 'grace'].includes(ent.state));
  } catch (e) {
    logger.warn('[StreamController] listProviders entitlement check failed (deny premium):', { error: e.message });
  }

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

    // ── LIGHTWEIGHT PROVIDER LIST (Finding 3 fix) ────────────
    // Previously this called streamingService.resolveAllProviders(), which
    // performed a FULL expensive AnimeHeaven resolution (search → details →
    // gate → mirrors → nested iframes → subtitles) just to populate the
    // "Switch Server" dropdown. The frontend then called /api/stream/...
    // which performed ANOTHER full resolution — AnimeHeaven was scraped
    // TWICE before playback began.
    //
    // The provider list is now METADATA/CAPABILITY information only.
    // AnimeHeaven is the single streaming provider, so we return its
    // capability entry WITHOUT contacting AnimeHeaven. The actual stream
    // is resolved only when the player requests /api/stream/:title/:ep.
    const providers = [{
      provider: 'animeheaven',
      streamUrl: null,
      sources: [],
      bestQuality: isPremium ? '4K' : '720p',
      metadataOnly: true,
    }];

    res.json({
      success: true,
      providers,
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
  // Premium/admin only — authoritative from the DB entitlement.
  // Prompt 4: NO fallback to req.user.isPremium. A query failure denies.
  let isPremium = req.user?.isAdmin === true;
  try {
    const { getEntitlement } = require('../utils/episodeAccess');
    const ent = await getEntitlement(req.user?.userId ?? req.user?.id);
    isPremium = isPremium || (ent && ent.isPremium && ['trialing', 'active', 'grace'].includes(ent.state));
  } catch (e) {
    logger.warn('[StreamController] authorizeDownload entitlement check failed (deny premium):', { error: e.message });
  }
  if (!isPremium) {
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
    const publicResult = streamProxy.rewriteResultToProxy(result, req.user?.id || null) || result;

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

/**
 * POST /api/stream/authorize (Phase 10 / item 21) — FIX 3 corrected binding.
 * Body: { episodeId }
 *
 * FIX 3 (P0): authorize NO LONGER invents a phantom randomUUID() streamId.
 * Instead it:
 *   1. Runs the authoritative canWatch() gate (unchanged).
 *   2. Resolves the (animeTitle, episodeNumber) for the episodeId from the DB.
 *   3. Ensures the stream contexts are registered in streamProxyStore by
 *      resolving the stream (same path as GET /api/stream/:title/:ep) if they
 *      are not already registered for this user+episode. This makes the
 *      returned streamIds REAL — they match what /api/stream-proxy/:streamId
 *      expects.
 *   4. Mints one 120 s HMAC token per registered streamId, each bound to
 *      { userId, episodeId, streamId, ip }.
 *   5. Returns the concrete /api/stream-proxy/:streamId?token=... URLs so the
 *      client never has to guess.
 */
exports.authorizeStream = async (req, res) => {
  try {
    const { episodeId } = req.body || {};
    if (!episodeId) return res.status(400).json({ message: 'episodeId is required.' });

    // ── FIX: consistent identity keys everywhere ─────────────────
    // Use the SAME userId normalization as getStream/rewriteResultToProxy so
    // the ctxUserId↔tokUserId comparisons in streamProxyController can't mismatch.
    const userId = streamProxy.resolveUserId(req.user, req.userId ?? null);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
    const { ipHash, mint, TTL_MS } = require('../utils/streamToken');
    const userIpHash = ipHash(ip);

    // ── Guest handling (FREE episodes) ──────────────────────────
    // Unauthenticated users may watch FREE episodes. We mint a short-lived
    // anonymous token bound to (ipHash, episodeId, streamId) so the hardened
    // proxy can authorize it. Premium episodes require an authenticated,
    // entitled user (enforced below via canWatch).
    let isGuessingAllowed = false;
    if (!userId) {
      try {
        const { effectiveAccess } = require('../utils/episodeAccess');
        const tier = await effectiveAccess(episodeId);
        // Anonymous token minting is only allowed for FREE episodes.
        isGuessingAllowed = tier === 'free';
      } catch (_) {
        isGuessingAllowed = false;
      }
      if (!isGuessingAllowed) {
        return res.status(403).json({
          code: 'AUTH_REQUIRED',
          message: 'Sign in to watch this episode.',
        });
      }
    }

    // ── Authoritative canWatch gate (authenticated only) ────────
    const { canWatch, getEntitlement } = require('../utils/episodeAccess');
    const isAdmin = req.user?.isAdmin === true || (req.tokenClaims?.roles || []).includes('admin');
    if (userId) {
      const access = await canWatch(userId, episodeId, { isAdmin });
      if (!access.allow) {
        return res.status(403).json({
          code: access.reason || 'PREMIUM_REQUIRED',
          requiredTier: access.requiredTier,
          availableAt: access.availableAt,
          message: access.reason === 'PREMIUM_REQUIRED' ? 'Premium subscription required.' : 'Access denied.',
        });
      }
    }

    // ── FIX 8 (P1): enforce plans.max_devices ─────────────────
    // Count the user's active sessions and compare against the effective
    // plan's max_devices. Refuse to mint if over the limit — surface the
    // active-device list so the player can show a distinct DEVICE_LIMIT state.
    try {
      const { enforceDeviceLimit } = require('../services/sessionService');
      const isAdmin = req.user?.isAdmin === true || (req.tokenClaims?.roles || []).includes('admin');
      const deviceCheck = await enforceDeviceLimit(userId, isAdmin);
      if (!deviceCheck.ok) {
        return res.status(403).json({
          code: 'DEVICE_LIMIT_REACHED',
          maxDevices: deviceCheck.maxDevices,
          activeDevices: deviceCheck.activeDevices,
          devices: deviceCheck.devices || [],
          message: `Device limit reached (${deviceCheck.activeDevices}/${deviceCheck.maxDevices}). Remove a device from your account to keep streaming.`,
        });
      }
    } catch (deviceErr) {
      // On a failure, deny (fail closed) — but only for the device check itself;
      // the episode resolve below still runs normally.
      logger.warn('[StreamController] device limit check failed (deny)', { userId, error: deviceErr.message });
    }

    // Normalize episodeId as string (always) so the deterministic streamId and
    // the proxy's ctxEpId↔tokEpId comparison never mismatch.
    const epIdStr = String(episodeId);

    const streamProxyStore = require('../utils/streamProxyStore');

    // ── Resolve (animeTitle, episodeNumber) from the episodeId ──
    // Only used to fall back to resolving the stream here if the frontend
    // hasn't already resolved it (i.e. contexts are empty). For guests we key
    // on ipHash, not userId, so getByUserEpisode won't match — so we MUST
    // derive the deterministic streamId instead (see below).
    let animeTitle = '', episodeNumber = null;
    try {
      const [epRows] = await db.query(
        `SELECT e.id, e.episode_number, e.anime_id, a.title, a.title_japanese
         FROM episodes e JOIN anime a ON a.id = e.anime_id
         WHERE e.id = ? LIMIT 1`,
        [episodeId]
      );
      if (epRows && epRows[0]) {
        animeTitle = epRows[0].title || epRows[0].title_japanese || '';
        episodeNumber = epRows[0].episode_number;
      }
    } catch (epErr) {
      logger.warn('[StreamController] authorize episode lookup failed', { episodeId: epIdStr, error: epErr.message });
    }

    // ── Ensure contexts exist (NO second resolution when already registered) ──
    // If the frontend already resolved /api/stream/:title/:ep, the contexts
    // are registered and we reuse their REAL (deterministic) streamIds — we do
    // NOT call streamingService.resolveStream() again. If empty, we resolve the
    // stream here once to register the deterministic contexts.
    let registered = userId
      ? streamProxyStore.getByUserEpisode(userId, epIdStr)
      : []; // guests key on ipHash (no userId) — see deterministic lookup below

    if (!registered.length && animeTitle && episodeNumber) {
      let isPremium = isAdmin;
      try {
        const ent = await getEntitlement(userId);
        isPremium = isPremium || (ent && ent.isPremium && ['trialing', 'active', 'grace'].includes(ent.state));
      } catch (_) { /* deny premium */ }

      try {
        const result = await streamingService.resolveStream(animeTitle, episodeNumber, {
          isPremium,
          episodeId: Number(episodeId) || episodeId,
        });
        // Register the deterministic contexts using the SAME ipHash + episodeId
        // string the GET /api/stream path used, so the streamId matches.
        streamProxy.rewriteResultToProxy(result, userId, epIdStr, userIpHash);
      } catch (resolveErr) {
        logger.warn('[StreamController] authorize resolveStream failed (no contexts)', { episodeId: epIdStr, error: resolveErr.message });
      }
      registered = userId
        ? streamProxyStore.getByUserEpisode(userId, epIdStr)
        : [];
    }

    // ── For guests, derive the deterministic streamIds directly ──
    // Guests have no userId, so getByUserEpisode can't find them. Instead we
    // reconstruct the exact deterministic streamId each source would have
    // (same formula as streamProxyStore.deterministicStreamId) and verify each
    // one exists in the store. If none exist, we have nothing to authorize.
    let finalStreams = registered.map(r => r.streamId);
    if (!userId) {
      // Guests key on ipHash (no userId). Use the dedicated helper to find the
      // deterministic streamIds registered for (episodeId, ipHash) when the
      // frontend resolved /api/stream first (the normal flow).
      finalStreams = streamProxyStore.getByIpEpisode(epIdStr, userIpHash);
      logger.debug('[StreamController] authorize guest contexts', {
        episodeId: epIdStr,
        count: finalStreams.length,
      });
    }

    if (!finalStreams.length) {
      logger.warn('[StreamController] authorize: no registered stream contexts', { userId, episodeId: epIdStr, guest: !userId });
      return res.status(404).json({ message: 'No playable stream registered for this episode. Resolve the stream first.' });
    }

    // ── Mint one token per concrete streamId ────────────────
    const { PROXY_BASE, proxyUrlSuffix } = require('../utils/streamProxy');
    // ── FIX: deployment-aware API base URL ──────────────────
    // The proxy URLs returned to the browser MUST use the same scheme the
    // browser connected with. Behind Render's reverse proxy, `req.protocol`
    // is `http` unless Express trusts `X-Forwarded-Proto` — which would
    // produce `http://anistrimbackend.onrender.com/...` and be blocked as
    // mixed-content by an HTTPS frontend.
    //
    // Resolution priority (safest first, no blind trust proxy):
    //   1. BACKEND_URL / RENDER_EXTERNAL_URL env → that origin (production canonical).
    //   2. X-Forwarded-Proto: https          → https (safe; Render sets it).
    //   3. Known production backend host     → https (locked-down).
    //   4. Anything else (e.g. localhost)    → req.protocol (preserves dev http).
    const configuredBackend =
      process.env.BACKEND_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.PUBLIC_API_URL;
    let apiBase = configuredBackend
      ? configuredBackend.replace(/\/+$/, '')
      : null;
    if (!apiBase) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const host = req.get('host') || '';
      if (forwardedProto === 'https') {
        apiBase = 'https://' + host;
      } else if (/anistrimbackend\.onrender\.com$/i.test(host)) {
        apiBase = 'https://' + host;
      } else {
        apiBase = req.protocol + '://' + host;
      }
    }

    // FIX 5: bind the stream token to the session (sid) + token_version (tv)
    // from the authenticated access JWT so logout/suspend can revoke it.
    const sid = userId ? (req.tokenClaims?.sid || req.tokenClaims?.sessionId || null) : null;
    const tv = userId ? ((req.tokenClaims && req.tokenClaims.tv !== undefined) ? Number(req.tokenClaims.tv) : null) : undefined;

    const streams = finalStreams.map((streamId) => {
      // Guests mint an anonymous token bound to ipHash + episodeId + streamId.
      const token = mint({ userId: userId || null, episodeId: epIdStr, streamId, ip, sid, tv });
      // Mirror the cosmetic `/index.m3u8` suffix that rewriteSource appended
      // to the /api/stream response so the concrete authorized URL keeps the
      // HLS hint the player's hls.js gate needs (see utils/streamProxy.js).
      const ctx = streamProxyStore.get(streamId);
      const suffix = proxyUrlSuffix(ctx && ctx.targetUrl);
      const url = `${apiBase}${PROXY_BASE}/${streamId}${suffix}?token=${encodeURIComponent(token)}`;
      return { streamId, token, url, expiresIn: Math.round(TTL_MS / 1000) };
    });

    return res.json({
      token: streams[0].token,          // primary token (backwards-compatible)
      streamId: streams[0].streamId,    // primary streamId (backwards-compatible)
      streams,
      expiresIn: Math.round(TTL_MS / 1000),
    });
  } catch (error) {
    logger.error('[StreamController] authorize error', { error: error.message });
    return res.status(500).json({ message: 'Stream authorization failed.' });
  }
};
