-- ============================================================
--  AniStrim2 — Migration v19: Episode Seasons
--  Adds a `season` column to the episodes table so multi-season
--  anime (e.g. Season 1, Season 2) can be grouped and rendered
--  in the in-player episode sidebar.
--
--  Safe / idempotent: uses information_schema guards so it
--  can be re-run without error.
-- ============================================================
USE anistrim2;

-- 1. Add the season column (default 1 for existing single-season episodes)
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'episodes'
      AND COLUMN_NAME  = 'season'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE episodes ADD COLUMN season SMALLINT NOT NULL DEFAULT 1',
    'SELECT "season column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Ensure a composite index for fast season/episode lookups
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'episodes'
      AND INDEX_NAME   = 'idx_anime_season_ep'
);
SET @idx_sql := IF(@idx_exists = 0,
    'CREATE INDEX idx_anime_season_ep ON episodes (anime_id, season, episode_number)',
    'SELECT "index idx_anime_season_ep already exists" AS info'
);
PREPARE stmt2 FROM @idx_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. Verify
DESCRIBE episodes;
