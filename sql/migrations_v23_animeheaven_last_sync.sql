-- ============================================================
--  AniStrim2 — Migration v23: AnimeHeaven Last Sync Timestamp
--
--  PURPOSE:
--    Store when an AnimeHeaven anime was last synced/refreshed so the
--    admin dashboard can display "Last Sync" and the daily-refresh
--    job knows which anime are stale.
--
--  Safe / idempotent: uses information_schema guards.
-- ============================================================
USE anistrim2;

-- ── 1. anime.animeheaven_last_synced_at ───────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'anime'
      AND COLUMN_NAME  = 'animeheaven_last_synced_at'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE anime ADD COLUMN animeheaven_last_synced_at DATETIME DEFAULT NULL',
    'SELECT "animeheaven_last_synced_at column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. Verify ──────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'anistrim2'
  AND TABLE_NAME = 'anime'
  AND COLUMN_NAME = 'animeheaven_last_synced_at';