const db = require('../config/db');
const cache = require('../utils/cacheService');
const { KitsuProvider } = require('./kitsuProvider');
const { MalSyncProvider } = require('./malSyncProvider');
const { ConsumetProvider } = require('./consumetProvider');

const kitsu = new KitsuProvider();
const malSync = new MalSyncProvider();
const consumet = new ConsumetProvider();
const METADATA_TTL = 24 * 60 * 60;
const EPISODES_TTL = 6 * 60 * 60;
const STREAM_TTL = 30 * 60;

function publicAnime(row) {
  const cover = row.cover_image || null;
  return { ...row, kitsu_id: row.source_provider === 'kitsu' ? row.source_id : null, cover_image: cover, poster_url: cover, thumbnail_url: cover, banner_url: row.banner_image || null, source: row.source_provider || 'admin' };
}

async function replaceGenres(animeId, names) {
  if (!names?.length) return;
  const ids = [];
  for (const rawName of names) {
    const name = String(rawName).trim();
    if (!name) continue;
    await db.query('INSERT IGNORE INTO genres (name) VALUES (?)', [name]);
    const [rows] = await db.query('SELECT id FROM genres WHERE name = ?', [name]);
    if (rows[0]) ids.push(rows[0].id);
  }
  if (ids.length) await db.query('INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES ?', [ids.map(id => [animeId, id])]);
}

async function importKitsuAnime(metadata) {
  const [existing] = await db.query('SELECT * FROM anime WHERE source_provider = ? AND source_id = ? LIMIT 1', ['kitsu', metadata.kitsu_id]);
  if (existing.length) return publicAnime(existing[0]);
  const [result] = await db.query(
    `INSERT INTO anime (title, title_japanese, description, cover_image, banner_image, rating, year, status, tags, source_provider, source_id, source_slug)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'kitsu', ?, ?)`,
    [metadata.title, metadata.title_japanese, metadata.description, metadata.cover_image, metadata.banner_image, metadata.rating, metadata.year, metadata.status, metadata.age_rating, metadata.kitsu_id, metadata.slug]
  );
  await replaceGenres(result.insertId, metadata.genres);
  const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [result.insertId]);
  return publicAnime(rows[0]);
}

async function search(query, limit = 20) {
  const cacheKey = `catalogue:search:${query.toLowerCase()}:${limit}`;
  const cached = await cache.get(cacheKey); if (cached) return cached;
  const [local] = await db.query(`SELECT * FROM anime WHERE title LIKE ? OR title_japanese LIKE ? ORDER BY created_at DESC LIMIT ?`, [`%${query}%`, `%${query}%`, limit]);
  if (local.length) return cache.set(cacheKey, local.map(publicAnime), METADATA_TTL);
  const remote = await kitsu.searchAnime(query, limit);
  const imported = [];
  for (const item of remote) imported.push(await importKitsuAnime(item));
  return cache.set(cacheKey, imported, METADATA_TTL);
}

async function importFromKitsu(kitsuId) {
  const metadata = await kitsu.getAnimeInfo(kitsuId);
  let anime = await importKitsuAnime(metadata);
  const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [anime.id]);
  const slug = await getMapping(rows[0]);
  if (slug) {
    await db.query('UPDATE anime SET source_slug = ? WHERE id = ?', [slug, anime.id]);
    anime = { ...anime, source_slug: slug };
  }
  await cache.delByPrefix('catalogue:');
  return { anime, mapping: { provider: 'gogoanime', slug: slug || null, resolved: Boolean(slug) } };
}

async function getAnime(id) {
  const cacheKey = `catalogue:anime:${id}`; const cached = await cache.get(cacheKey); if (cached) return cached;
  const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [id]);
  if (!rows.length) return null;
  return cache.set(cacheKey, publicAnime(rows[0]), METADATA_TTL);
}

async function getMapping(anime) {
  if (!anime.source_id) return null;
  const [rows] = await db.query('SELECT provider_slug FROM anime_mappings WHERE kitsu_id = ? AND provider = ? LIMIT 1', [anime.source_id, 'gogoanime']);
  if (rows[0]) return rows[0].provider_slug;
  const slug = await malSync.resolveGogoSlug({ malId: anime.mal_id });
  if (!slug) return null;
  await db.query(`INSERT INTO anime_mappings (kitsu_id, provider, provider_slug) VALUES (?, 'gogoanime', ?)
                  ON DUPLICATE KEY UPDATE provider_slug = VALUES(provider_slug), updated_at = CURRENT_TIMESTAMP`, [anime.source_id, slug]);
  return slug;
}

async function getEpisodes(animeId) {
  const [custom] = await db.query('SELECT id, episode_number, title, description, thumbnail_url, duration_sec, is_premium, video_url FROM episodes WHERE anime_id = ? ORDER BY episode_number', [animeId]);
  if (custom.length) return custom.map(episode => ({ ...episode, source: 'cloudinary' }));
  const anime = await getAnime(animeId); if (!anime || anime.source !== 'kitsu') return [];
  const cacheKey = `catalogue:episodes:${animeId}`; const cached = await cache.get(cacheKey); if (cached) return cached;
  const slug = await getMapping(anime); if (!slug || !consumet.configured()) return [];
  const episodes = await consumet.getEpisodes(slug);
  return cache.set(cacheKey, episodes.map((episode, index) => ({ id: episode.id, episode_number: episode.number || index + 1, title: episode.title || `Episode ${index + 1}`, thumbnail_url: episode.image || anime.cover_image, is_premium: false, source: 'consumet' })), EPISODES_TTL);
}

async function getStream(animeId, episodeId) {
  const cacheKey = `catalogue:stream:${animeId}:${episodeId}`; const cached = await cache.get(cacheKey); if (cached) return cached;
  const [custom] = await db.query('SELECT id, video_url, thumbnail_url, title, episode_number FROM episodes WHERE anime_id = ? AND (id = ? OR episode_number = ?) LIMIT 1', [animeId, episodeId, episodeId]);
  if (custom[0]?.video_url) return cache.set(cacheKey, { video_url: custom[0].video_url, subtitles: [], qualities: [], episode: custom[0], source: 'cloudinary' }, STREAM_TTL);
  const anime = await getAnime(animeId); if (!anime || anime.source !== 'kitsu') return null;
  const sources = await consumet.getSources(episodeId);
  return cache.set(cacheKey, { video_url: sources.sources?.[0]?.url || null, subtitles: sources.subtitles || [], qualities: sources.sources || [], episode: { id: episodeId }, source: 'consumet' }, STREAM_TTL);
}

async function invalidate(animeId) { await Promise.all([cache.delByPrefix('catalogue:search:'), cache.delByPrefix(`catalogue:anime:${animeId}`), cache.delByPrefix(`catalogue:episodes:${animeId}`), cache.delByPrefix(`catalogue:stream:${animeId}:`)]); }

module.exports = { search, importFromKitsu, getAnime, getEpisodes, getStream, invalidate };
