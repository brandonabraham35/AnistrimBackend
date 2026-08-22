-- ============================================================
--  AniStrim2 — Migration v33: Content CMS + Audit Logging (Phase 5)
--
--  5.1 Add anime.is_published / episodes.is_published + availability window.
--  5.3 Extend admin_logs to the audit schema with before_json/after_json,
--      entity_type/entity_id, ip_hash. Never allow UI deletion.
-- ============================================================

-- ── 5.1 Content publication columns ────────────────────────

-- anime.is_published
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'anime' AND COLUMN_NAME = 'is_published'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE anime ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 1',
    'SELECT "anime.is_published exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- anime.credits_threshold_sec (nullable → global default)
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'anime' AND COLUMN_NAME = 'credits_threshold_sec'
);
SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE anime ADD COLUMN credits_threshold_sec INT DEFAULT NULL',
    'SELECT "anime.credits_threshold_sec exists" AS info'
);
PREPARE stmt2 FROM @alter_sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- episodes.is_published
SET @col_exists3 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'episodes' AND COLUMN_NAME = 'is_published'
);
SET @alter_sql3 := IF(@col_exists3 = 0,
    'ALTER TABLE episodes ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 1',
    'SELECT "episodes.is_published exists" AS info'
);
PREPARE stmt3 FROM @alter_sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- episodes.availability_starts_at / availability_ends_at
SET @col_exists4 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'episodes' AND COLUMN_NAME = 'availability_starts_at'
);
SET @alter_sql4 := IF(@col_exists4 = 0,
    'ALTER TABLE episodes ADD COLUMN availability_starts_at DATETIME DEFAULT NULL',
    'SELECT "episodes.availability_starts_at exists" AS info'
);
PREPARE stmt4 FROM @alter_sql4;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

SET @col_exists5 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'episodes' AND COLUMN_NAME = 'availability_ends_at'
);
SET @alter_sql5 := IF(@col_exists5 = 0,
    'ALTER TABLE episodes ADD COLUMN availability_ends_at DATETIME DEFAULT NULL',
    'SELECT "episodes.availability_ends_at exists" AS info'
);
PREPARE stmt5 FROM @alter_sql5;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- ── 5.3 Extend admin_logs to the audit schema ──────────────
-- Add entity_type, entity_id, before_json, after_json, ip_hash (idempotent).
SET @audit_cols := 'entity_type entity_id before_json after_json ip_hash';
SET @col_exists6 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_logs' AND COLUMN_NAME = 'entity_type'
);
SET @alter_sql6 := IF(@col_exists6 = 0,
    'ALTER TABLE admin_logs
       ADD COLUMN entity_type VARCHAR(80) DEFAULT NULL AFTER action,
       ADD COLUMN entity_id VARCHAR(64) DEFAULT NULL AFTER entity_type,
       ADD COLUMN before_json JSON DEFAULT NULL,
       ADD COLUMN after_json JSON DEFAULT NULL,
       ADD COLUMN ip_hash CHAR(64) DEFAULT NULL',
    'SELECT "admin_logs audit columns exist" AS info'
);
PREPARE stmt6 FROM @alter_sql6;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

-- Index for filterable audit log.
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_logs' AND INDEX_NAME = 'idx_audit'
);
SET @idx_sql := IF(@idx_exists = 0,
    'CREATE INDEX idx_audit ON admin_logs (entity_type, entity_id, created_at)',
    'SELECT "idx_audit exists" AS info'
);
PREPARE stmt7 FROM @idx_sql;
EXECUTE stmt7;
DEALLOCATE PREPARE stmt7;

-- ── Verify ─────────────────────────────────────────────────
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ((TABLE_NAME = 'anime' AND COLUMN_NAME IN ('is_published','credits_threshold_sec'))
    OR (TABLE_NAME = 'episodes' AND COLUMN_NAME IN ('is_published','availability_starts_at','availability_ends_at'))
    OR (TABLE_NAME = 'admin_logs' AND COLUMN_NAME IN ('entity_type','entity_id','before_json','after_json','ip_hash')))
ORDER BY TABLE_NAME, COLUMN_NAME;
