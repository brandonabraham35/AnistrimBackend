-- migrations_v28_premium_access.sql
-- P2: Premium episode access model.
--
-- Model (per spec):
--   Anime    : FREE | PREMIUM
--   Episode  : INHERIT | FREE | PREMIUM
--   Timing   : Permanent | 24h | 48h | 72h | 7 days | Custom
--
-- Effective access for an episode is computed in ONE place — the
-- episode_effective_access() SQL function below — and reused by catalog lists,
-- detail queries, the UI badge, and server-side playback enforcement.

-- 1. Anime access tier (applies to episodes that INHERIT).
ALTER TABLE anime
  ADD COLUMN access_tier ENUM('free','premium') NOT NULL DEFAULT 'free'
  AFTER is_premium;

-- 2. Episode access tier + optional premium expiry.
ALTER TABLE episodes
  ADD COLUMN access_tier ENUM('inherit','free','premium') NOT NULL DEFAULT 'inherit'
  AFTER is_premium,
  ADD COLUMN premium_until DATETIME NULL DEFAULT NULL
  AFTER access_tier;

-- 3. Single source of truth for effective access.
-- Returns 'free' or 'premium'.
--   • episode INHERIT  -> anime.access_tier
--   • episode FREE     -> free
--   • episode PREMIUM  -> premium, UNLESS premium_until is set and < NOW() -> free
DROP FUNCTION IF EXISTS episode_effective_access;
DELIMITER $$
CREATE FUNCTION episode_effective_access(p_episode_id INT)
RETURNS VARCHAR(16)
DETERMINISTIC
READS SQL DATA
BEGIN
  DECLARE v_episode_tier   VARCHAR(16);
  DECLARE v_anime_tier     VARCHAR(16);
  DECLARE v_premium_until  DATETIME;
  DECLARE v_effective      VARCHAR(16) DEFAULT 'free';

  SELECT e.access_tier, e.premium_until, a.access_tier
    INTO v_episode_tier, v_premium_until, v_anime_tier
  FROM episodes e
  JOIN anime a ON a.id = e.anime_id
  WHERE e.id = p_episode_id;

  IF v_episode_tier = 'premium' THEN
    SET v_effective = 'premium';
    IF v_premium_until IS NOT NULL AND v_premium_until < NOW() THEN
      SET v_effective = 'free'; -- expired premium -> free everywhere
    END IF;
  ELSEIF v_episode_tier = 'free' THEN
    SET v_effective = 'free';
  ELSE -- inherit
    SET v_effective = IFNULL(v_anime_tier, 'free');
  END IF;

  RETURN v_effective;
END$$
DELIMITER ;

-- 4. Backfill: existing anime are 'free', existing episodes are 'inherit',
--    so behaviour is unchanged until an admin opts a title in. Existing
--    is_premium (legacy) flags are preserved — they still gate the old badge.
ALTER TABLE anime ALTER COLUMN access_tier SET DEFAULT 'free';
ALTER TABLE episodes ALTER COLUMN access_tier SET DEFAULT 'inherit';