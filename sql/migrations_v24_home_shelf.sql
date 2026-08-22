-- ============================================================
--  AniStrim2 — Migration v24: Home Shelf Categorization
--
--  Adds columns needed by the automatic home-page section
--  builder (trending, popular, new releases, classics).
--
--  • anime.premiere_date       — actual calendar premiere date
--    (for "New Releases", "Trending", and "Classics" logic).
--    Falls back to January 1 of the `year` column when NULL.
--  • anime.watchlist_count     — cached count of user watchlist
--    saves for "Popular" and "Trending" ranking.
--  • user_watchlists table     — already migrated in v12.
--  • watch_history table       — already migrated in v11/v20.
--
--  Safe / idempotent — uses information_schema guards.
-- ============================================================

-- ── 1. anime.premiere_date ───────────────────────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'anime'
      AND COLUMN_NAME  = 'premiere_date'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE anime ADD COLUMN premiere_date DATE DEFAULT NULL AFTER `year`',
    'SELECT "premiere_date column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill premiere_date from year for existing rows where it's NULL
UPDATE anime
SET premiere_date = MAKEDATE(year, 1)
WHERE premiere_date IS NULL AND year IS NOT NULL AND year > 0;

-- ── 2. anime.watchlist_count (cached counter) ────────────────
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'anime'
      AND COLUMN_NAME  = 'watchlist_count'
);
SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE anime ADD COLUMN watchlist_count INT NOT NULL DEFAULT 0 AFTER view_count',
    'SELECT "watchlist_count column already exists" AS info'
);
PREPARE stmt2 FROM @alter_sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- Seed watchlist_count from existing watchlist saves
UPDATE anime a
SET a.watchlist_count = (
    SELECT COUNT(*) FROM user_watchlists uw WHERE uw.anime_id = CAST(a.id AS CHAR)
)
WHERE 1=1;

-- ── 3. Index for queries ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_premiere_date ON anime (premiere_date);
CREATE INDEX IF NOT EXISTS idx_watchlist_count ON anime (watchlist_count);

-- ── 4. Verify ────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'anime'
  AND COLUMN_NAME IN ('premiere_date', 'watchlist_count')
ORDER BY COLUMN_NAME;
