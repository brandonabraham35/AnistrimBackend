// ============================================================
//  services/animeHeavenImportService.js — AnimeHeaven Importer
//
//  PURPOSE:
//    AnimeHeaven is the PRIMARY metadata + stream provider. This
//    service imports an AnimeHeaven anime into the local catalogue,
//    persisting:
//      • anime.animeheaven_slug          — the anime.php?<id>
//      • episodes.animeheaven_episode_key — the gate key
//    so playback can resolve an episode WITHOUT re-running search.
//
//  DO NOT rely on Kitsu or Consumet IDs — AnimeHeaven is the source
//  of truth for anything imported through this service.
// ============================================================
'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');
const { provider: animeHeavenProvider } = require('./animeHeavenProvider');

// ── Helpers ─────────────────────────────────────────────────

/**
 * Best-effort HTTP-safe image URL. Returns null if empty.
 */
function cleanImage(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value;
}

/**
 * Normalize an AnimeHeaven status string to the DB enum.
 */
function normalizeStatus(value) {
  const text = String(value || '').toLowerCase();
  if (/ongoing|airing|releasing/i.test(text)) return 'airing';
  if (/upcoming|not yet|tba/i.test(text)) return 'upcoming';
  return 'completed';
}

/**
 * Normalize rating to a DECIMAL(3,2) safe number.
 */
function normalizeRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, Number(n.toFixed(2)));
}

/**
 * Normalize year to a smallint.
 */
function normalizeYear(value) {
  const n = Number(String(value || '').match(/\d{4}/)?.[0] || value);
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return null;
  return n;
}

/**
 * Normalize a list of genres / studios into a clean array.
 */
function toArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return [];
}

// ── Search ──────────────────────────────────────────────────

/**
 * Search AnimeHeaven for an anime by title.
 * @param {string} title
 * @returns {Promise<Array>} array of { id, identifier, slug, title, image, cover, url, provider }
 */
async function searchAnime(title) {
  const q = String(title || '').trim();
  if (!q) return [];
  try {
    const rows = await animeHeavenProvider.searchAnime(q, 10);
    return (Array.isArray(rows) ? rows : []).map(r => ({
      id: r.identifier || r.id || null,
      identifier: r.identifier || r.id || null,
      slug: r.slug || r.identifier || r.id || null,
      title: r.title || q,
      image: cleanImage(r.image || r.cover),
      cover: cleanImage(r.cover || r.image),
      url: r.url || null,
      provider: 'animeheaven',
    }));
  } catch (err) {
    logger.warn('[AnimeHeavenImport] searchAnime failed', { title: q, error: err.message });
    return [];
  }
}

// ── Get Anime Metadata ──────────────────────────────────────

/**
 * Fetch full AnimeHeaven anime metadata (including episodes).
 * @param {string} identifier — the anime.php?<id> value
 * @returns {Promise<object|null>} normalized metadata
 */
async function getAnime(identifier) {
  if (!identifier) return null;
  try {
    const details = await animeHeavenProvider.getAnimeDetails(identifier);
    if (!details || (!details.title && (!details.episodes || !details.episodes.length))) return null;

    const episodes = (Array.isArray(details.episodes) ? details.episodes : []).map(ep => ({
      id: ep.key || ep.id || ep.identifier || null,
      identifier: ep.key || ep.id || ep.identifier || null,
      key: ep.key || ep.id || ep.identifier || null,
      number: Number(ep.number) || 0,
      title: ep.title || `Episode ${Number(ep.number) || 0}`,
      isSpecial: !!ep.isSpecial,
      url: ep.url || null,
    }));

    return {
      animeheaven_slug: details.identifier || details.slug || details.id || identifier,
      title: details.title || details.identifier || identifier,
      description: details.description || details.synopsis || null,
      cover_image: cleanImage(details.cover || details.image),
      banner_image: cleanImage(details.banner || details.cover || details.image),
      rating: normalizeRating(details.rating),
      year: normalizeYear(details.releaseYear || details.year),
      status: normalizeStatus(details.status),
      media_type: String(details.type || 'TV').toUpperCase() === 'MOVIE' ? 'MOVIE' : 'TV',
      genres: toArray(details.genres),
      studios: details.studios ? toArray(details.studios) : [],
      episodes,
    };
  } catch (err) {
    logger.warn('[AnimeHeavenImport] getAnime failed', { identifier, error: err.message });
    return null;
  }
}

// ── Get Episodes ────────────────────────────────────────────

/**
 * Fetch the episode list for an AnimeHeaven identifier.
 * @param {string} identifier
 * @returns {Promise<Array>} normalized episodes
 */
async function getEpisodes(identifier) {
  try {
    const details = await animeHeavenProvider.getAnimeDetails(identifier);
    if (!details || !Array.isArray(details.episodes)) return [];
    return details.episodes.map(ep => ({
      key: ep.key || ep.id || ep.identifier || null,
      number: Number(ep.number) || 0,
      title: ep.title || `Episode ${Number(ep.number) || 0}`,
      isSpecial: !!ep.isSpecial,
      url: ep.url || null,
    }));
  } catch (err) {
    logger.warn('[AnimeHeavenImport] getEpisodes failed', { identifier, error: err.message });
    return [];
  }
}

// ── DB Persistence ──────────────────────────────────────────

/**
 * Upsert an AnimeHeaven anime into the local `anime` table.
 * Returns the anime row (with id).
 * @param {object} meta — normalized metadata from getAnime()
 */
async function upsertAnime(meta) {
  if (!meta || !meta.animeheaven_slug) throw new Error('Missing animeheaven_slug for import.');

  // Lookup by animeheaven_slug first.
  let [existing] = await db.query(
    'SELECT * FROM anime WHERE animeheaven_slug = ? LIMIT 1',
    [meta.animeheaven_slug]
  );

  const studio = Array.isArray(meta.studios) && meta.studios.length ? meta.studios[0] : null;

  if (existing.length) {
    const id = existing[0].id;
    await db.query(
      `UPDATE anime SET
         title = ?, description = COALESCE(?, description),
         cover_image = COALESCE(?, cover_image),
         banner_image = COALESCE(?, banner_image),
         rating = ?, year = COALESCE(?, year),
         status = ?, media_type = ?,
         studio = COALESCE(?, studio),
         animeheaven_slug = ?,
         source_provider = 'animeheaven',
         source_id = ?,
         source_slug = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [
        meta.title,
        meta.description || null,
        meta.cover_image,
        meta.banner_image,
        meta.rating,
        meta.year,
        meta.status,
        meta.media_type || 'TV',
        studio,
        meta.animeheaven_slug,
        meta.animeheaven_slug,
        meta.animeheaven_slug,
        id,
      ]
    );
    const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [id]);
    return rows[0];
  }

  // Fallback lookup by title (so re-importing an existing title updates it).
  if (!existing.length) {
    [existing] = await db.query(
      'SELECT * FROM anime WHERE title = ? LIMIT 1',
      [meta.title]
    );
  }

  if (existing.length) {
    const id = existing[0].id;
    await db.query(
      `UPDATE anime SET
         animeheaven_slug = ?, source_provider = 'animeheaven',
         source_id = ?, source_slug = ?, updated_at = NOW()
       WHERE id = ?`,
      [meta.animeheaven_slug, meta.animeheaven_slug, meta.animeheaven_slug, id]
    );
    const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [id]);
    return rows[0];
  }

  // Insert new.
  const [result] = await db.query(
    `INSERT INTO anime
       (title, description, cover_image, banner_image, rating, year, studio,
        status, media_type, is_premium, is_featured, animeheaven_slug,
        source_provider, source_id, source_slug)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'animeheaven', ?, ?)`,
    [
      meta.title,
      meta.description || null,
      meta.cover_image,
      meta.banner_image,
      meta.rating,
      meta.year,
      studio,
      meta.status,
      meta.media_type || 'TV',
      meta.animeheaven_slug,
      meta.animeheaven_slug,
      meta.animeheaven_slug,
    ]
  );
  const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [result.insertId]);
  return rows[0];
}

/**
 * Replace genres for an anime (idempotent).
 */
async function replaceGenres(animeId, genres) {
  if (!animeId) return;
  const names = toArray(genres);
  if (!names.length) return;
  await db.query('DELETE FROM anime_genres WHERE anime_id = ?', [animeId]);
  for (const name of names) {
    await db.query('INSERT IGNORE INTO genres (name) VALUES (?)', [name]);
    const [g] = await db.query('SELECT id FROM genres WHERE name = ? LIMIT 1', [name]);
    if (g[0]) await db.query('INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES (?, ?)', [animeId, g[0].id]);
  }
}

/**
 * Upsert episodes for an anime, keyed by animeheaven_episode_key (and episode_number).
 * Never duplicates. Returns { inserted, updated, total }.
 */
async function upsertEpisodes(animeId, episodes) {
  let inserted = 0;
  let updated = 0;

  for (const ep of episodes) {
    const number = Number(ep.number) || 0;
    if (!number) continue;

    // Prefer matching by animeheaven_episode_key.
    let [existing] = await db.query(
      'SELECT id FROM episodes WHERE anime_id = ? AND animeheaven_episode_key = ? LIMIT 1',
      [animeId, ep.key || null]
    );

    if (!existing.length) {
      // Fallback: match by anime_id + episode_number.
      [existing] = await db.query(
        'SELECT id FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
        [animeId, number]
      );
    }

    if (existing.length) {
      const id = existing[0].id;
      // NOTE: The `episodes` table has NO `updated_at` column (only `created_at`),
      // so we must NOT reference `updated_at` here — that caused
      // "Unknown column 'updated_at' in 'field list'".
      await db.query(
        `UPDATE episodes SET
           title = COALESCE(?, title),
           animeheaven_episode_key = COALESCE(?, animeheaven_episode_key),
           animeheaven_episode_url = COALESCE(?, animeheaven_episode_url)
         WHERE id = ?`,
        [ep.title || null, ep.key || null, ep.url || null, id]
      );
      updated += 1;
    } else {
      await db.query(
        `INSERT INTO episodes (anime_id, episode_number, title, animeheaven_episode_key, animeheaven_episode_url)
         VALUES (?, ?, ?, ?, ?)`,
        [animeId, number, ep.title || `Episode ${number}`, ep.key || null, ep.url || null]
      );
      inserted += 1;
    }
  }

  return { inserted, updated, total: episodes.length };
}

/**
 * Record a sync/import activity in the anime record (last_sync_at column is
 * not in base schema, so we store in a lightweight best-effort way).
 * We use the anime table's updated_at as a proxy and log to admin_logs.
 */
async function recordImport(adminId, animeId, slug, episodeCount, inserted, updated) {
  try {
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail)
       VALUES (?, ?, 'anime', ?, ?)`,
      [adminId || 0, 'animeheaven_import', animeId, JSON.stringify({ slug, episodeCount, inserted, updated })]
    );
  } catch (err) {
    logger.warn('[AnimeHeavenImport] recordImport failed', { error: err.message });
  }
}

// ── Main Import ─────────────────────────────────────────────

/**
 * Import (or re-import) an AnimeHeaven anime by identifier.
 *
 * @param {string} identifier — AnimeHeaven anime.php?<id>
 * @param {object} [options]
 * @param {number} [options.adminId] — recording admin id
 * @returns {Promise<object>} { anime, episodes: { inserted, updated, total }, slug }
 */
async function importAnime(identifier, options = {}) {
  const adminId = Number(options.adminId) || 0;

  const meta = await getAnime(identifier);
  if (!meta) throw new Error('AnimeHeaven returned no metadata for identifier.');

  const anime = await upsertAnime(meta);
  await replaceGenres(anime.id, meta.genres);

  const result = await upsertEpisodes(anime.id, meta.episodes);
  await recordImport(adminId, anime.id, meta.animeheaven_slug, result.total, result.inserted, result.updated);

  // Invalidate catalogue caches (best-effort).
  try {
    const cache = require('../utils/cacheService');
    await cache.delByPrefix('catalogue:');
    await cache.delByPrefix(`catalogue:anime:${anime.id}`);
    await cache.delByPrefix(`catalogue:episodes:${anime.id}`);
  } catch (_) {}

  return {
    anime: { ...anime, animeheaven_slug: meta.animeheaven_slug, genres: meta.genres },
    slug: meta.animeheaven_slug,
    episodes: result,
  };
}

// ── Sync (refresh episodes without duplicating) ─────────────

/**
 * Refresh an AnimeHeaven anime's episode list + metadata from the
 * provider, WITHOUT duplicating episodes.
 *
 * @param {string|number} animeId — local DB anime id
 * @param {object} [options]
 * @param {number} [options.adminId]
 * @returns {Promise<object>} { anime, episodes: { inserted, updated, total } }
 */
async function syncAnime(animeId, options = {}) {
  const adminId = Number(options.adminId) || 0;
  const id = Number(animeId);
  if (!Number.isInteger(id)) throw new Error('Invalid anime id.');

  const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Anime not found.');

  const slug = rows[0].animeheaven_slug || rows[0].source_slug || rows[0].source_id;
  if (!slug) throw new Error('This anime has no AnimeHeaven slug. Import it via AnimeHeaven first.');

  const meta = await getAnime(slug);
  if (!meta) throw new Error('AnimeHeaven returned no metadata for this slug.');

  // Update metadata (keep animeheaven_slug).
  const updatedAnime = await upsertAnime({ ...meta, animeheaven_slug: slug });
  await replaceGenres(updatedAnime.id, meta.genres);

  const result = await upsertEpisodes(updatedAnime.id, meta.episodes);
  await recordImport(adminId, updatedAnime.id, slug, result.total, result.inserted, result.updated);

  // Invalidate catalogue caches.
  try {
    const cache = require('../utils/cacheService');
    await cache.delByPrefix('catalogue:');
    await cache.delByPrefix(`catalogue:anime:${updatedAnime.id}`);
    await cache.delByPrefix(`catalogue:episodes:${updatedAnime.id}`);
    await cache.delByPrefix(`catalogue:stream:${updatedAnime.id}`);
  } catch (_) {}

  return { anime: updatedAnime, episodes: result };
}

// ── Lookup for playback ─────────────────────────────────────

/**
 * Resolve the AnimeHeaven slug + episode key + episode URL for a
 * (title, episodeNumber) pair directly from the DB — NO AnimeHeaven search.
 *
 * @param {string} title
 * @param {number|string} episodeNumber
 * @returns {Promise<{ animeId: number|null, slug: string|null, episodeKey: string|null, episodeUrl: string|null, episodeId: number|null }>}
 */
async function resolvePlaybackIdentifiers(title, episodeNumber) {
  const out = { animeId: null, slug: null, episodeKey: null, episodeUrl: null, episodeId: null };
  if (!title || episodeNumber === undefined || episodeNumber === null || episodeNumber === '') return out;

  try {
    const [animeRows] = await db.query(
      'SELECT id, animeheaven_slug FROM anime WHERE title = ? OR title_japanese = ? LIMIT 1',
      [title, title]
    );
    if (!animeRows.length) return out;
    out.animeId = animeRows[0].id;
    out.slug = animeRows[0].animeheaven_slug || null;

    const [epRows] = await db.query(
      'SELECT id, animeheaven_episode_key, animeheaven_episode_url FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
      [animeRows[0].id, episodeNumber]
    );
    if (epRows.length) {
      out.episodeId = epRows[0].id;
      out.episodeKey = epRows[0].animeheaven_episode_key || null;
      out.episodeUrl = epRows[0].animeheaven_episode_url || null;
    }
  } catch (err) {
    logger.warn('[AnimeHeavenImport] resolvePlaybackIdentifiers failed', { title, episode: episodeNumber, error: err.message });
  }
  return out;
}

// ── Export ──────────────────────────────────────────────────

module.exports = {
  searchAnime,
  getAnime,
  getEpisodes,
  importAnime,
  syncAnime,
  resolvePlaybackIdentifiers,
  // Internal helpers exposed for tests.
  normalizeStatus,
  normalizeRating,
  normalizeYear,
  cleanImage,
};