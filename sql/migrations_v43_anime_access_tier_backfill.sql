-- migrations_v43_anime_access_tier_backfill.sql
-- One-time backfill so `anime.access_tier` becomes the single source of truth
-- for episode inheritance (utils/episodeAccess.js reads only anime.access_tier).
--
-- Previously the admin dashboard wrote only `anime.is_premium` (and the
-- catalogue badge rendered from it), so an anime could SHOW as premium while
-- `access_tier` stayed 'free' — letting free users stream every episode.
-- This backfill puts access_tier in sync with is_premium for existing rows.

UPDATE anime
   SET access_tier = 'premium'
 WHERE is_premium = 1
   AND access_tier <> 'premium';

-- (Optional) normalise any legacy non-premium rows back to 'free'.
UPDATE anime
   SET access_tier = 'free'
 WHERE (is_premium = 0 OR is_premium IS NULL)
   AND access_tier NOT IN ('free');