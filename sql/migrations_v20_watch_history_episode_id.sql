-- ============================================================
--  AniStrim2 — Migration v20: Episode ID in Watch History
--  Adds an `episode_id` column to watch_history so we persist
--  the exact episode database record ID alongside anime_id +
--  episode_number. This is required for precise per-episode
--  progress tracking and resume functionality.
--
--  Safe / idempotent: uses information_schema guards.
-- ============================================================

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'watch_history'
      AND COLUMN_NAME  = 'episode_id'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE watch_history ADD COLUMN episode_id INT DEFAULT NULL',
    'SELECT "episode_id column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure existing rows get episode_id populated (join on anime + ep number)
UPDATE watch_history wh
JOIN episodes e ON e.anime_id = CAST(wh.anime_id AS UNSIGNED) AND e.episode_number = wh.episode_number
SET wh.episode_id = e.id
WHERE wh.episode_id IS NULL;

DESCRIBE watch_history;

