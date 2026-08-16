-- migrations_v28_premium_access.sql
-- P2: Premium episode access model — schema only (runner-safe, no DELIMITER,
-- no stored function). Effective access is computed in the application layer
-- (utils/episodeAccess.js), which is portable and works regardless of the MySQL
-- client/runner used to apply migrations.
--
-- Model:
--   Anime    : FREE | PREMIUM   (anime.access_tier)
--   Episode  : INHERIT | FREE | PREMIUM  (episodes.access_tier)
--   Timing   : Permanent (NULL premium_until) | 24h | 48h | 72h | 7 days | Custom

-- 1. Anime access tier (applies to episodes that INHERIT).
ALTER TABLE anime
  ADD COLUMN access_tier VARCHAR(8) NOT NULL DEFAULT 'free';

-- 2. Episode access tier + optional premium expiry.
--    premium_until: NULL + access_tier='premium' => permanent.
--    premium_until < NOW() + access_tier='premium' => effective free.
ALTER TABLE episodes
  ADD COLUMN access_tier VARCHAR(8) NOT NULL DEFAULT 'inherit',
  ADD COLUMN premium_until DATETIME NULL DEFAULT NULL;