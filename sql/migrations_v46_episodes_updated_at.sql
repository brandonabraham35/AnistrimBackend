-- ============================================================
--  AniStrim2 — Migration v46: Episodes updated_at (Production Bug Fix)
--
--  Root cause of "Unknown column 'e.updated_at' in 'field list'":
--    The episodes table (schema.sql + migrations) was never given an
--    `updated_at` column, but the application contract (DTO layer, API
--    responses, episode listing, anime detail page) now expects it.
--    controllers/animeController.js getById() and routes/animeRoutes.js
--    both SELECT e.updated_at, and services/apiDtoService.js emits
--    it in the episode DTO.
--
--    The old workaround in services/animeHeavenImportService.js deliberately
--    omitted updated_at from its UPDATE statements to avoid the error.
--    That workaround is now removed — the column exists.
--
--  This migration adds `updated_at` to the episodes table so the schema
--  matches the application contract. Existing rows get the default
--  (CURRENT_TIMESTAMP) and will auto-update on subsequent writes.
--
--  Safe / idempotent: uses an information_schema guard with DATABASE()
--  (never a hardcoded schema name) and PREPARE/EXECUTE so it can be
--  re-run without error. The migration runner also strips USE statements
--  and catches ER_DUP_FIELDNAME as an idempotent skip.
-- ============================================================

-- 1. Add the updated_at column (idempotent guard via information_schema)
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'episodes'
      AND COLUMN_NAME  = 'updated_at'
);

SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE episodes ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    'SELECT "episodes.updated_at column already exists" AS info'
);

PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Ensure a composite index for fast per-anime episode lookups
--    (mirrors the index already present in schema.sql / v19 conventions)
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'episodes'
      AND INDEX_NAME   = 'idx_anime_updated'
);

SET @idx_sql := IF(@idx_exists = 0,
    'CREATE INDEX idx_anime_updated ON episodes (anime_id, updated_at)',
    'SELECT "index idx_anime_updated already exists" AS info'
);

PREPARE stmt2 FROM @idx_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. Verify
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'episodes'
  AND COLUMN_NAME = 'updated_at';
