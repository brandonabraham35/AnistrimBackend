// ============================================================
//  services/animeHeavenCatalogService.js — AnimeHeaven Catalog Service
//
//  PURPOSE:
//    Turn AnimeHeaven into the PRIMARY catalog provider. Provides
//    catalog-management operations for the admin dashboard:
//      • bulk import    — import multiple AnimeHeaven anime
//      • bulk sync      — refresh multiple anime's episodes + metadata
//      • daily refresh  — background job that syncs stale anime
//      • missing episode detection — find episodes missing keys/URLs
//      • duplicate prevention — upsert by slug + episode_number
//
//  Stores:
//    anime.animeheaven_slug
//    episodes.animeheaven_episode_key
//    episodes.animeheaven_episode_url
//    anime.animeheaven_last_synced_at
//
// ============================================================
'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');
const { provider: animeHeavenProvider } = require('./animeHeavenProvider');
const animeHeavenImportService = require('./animeHeavenImportService');

// ── Daily refresh interval (default 24h) ───────────────────
const DAILY_REFRESH_INTERVAL_MS = Number(process.env.ANIMEHEAVEN_DAILY_REFRESH_MS || 24 * 60 * 60 * 1000);
// How old an anime must be before it's considered stale for daily refresh.
const STALE_THRESHOLD_MS = Number(process.env.ANIMEHEAVEN_STALE_MS || 24 * 60 * 60 * 1000);

// ── Search (single) ────────────────────────────────────────

/**
 * Search AnimeHeaven for an anime by title.
 * @param {string} title
 * @returns {Promise<Array>}
 */
async function searchAnime(title) {
  return animeHeavenImportService.searchAnime(title);
}

// ── Import (single) ────────────────────────────────────────

/**
 * Import a single AnimeHeaven anime (metadata + episodes) and stamp
 * animeheaven_last_synced_at.
 * @param {string} identifier
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function importAnime(identifier, options = {}) {
  const result = await animeHeavenImportService.importAnime(identifier, options);
  // Stamp last-synced.
  await db.query(
    'UPDATE anime SET animeheaven_last_synced_at = NOW() WHERE id = ?',
    [result.anime.id]
  );
  result.anime.animeheaven_last_synced_at = new Date();
  return result;
}

// ── Sync (single) ──────────────────────────────────────────

/**
 * Sync a single AnimeHeaven anime (refresh episodes + metadata) and stamp
 * animeheaven_last_synced_at.
 * @param {number|string} animeId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function syncAnime(animeId, options = {}) {
  const result = await animeHeavenImportService.syncAnime(animeId, options);
  await db.query(
    'UPDATE anime SET animeheaven_last_synced_at = NOW() WHERE id = ?',
    [result.anime.id]
  );
  result.anime.animeheaven_last_synced_at = new Date();
  return result;
}

// ── Bulk Import ────────────────────────────────────────────

/**
 * Bulk-import multiple AnimeHeaven anime by identifier.
 * @param {string[]} identifiers
 * @param {object} [options]
 * @returns {Promise<{ imported: number, failed: number, results: Array }>}
 */
async function bulkImport(identifiers, options = {}) {
  const list = Array.isArray(identifiers) ? identifiers.filter(Boolean) : [];
  const results = [];
  let imported = 0;
  let failed = 0;

  for (const identifier of list) {
    try {
      const result = await importAnime(identifier, options);
      results.push({ identifier, success: true, animeId: result.anime.id, title: result.anime.title });
      imported += 1;
    } catch (err) {
      logger.warn('[AnimeHeavenCatalog] bulk import failed', { identifier, error: err.message });
      results.push({ identifier, success: false, error: err.message });
      failed += 1;
    }
  }

  return { imported, failed, results };
}

// ── Bulk Sync ──────────────────────────────────────────────

/**
 * Bulk-sync multiple AnimeHeaven anime by their local DB anime id.
 * @param {number[]} animeIds
 * @param {object} [options]
 * @returns {Promise<{ synced: number, failed: number, results: Array }>}
 */
async function bulkSync(animeIds, options = {}) {
  const list = Array.isArray(animeIds) ? animeIds.filter(Boolean) : [];
  const results = [];
  let synced = 0;
  let failed = 0;

  for (const animeId of list) {
    try {
      const result = await syncAnime(animeId, options);
      results.push({ animeId, success: true, title: result.anime.title, episodes: result.episodes });
      synced += 1;
    } catch (err) {
      logger.warn('[AnimeHeavenCatalog] bulk sync failed', { animeId, error: err.message });
      results.push({ animeId, success: false, error: err.message });
      failed += 1;
    }
  }

  return { synced, failed, results };
}

// ── Missing Episode Detection ──────────────────────────────

/**
 * Detect episodes that are missing their AnimeHeaven episode key or URL.
 * Returns a per-anime summary.
 * @returns {Promise<Array<{ animeId, title, slug, totalEpisodes, missingKeys, missingUrls }>>}
 */
async function detectMissingEpisodes() {
  const [rows] = await db.query(
    `SELECT
       a.id AS animeId,
       a.title,
       a.animeheaven_slug AS slug,
       COUNT(e.id) AS totalEpisodes,
       SUM(CASE WHEN e.animeheaven_episode_key IS NULL THEN 1 ELSE 0 END) AS missingKeys,
       SUM(CASE WHEN e.animeheaven_episode_url IS NULL THEN 1 ELSE 0 END) AS missingUrls
     FROM anime a
     LEFT JOIN episodes e ON e.anime_id = a.id
     WHERE a.animeheaven_slug IS NOT NULL
     GROUP BY a.id, a.title, a.animeheaven_slug
     HAVING missingKeys > 0 OR missingUrls > 0
     ORDER BY missingKeys DESC`
  );
  return rows.map(r => ({
    animeId: r.animeId,
    title: r.title,
    slug: r.slug,
    totalEpisodes: Number(r.totalEpisodes || 0),
    missingKeys: Number(r.missingKeys || 0),
    missingUrls: Number(r.missingUrls || 0),
  }));
}

// ── Duplicate Prevention helpers ───────────────────────────

/**
 * Check if an anime slug is already imported (duplicate prevention).
 * @param {string} slug
 * @returns {Promise<boolean>}
 */
async function isImported(slug) {
  if (!slug) return false;
  const [rows] = await db.query('SELECT id FROM anime WHERE animeheaven_slug = ? LIMIT 1', [slug]);
  return rows.length > 0;
}

/**
 * Check if an episode (by anime_id + number) already has an AnimeHeaven key.
 * @param {number} animeId
 * @param {number} episodeNumber
 * @returns {Promise<boolean>}
 */
async function hasEpisodeKey(animeId, episodeNumber) {
  const [rows] = await db.query(
    'SELECT id FROM episodes WHERE anime_id = ? AND episode_number = ? AND animeheaven_episode_key IS NOT NULL LIMIT 1',
    [animeId, episodeNumber]
  );
  return rows.length > 0;
}

// ── Daily Refresh ──────────────────────────────────────────

/**
 * Find anime that are stale (haven't been synced within STALE_THRESHOLD_MS)
 * and sync them. Used by the daily refresh job.
 * @param {object} [options]
 * @returns {Promise<{ scanned: number, synced: number, failed: number }>}
 */
async function dailyRefresh(options = {}) {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const [rows] = await db.query(
    `SELECT id, title, animeheaven_slug AS slug
     FROM anime
     WHERE animeheaven_slug IS NOT NULL
       AND (animeheaven_last_synced_at IS NULL OR animeheaven_last_synced_at < ?)
     LIMIT 100`,
    [cutoff]
  );

  const animeIds = rows.map(r => r.id);
  if (!animeIds.length) return { scanned: 0, synced: 0, failed: 0 };

  const result = await bulkSync(animeIds, options);
  return { scanned: animeIds.length, synced: result.synced, failed: result.failed };
}

// ── Catalog Status / Provider Health ───────────────────────

/**
 * Get the AnimeHeaven catalog status summary for the admin dashboard.
 * @returns {Promise<object>}
 */
async function getCatalogStatus() {
  const [counts] = await db.query(
    `SELECT
       COUNT(*) AS totalAnime,
       SUM(CASE WHEN animeheaven_slug IS NOT NULL THEN 1 ELSE 0 END) AS importedAnime,
       SUM(CASE WHEN animeheaven_last_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS syncedAnime
     FROM anime`
  );
  const [epCounts] = await db.query(
    `SELECT
       COUNT(*) AS totalEpisodes,
       SUM(CASE WHEN animeheaven_episode_key IS NOT NULL THEN 1 ELSE 0 END) AS withKeys,
       SUM(CASE WHEN animeheaven_episode_url IS NOT NULL THEN 1 ELSE 0 END) AS withUrls
     FROM episodes`
  );
  const missing = await detectMissingEpisodes();

  // Provider health snapshot (if available).
  let providerHealth = null;
  try {
    providerHealth = animeHeavenProvider.getHealthSnapshot ? animeHeavenProvider.getHealthSnapshot() : null;
  } catch (_) {}

  return {
    totalAnime: Number(counts[0]?.totalAnime || 0),
    importedAnime: Number(counts[0]?.importedAnime || 0),
    syncedAnime: Number(counts[0]?.syncedAnime || 0),
    totalEpisodes: Number(epCounts[0]?.totalEpisodes || 0),
    episodesWithKeys: Number(epCounts[0]?.withKeys || 0),
    episodesWithUrls: Number(epCounts[0]?.withUrls || 0),
    missingEpisodes: missing,
    providerHealth,
  };
}

// ── Background daily refresh job ───────────────────────────

/**
 * Start the daily-refresh background job (idempotent). The interval is
 * unref'd so it never blocks a clean shutdown. Any failure is swallowed.
 */
function startDailyRefresh() {
  if (startDailyRefresh._started) return;
  startDailyRefresh._started = true;

  const timer = setInterval(() => {
    dailyRefresh().catch((err) => {
      logger.warn('[AnimeHeavenCatalog] daily refresh failed', { error: err.message });
    });
  }, DAILY_REFRESH_INTERVAL_MS);
  if (timer.unref) timer.unref();
  timer._anistrimCatalog = true;

  process.on('exit', () => {
    if (timer && timer._anistrimCatalog && typeof timer.unref === 'function') {
      clearInterval(timer);
    }
  });
  logger.info('[AnimeHeavenCatalog] Daily refresh job started', {
    intervalMs: DAILY_REFRESH_INTERVAL_MS,
  });
}

module.exports = {
  searchAnime,
  importAnime,
  syncAnime,
  bulkImport,
  bulkSync,
  dailyRefresh,
  detectMissingEpisodes,
  isImported,
  hasEpisodeKey,
  getCatalogStatus,
  startDailyRefresh,
  // Exposed for tests.
  DAILY_REFRESH_INTERVAL_MS,
  STALE_THRESHOLD_MS,
};