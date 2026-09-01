-- ============================================================
--  AniStrim2 — Migration v55: Manual Cloudinary Video URL
--
--  PURPOSE:
--    Add a `manual_video_url` column to the episodes table so
--    administrators can upload videos to Cloudinary and associate
--    the resulting URL with an episode WITHOUT interfering with
--    the existing AnimeHeaven playable URL fields.
--
--  This is an ADDITIVE change only:
--    • Existing AnimeHeaven fields (animeheaven_episode_url,
--      animeheaven_episode_key) are NOT modified.
--    • Existing video_url field is NOT modified.
--    • Existing AnimeHeaven resolution/sync logic is NOT changed.
--    • Existing AnimeHeaven cache/storage semantics are preserved.
--
--  The conceptual database state after this migration:
--    episodes
--    ├── animeheaven_episode_url   (managed ONLY by AnimeHeaven)
--    ├── animeheaven_episode_key   (managed ONLY by AnimeHeaven)
--    ├── video_url                 (existing generic field)
--    └── manual_video_url          (managed ONLY by admin upload)
--
--  Safe / idempotent: uses information_schema guards with
--  DATABASE() and PREPARE/EXECUTE.
-- ============================================================

-- 1. Add the manual_video_url column (idempotent guard)
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'episodes'
      AND COLUMN_NAME  = 'manual_video_url'
);

SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE episodes ADD COLUMN manual_video_url VARCHAR(1000) DEFAULT NULL COMMENT ''Admin-uploaded Cloudinary video URL (independent of AnimeHeaven)''',
    'SELECT "episodes.manual_video_url column already exists" AS info'
);

PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Verify
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'episodes'
  AND COLUMN_NAME = 'manual_video_url';