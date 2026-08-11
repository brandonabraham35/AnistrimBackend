const axios = require('axios');
const db = require('../config/db');
const catalogue = require('../services/catalogueService');
const { ConsumetProvider } = require('../services/consumetProvider');
const { uploadBufferToCloudinary, hasCloudinaryConfig } = require('../utils/bunnyUpload');
const { PROVIDER_IDS } = require('../services/providerRegistry');
const animeHeavenImportService = require('../services/animeHeavenImportService');

const consumet = new ConsumetProvider();
let cloudinaryColumnsPromise = null;

async function ensureCloudinaryColumns() {
  if (!cloudinaryColumnsPromise) {
    cloudinaryColumnsPromise = (async () => {
      const [rows] = await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'anime'
          AND COLUMN_NAME IN ('cover_public_id', 'banner_public_id')`);
      const columns = new Set(rows.map(row => row.COLUMN_NAME));
      if (!columns.has('cover_public_id')) await db.query('ALTER TABLE anime ADD COLUMN cover_public_id VARCHAR(255) DEFAULT NULL');
      if (!columns.has('banner_public_id')) await db.query('ALTER TABLE anime ADD COLUMN banner_public_id VARCHAR(255) DEFAULT NULL');
    })().catch(error => {
      cloudinaryColumnsPromise = null;
      throw error;
    });
  }
  return cloudinaryColumnsPromise;
}

function importPayload(req) {
  const body = req.body || {};
  if (typeof body.providerData !== 'string') return body.providerData || body;
  try {
    let value = body.providerData.trim();
    // Decode a normal JSON string and, if needed, one accidental outer layer.
    let parsed = JSON.parse(value);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch (error) {
    const invalidPayload = new Error('Invalid JSON payload provided.');
    invalidPayload.status = 400;
    throw invalidPayload;
  }
}

const titleOf = value => typeof value === 'string'
  ? value
  : value?.english || value?.romaji || value?.userPreferred || value?.native || 'Untitled Anime';

async function persistRemoteImage(url, folder) {
  if (!url || !hasCloudinaryConfig()) return { url: url || null, publicId: null };
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const result = await uploadBufferToCloudinary({ buffer: Buffer.from(response.data) }, folder);
    return { url: result.secure_url, publicId: result.public_id };
  } catch (error) {
    // Metadata import remains useful when a provider image is temporarily down.
    console.warn('Cloudinary image copy failed; retaining provider URL:', error.message);
    return { url, publicId: null };
  }
}

function normaliseConsumetInfo(info, providerId) {
  const releaseDate = info.releaseDate || info.year || null;
  const statusMap = { RELEASING: 'airing', FINISHED: 'completed', NOT_YET_RELEASED: 'upcoming' };
  // Map Consumet format to media_type: AniList returns "TV", "MOVIE", "OVA", "ONA", "SPECIAL"
  const formatMap = {
    TV: 'TV',
    MOVIE: 'MOVIE',
    OVA: 'OVA',
    ONA: 'OVA',
    SPECIAL: 'SPECIAL',
    MUSIC: 'SPECIAL',
  };
  return {
    providerId: String(providerId),
    title: titleOf(info.title),
    description: info.description || null,
    coverUrl: info.image || info.cover || info.poster || null,
    bannerUrl: info.cover || info.banner || info.image || null,
    year: Number(String(releaseDate || '').slice(0, 4)) || null,
    studio: Array.isArray(info.studios) ? info.studios[0] : (info.studio || null),
    status: statusMap[String(info.status || '').toUpperCase()] || String(info.status || 'completed').toLowerCase(),
    media_type: formatMap[String(info.type || info.format || '').toUpperCase()] || 'TV',
    genres: Array.isArray(info.genres) ? info.genres : [],
    episodes: Array.isArray(info.episodes) ? info.episodes : [],
  };
}

/**
 * Helper function to bulk-insert episodes into MySQL
 */
async function bulkInsertEpisodes(animeId, episodes) {
  if (!episodes || episodes.length === 0) return;

  const sql = `
    INSERT IGNORE INTO episodes (anime_id, episode_number, title)
    VALUES ?
  `;

  const values = episodes.map(ep => [
    animeId,
    ep.number,
    ep.title
  ]);

  await db.query(sql, [values]);
}

/**
 * Admin Import Anime & Bulk Episode Fetch Controller
 * Protected by router.use(protect, adminOnly) in routes/adminRoutes.js.
 */
exports.importAnime = async (req, res) => {
  let payload;
  try { payload = importPayload(req); } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
  const kitsuId = String(payload?.kitsuId || '').trim();
  if (!kitsuId) return res.status(400).json({ message: 'kitsuId is required.' });

  try {
    await ensureCloudinaryColumns();
    console.log(`[IMPORT START] Processing Kitsu ID: ${kitsuId}`);

    // Step 1: Import anime metadata from Kitsu + resolve MalSync slug
    const result = await catalogue.importFromKitsu(kitsuId);
    const animeId = result.anime.id;

    // Kitsu fallback imports are also media-owned by AniStrim: copy available
    // provider artwork into Cloudinary and update the same database record.
    const importedCover = await persistRemoteImage(result.anime.cover_image, 'anime');
    const importedBanner = await persistRemoteImage(result.anime.banner_image, 'banners');
    if (importedCover.publicId || importedBanner.publicId) {
      await db.query(
        'UPDATE anime SET cover_image = ?, banner_image = ?, cover_public_id = COALESCE(?, cover_public_id), banner_public_id = COALESCE(?, banner_public_id) WHERE id = ?',
        [importedCover.url, importedBanner.url, importedCover.publicId, importedBanner.publicId, animeId]
      );
      result.anime.cover_image = importedCover.url;
      result.anime.banner_image = importedBanner.url;
    }

    console.log(`[IMPORT CHECKPOINT 1] Anime ID ${animeId} resolved.`);

    // Step 2: Fetch episodes directly from the official Kitsu API (no Cloudflare, always works)
    console.log(`[IMPORT FETCH] Bypassing Consumet. Fetching episodes directly from Kitsu API...`);

    let allEpisodes = [];
    let nextUrl = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=0`;

    // Loop through Kitsu's paginated responses until all episodes are fetched
    while (nextUrl) {
      const kitsuResponse = await axios.get(nextUrl);

      if (!kitsuResponse.data || !kitsuResponse.data.data) {
        break;
      }

      // Map the current batch of episodes
      const episodesBatch = kitsuResponse.data.data.map(ep => ({
        number: ep.attributes.number,
        title: ep.attributes.titles?.en_jp || ep.attributes.canonicalTitle || `Episode ${ep.attributes.number}`,
        id: null // Kept null for dynamic stream resolving later
      }));

      allEpisodes = allEpisodes.concat(episodesBatch);

      // Check if Kitsu provided a URL for the next page of episodes
      nextUrl = kitsuResponse.data.links && kitsuResponse.data.links.next
        ? kitsuResponse.data.links.next
        : null;
    }

    if (allEpisodes.length === 0) {
      throw new Error('Kitsu returned no episodes for this anime.');
    }

    const episodes = allEpisodes;
    const episodesCount = episodes.length;
    console.log(`✅ [IMPORT SUCCESS] Fetched ${episodesCount} episodes safely from Kitsu API!`);

    // Step 3: Bulk Save Episodes to Database in a single query
    await bulkInsertEpisodes(animeId, episodes);
    console.log(`[IMPORT SUCCESS] Saved ${episodesCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${episodesCount} episodes via Kitsu API.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: episodesCount,
        total: episodesCount,
        source: PROVIDER_IDS.KITSU
      }
    });

  } catch (error) {
    console.error('[IMPORT ERROR]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete anime import.',
      error: error.message
    });
  }
};

/** Search Consumet from the server so no provider credentials or requests leak to the dashboard. */
exports.searchConsumet = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ message: 'A search query is required.' });
  try {
    const results = await consumet.searchAnime(query, 12);
    res.json(results.map(item => ({
      id: String(item.id),
      title: titleOf(item.title),
      year: item.releaseDate || item.year || null,
      episodes: item.totalEpisodes || item.episodes || null,
      description: item.description || '',
      cover_image: item.image || item.cover || null,
    })));
  } catch (error) {
    console.error('Consumet search failed:', error.message);
    res.status(502).json({ message: 'Consumet search is temporarily unavailable.' });
  }
};

/** Import Consumet metadata, persist provider art in Cloudinary, and seed episode records. */
exports.importConsumetAnime = async (req, res) => {
  let payload;
  try { payload = importPayload(req); } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
  const providerId = String(payload?.providerId || payload?.animeId || '').trim();
  if (!providerId) return res.status(400).json({ message: 'providerId is required.' });
  if (providerId.startsWith('kitsu:')) {
    // The Consumet search fallback returns a namespaced Kitsu identifier.
    // Reuse the established Kitsu importer for compatibility and episode seeding.
    req.body = { kitsuId: providerId.slice('kitsu:'.length) };
    return exports.importAnime(req, res);
  }
  try {
    await ensureCloudinaryColumns();
    const metadata = normaliseConsumetInfo(await consumet.fetchAnimeInfo(providerId), providerId);
    const [existing] = await db.query('SELECT id FROM anime WHERE source_provider = ? AND source_id = ? LIMIT 1', [PROVIDER_IDS.CONSUMET, providerId]);
    const cover = await persistRemoteImage(metadata.coverUrl, 'anime');
    const banner = await persistRemoteImage(metadata.bannerUrl, 'banners');
    let animeId = existing[0]?.id;
    if (animeId) {
      await db.query(`UPDATE anime SET title=?, description=?, cover_image=?, banner_image=?, year=?, studio=?, status=?, media_type=?, cover_public_id=COALESCE(?, cover_public_id), banner_public_id=COALESCE(?, banner_public_id) WHERE id=?`,
        [metadata.title, metadata.description, cover.url, banner.url, metadata.year, metadata.studio, metadata.status, metadata.media_type || 'TV', cover.publicId, banner.publicId, animeId]);
    } else {
      const [result] = await db.query(`INSERT INTO anime (title, description, cover_image, banner_image, cover_public_id, banner_public_id, year, studio, status, media_type, is_premium, is_featured, source_provider, source_id, source_slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [metadata.title, metadata.description, cover.url, banner.url, cover.publicId, banner.publicId, metadata.year, metadata.studio, metadata.status, metadata.media_type || 'TV', PROVIDER_IDS.CONSUMET, providerId, providerId]);
      animeId = result.insertId;
    }
    for (const rawName of metadata.genres) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      await db.query('INSERT IGNORE INTO genres (name) VALUES (?)', [name]);
      const [genre] = await db.query('SELECT id FROM genres WHERE name = ? LIMIT 1', [name]);
      if (genre[0]) await db.query('INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES (?, ?)', [animeId, genre[0].id]);
    }
    await bulkInsertEpisodes(animeId, metadata.episodes.map((episode, index) => ({ number: Number(episode.number) || index + 1, title: episode.title || `Episode ${index + 1}` })));
    const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [animeId]);
    res.status(existing.length ? 200 : 201).json({ success: true, anime: rows[0], episodesImported: metadata.episodes.length });
  } catch (error) {
    console.error('Consumet import failed:', error.message);
    res.status(502).json({ success: false, message: 'Unable to import anime from Consumet.' });
  }
};

exports.syncConsumetAnime = async (req, res) => {
  const [rows] = await db.query('SELECT source_id FROM anime WHERE id = ? LIMIT 1', [req.params.id]);
  if (!rows[0]?.source_id) return res.status(400).json({ message: 'This anime was not imported from Consumet.' });
  req.body = { providerId: rows[0].source_id };
  return exports.importConsumetAnime(req, res);
};

// ════════════════════════════════════════════════════════════
//  ANIMEHEAVEN IMPORT (Phase 6) — AnimeHeaven is the PRIMARY
//  metadata + stream provider. These endpoints let the admin
//  dashboard search, preview, and import AnimeHeaven anime.
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/animeheaven/search?q=...
 * Search AnimeHeaven for an anime by title.
 */
exports.searchAnimeHeaven = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ message: 'A search query is required.' });
  try {
    const results = await animeHeavenImportService.searchAnime(query);
    res.json(results);
  } catch (error) {
    console.error('AnimeHeaven search failed:', error.message);
    res.status(502).json({ message: 'AnimeHeaven search is temporarily unavailable.' });
  }
};

/**
 * GET /api/admin/animeheaven/preview/:identifier
 * Preview an AnimeHeaven anime (metadata + episode list) WITHOUT importing.
 */
exports.previewAnimeHeaven = async (req, res) => {
  const identifier = String(req.params.identifier || '').trim();
  if (!identifier) return res.status(400).json({ message: 'identifier is required.' });
  try {
    const meta = await animeHeavenImportService.getAnime(identifier);
    if (!meta) return res.status(404).json({ message: 'AnimeHeaven returned no metadata for this identifier.' });
    res.json({
      animeheaven_slug: meta.animeheaven_slug,
      title: meta.title,
      description: meta.description,
      cover_image: meta.cover_image,
      banner_image: meta.banner_image,
      rating: meta.rating,
      year: meta.year,
      status: meta.status,
      media_type: meta.media_type,
      genres: meta.genres,
      episodeCount: meta.episodes.length,
      episodes: meta.episodes,
    });
  } catch (error) {
    console.error('AnimeHeaven preview failed:', error.message);
    res.status(502).json({ message: 'AnimeHeaven preview failed.' });
  }
};

/**
 * POST /api/admin/animeheaven/import
 * Body: { identifier }
 * Import an AnimeHeaven anime (metadata + episodes) into the local DB.
 * Stores animeheaven_slug + animeheaven_episode_key.
 */
exports.importAnimeHeaven = async (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.slug || '').trim();
  if (!identifier) return res.status(400).json({ message: 'identifier is required.' });
  try {
    const result = await animeHeavenImportService.importAnime(identifier, { adminId: req.user?.id });
    res.status(201).json({
      success: true,
      message: `Imported "${result.anime.title}" with ${result.episodes.total} episodes from AnimeHeaven.`,
      anime: result.anime,
      slug: result.slug,
      episodes: result.episodes,
    });
  } catch (error) {
    console.error('AnimeHeaven import failed:', error.message);
    res.status(502).json({ success: false, message: 'AnimeHeaven import failed.', error: error.message });
  }
};

/**
 * POST /api/admin/animeheaven/sync/:animeId
 * Sync (refresh) an AnimeHeaven anime's episodes + metadata WITHOUT duplicating.
 */
exports.syncAnimeHeaven = async (req, res) => {
  const animeId = Number(req.params.animeId);
  if (!Number.isInteger(animeId)) return res.status(400).json({ message: 'Invalid anime id.' });
  try {
    const result = await animeHeavenImportService.syncAnime(animeId, { adminId: req.user?.id });
    res.json({
      success: true,
      message: `Synced "${result.anime.title}" — ${result.episodes.inserted} inserted, ${result.episodes.updated} updated.`,
      anime: result.anime,
      episodes: result.episodes,
    });
  } catch (error) {
    console.error('AnimeHeaven sync failed:', error.message);
    res.status(502).json({ success: false, message: 'AnimeHeaven sync failed.', error: error.message });
  }
};

/**
 * GET /api/admin/animeheaven/status/:animeId
 * Return the AnimeHeaven import status for an anime (slug, episode count, last sync).
 */
exports.getAnimeHeavenStatus = async (req, res) => {
  const animeId = Number(req.params.animeId);
  if (!Number.isInteger(animeId)) return res.status(400).json({ message: 'Invalid anime id.' });
  try {
    const [animeRows] = await db.query(
      'SELECT id, title, animeheaven_slug, source_provider, source_id, updated_at FROM anime WHERE id = ? LIMIT 1',
      [animeId]
    );
    if (!animeRows.length) return res.status(404).json({ message: 'Anime not found.' });
    const anime = animeRows[0];
    const [epRows] = await db.query(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN animeheaven_episode_key IS NOT NULL THEN 1 ELSE 0 END) AS with_keys FROM episodes WHERE anime_id = ?',
      [animeId]
    );
    res.json({
      animeId: anime.id,
      title: anime.title,
      animeheavenSlug: anime.animeheaven_slug || null,
      sourceProvider: anime.source_provider || null,
      sourceId: anime.source_id || null,
      episodeCount: Number(epRows[0]?.total || 0),
      episodesWithKeys: Number(epRows[0]?.with_keys || 0),
      lastSync: anime.updated_at || null,
      importStatus: anime.animeheaven_slug ? 'imported' : 'not_imported',
    });
  } catch (error) {
    console.error('AnimeHeaven status failed:', error.message);
    res.status(500).json({ message: 'Failed to fetch AnimeHeaven status.' });
  }
};
