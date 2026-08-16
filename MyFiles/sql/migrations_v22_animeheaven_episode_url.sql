-- ============================================================
--  AniStrim2 — Migration v22: AnimeHeaven Episode URL Prefetch
--
--  PURPOSE:
--    Store the resolved AnimeHeaven gate URL for each episode so the
--    fast playback path can go directly to the gate page WITHOUT
--    re-resolving the episode list or searching. This supports the
--    "episode key → gate → player → streams" fast path.
--
--  Safe / idempotent: uses information_schema guards.
-- ============================================================
USE anistrim2;

-- ── 1. episodes.animeheaven_episode_url ───────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'episodes'
      AND COLUMN_NAME  = 'animeheaven_episode_url'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE episodes ADD COLUMN animeheaven_episode_url VARCHAR(500) DEFAULT NULL',
    'SELECT "animeheaven_episode_url column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. Verify ──────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'anistrim2'
  AND TABLE_NAME = 'episodes'
  AND COLUMN_NAME = 'animeheaven_episode_url';