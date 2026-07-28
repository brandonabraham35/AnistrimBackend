const catalogue = require('../services/catalogueService');
const cache = require('../utils/cacheService');
const { KitsuProvider } = require('../services/kitsuProvider');
const { ConsumetProvider } = require('../services/consumetProvider');
const kitsu = new KitsuProvider();
const consumet = new ConsumetProvider();

// ── In-memory cache for trending/popular (5 min TTL) ──────
// Used as a fallback when external API returns 429 (rate limited)
// or as a primary fast-path when cache is fresh.
const memoryCache = {
  trending: { data: null, timestamp: 0 },
  popular:  { data: null, timestamp: 0 },
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if in-memory cache is still fresh.
 */
function isCacheFresh(cacheEntry) {
  return cacheEntry.data !== null && (Date.now() - cacheEntry.timestamp) < CACHE_TTL_MS;
}

exports.search = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ message: 'A search query is required.' });
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cacheKey = `provider:kitsu:search:${query.toLowerCase()}:${limit}`;
    let results = await cache.get(cacheKey);
    if (!results) {
      results = await kitsu.searchAnime(query, limit);
      results = results.map(item => ({ ...item, id: item.kitsu_id }));
      await cache.set(cacheKey, results, 24 * 60 * 60);
    }
    res.json(results);
  }
  catch (error) { console.error('Catalogue search failed:', error.message); res.status(502).json({ message: 'Catalogue search is temporarily unavailable.' }); }
};

/**
 * GET /api/anime/search/advanced
 * Advanced search & filtering using the Consumet Anilist provider.
 *
 * Query parameters:
 *   query   - search text (optional)
 *   page    - page number (default: 1)
 *   perPage - results per page (default: 15)
 *   genres  - comma-separated genre list (e.g. "Action,Drama")
 *   season  - "WINTER", "SPRING", "SUMMER", "FALL"
 *   year    - release year
 *   status  - "RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED"
 *   sort    - comma-separated sort options (e.g. "SCORE_DESC,POPULARITY_DESC")
 */
exports.advancedSearch = async (req, res) => {
  try {
    const { query, page, perPage, genres, season, year, status, sort } = req.query;

    // Parse genres from comma-separated string into an array
    let genresArray;
    if (genres) {
      genresArray = genres.split(',').map(g => g.trim()).filter(Boolean);
    }

    // Parse sort from comma-separated string into an array
    let sortArray;
    if (sort) {
      sortArray = sort.split(',').map(s => s.trim()).filter(Boolean);
    }

    const result = await consumet.advancedSearch({
      query: query || undefined,
      page: page ? parseInt(page, 10) : 1,
      perPage: perPage ? parseInt(perPage, 10) : 15,
      genres: genresArray,
      season: season || undefined,
      year: year ? parseInt(year, 10) : undefined,
      status: status || undefined,
      sort: sortArray,
    });

    res.json(result);
  } catch (error) {
    console.error('[CatalogueController] advancedSearch error:', error.message);
    res.status(502).json({ message: 'Advanced search is temporarily unavailable.', error: error.message });
  }
};

/**
 * GET /api/anime/trending
 * Fetches trending anime from the Consumet Anilist provider (TRENDING_DESC sort).
 * Uses a two-tier cache: Redis (if available) → in-memory → API.
 * On 429 rate limit, gracefully returns stale cache or fallback data.
 * Query params: page (default 1), perPage (default 15)
 */
exports.getTrendingAnime = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 15;
    const cacheKey = `trending:${page}:${perPage}`;

    // 1. Try Redis-backed cache first (5 min TTL)
    const cachedResult = await cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 2. Check in-memory cache (also acts as stale fallback)
    if (isCacheFresh(memoryCache.trending)) {
      return res.json(memoryCache.trending.data);
    }

    // 3. Fetch from external API
    const result = await consumet.fetchTrendingAnime(page, perPage);

    // 4. Populate both caches
    await cache.set(cacheKey, result, 5 * 60); // Redis: 5 min
    memoryCache.trending = { data: result, timestamp: Date.now() };

    res.json(result);
  } catch (error) {
    // Graceful handling for 429 (rate limit) or any network error
    console.warn(`[CatalogueController] getTrendingAnime error: ${error.message}`);

    // Return stale in-memory cache if available (even if expired)
    if (memoryCache.trending.data) {
      console.log('[CatalogueController] Returning stale trending cache due to upstream error');
      return res.json(memoryCache.trending.data);
    }

    res.status(502).json({
      message: 'Trending anime is temporarily unavailable.',
      error: error.message,
    });
  }
};

/**
 * GET /api/anime/popular
 * Fetches popular anime from the Consumet Anilist provider (POPULARITY_DESC sort).
 * Uses a two-tier cache: Redis (if available) → in-memory → API.
 * On 429 rate limit, gracefully returns stale cache or fallback data.
 * Query params: page (default 1), perPage (default 15)
 */
exports.getPopularAnime = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 15;
    const cacheKey = `popular:${page}:${perPage}`;

    // 1. Try Redis-backed cache first (5 min TTL)
    const cachedResult = await cache.get(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 2. Check in-memory cache (also acts as stale fallback)
    if (isCacheFresh(memoryCache.popular)) {
      return res.json(memoryCache.popular.data);
    }

    // 3. Fetch from external API
    const result = await consumet.fetchPopularAnime(page, perPage);

    // 4. Populate both caches
    await cache.set(cacheKey, result, 5 * 60); // Redis: 5 min
    memoryCache.popular = { data: result, timestamp: Date.now() };

    res.json(result);
  } catch (error) {
    // Graceful handling for 429 (rate limit) or any network error
    console.warn(`[CatalogueController] getPopularAnime error: ${error.message}`);

    // Return stale in-memory cache if available (even if expired)
    if (memoryCache.popular.data) {
      console.log('[CatalogueController] Returning stale popular cache due to upstream error');
      return res.json(memoryCache.popular.data);
    }

    res.status(502).json({
      message: 'Popular anime is temporarily unavailable.',
      error: error.message,
    });
  }
};

exports.getEpisodes = async (req, res) => { try { res.json(await catalogue.getEpisodes(Number(req.params.id))); } catch (error) { console.error('Episode lookup failed:', error.message); res.status(502).json({ message: 'Episodes are temporarily unavailable.' }); } };
exports.getStream = async (req, res) => { try { const stream = await catalogue.getStream(Number(req.params.id), req.params.episode); if (!stream?.video_url) return res.status(404).json({ message: 'No stream is currently available for this episode.' }); res.json(stream); } catch (error) { console.error('Stream lookup failed:', error.message); res.status(502).json({ message: 'Streaming source is temporarily unavailable.' }); } };
