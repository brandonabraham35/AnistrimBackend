-- ============================================================
--  AniStrim2 — Migration v16: Add media_type + ensure cloudinary columns
--  Purpose:
--    1. Add media_type column to anime table (TV/MOVIE/OVA/SPECIAL)
--       so the stream controller can distinguish standalone movies
--       from multi-episode series and adjust query logic accordingly.
--    2. Ensure cover_public_id and banner_public_id columns exist,
--       as admin import and cloudinary image persistence depend on them.
--
--  Run in MySQL Workbench or CLI:
--    mysql -u root -p anistrim2 < sql/migrations_v16_media_type.sql
-- ============================================================

-- ── 1. Add media_type column ──────────────────────────────
-- Using VARCHAR(20) for flexibility; defaults to 'TV' so all
-- existing records are treated as series (no breaking change).
ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) NOT NULL DEFAULT 'TV';

-- ── 2. Add cover_public_id & banner_public_id (if missing) ─
ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS cover_public_id  VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_public_id VARCHAR(255) DEFAULT NULL;

-- ── 3. Add cover_public_id & banner_public_id indexes ──────
-- These help if you ever do admin lookups by public_id.
ALTER TABLE anime
  ADD INDEX IF NOT EXISTS idx_cover_public_id (cover_public_id),
  ADD INDEX IF NOT EXISTS idx_banner_public_id (banner_public_id);

-- ── 4. Verify columns ─────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'anime'
  AND COLUMN_NAME IN ('media_type', 'cover_public_id', 'banner_public_id')
ORDER BY COLUMN_NAME;


