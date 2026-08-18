-- ============================================================
--  AniStrim2 — Migration v40: Ads Config Fix (Phase 8)
--
--  Adds the missing ads_config.banner_unit_id column and
--  re-asserts the v36 pre_roll_*/interstitial_* columns using
--  TABLE_SCHEMA = DATABASE() (never a hardcoded schema name).
--
--  The migration runner strips `USE` statements, so any
--  information_schema guard MUST use DATABASE() to match the
--  actual connected schema.
-- ============================================================

-- ── 1. banner_unit_id (missing from v14/v36) ───────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ads_config' AND COLUMN_NAME = 'banner_unit_id'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE ads_config ADD COLUMN banner_unit_id VARCHAR(190) DEFAULT NULL',
    'SELECT "ads_config.banner_unit_id exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. Re-assert v36 pre_roll_*/interstitial_* columns ─────
-- Idempotent: only adds columns that are still missing, using
-- DATABASE() so it works regardless of the connected schema name.
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ads_config' AND COLUMN_NAME = 'pre_roll_unit_id'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE ads_config
       ADD COLUMN pre_roll_unit_id VARCHAR(190) DEFAULT NULL,
       ADD COLUMN pre_roll_frequency_cap INT DEFAULT 2,
       ADD COLUMN pre_roll_skippable_after_sec INT DEFAULT 5,
       ADD COLUMN pre_roll_max_duration_sec INT DEFAULT 15,
       ADD COLUMN interstitial_frequency_cap INT DEFAULT 2,
       ADD COLUMN interstitial_every_n_episodes INT DEFAULT 3',
    'SELECT "ads_config placement columns exist" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ads_config';