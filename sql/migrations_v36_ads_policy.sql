-- ============================================================
--  AniStrim2 — Migration v36: Ads Policy & Events (Phase 8)
--
--  8.1 ads_config per-placement controls (enriched).
--  8.3 ad_events log for the health dashboard.
--
--  NOTE: The migration runner strips `USE` statements, so any
--  information_schema guard MUST use DATABASE() — never a
--  hardcoded schema name.
-- ============================================================

-- ── 8.3 ad_events table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  provider VARCHAR(30) DEFAULT NULL,
  slot VARCHAR(30) DEFAULT NULL,
  event ENUM('impression','click','fail','skip','timeout') NOT NULL DEFAULT 'impression',
  context VARCHAR(20) DEFAULT NULL,
  detail VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_slot (slot)
) ENGINE=InnoDB;

-- ── 8.1 ads_config per-placement enrichment (idempotent) ────
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
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_events';
