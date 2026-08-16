-- ============================================================
--  AniStrim2 — Migration v35: Plans & Subscription Entitlement (Phase 7)
--
--  7.1 plans table + enriched subscriptions columns.
--  users.is_premium / premium_expires_at become derived cache columns only —
--  refreshed by the subscription service, never written by hand, never read
--  for authorization (authorization uses the plans + subscriptions read path).
-- ============================================================
USE anistrim2;

-- ── 7.1 plans table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) UNIQUE,
  name VARCHAR(80),
  tier ENUM('basic','standard','premium') NOT NULL,
  period ENUM('monthly','quarterly','annual') NOT NULL,
  amount DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'UGX',
  max_devices INT DEFAULT 2,
  max_quality VARCHAR(10) DEFAULT '1080p',
  ads_enabled TINYINT(1) DEFAULT 0,
  trial_days INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB;

-- Seed default plans (idempotent).
INSERT IGNORE INTO plans (code, name, tier, period, amount, currency, max_devices, max_quality, ads_enabled, trial_days, is_active) VALUES
  ('standard-monthly', 'Standard Monthly', 'standard', 'monthly', 9.99, 'UGX', 2, '1080p', 0, 0, 1),
  ('standard-annual',  'Standard Annual',  'standard', 'annual',  99.99, 'UGX', 2, '1080p', 0, 7, 1),
  ('premium-monthly',  'Premium Monthly',  'premium',  'monthly', 14.99, 'UGX', 3, '4k',    0, 0, 1),
  ('premium-annual',   'Premium Annual',   'premium',  'annual',  149.99, 'UGX', 3, '4k',    0, 14, 1);

-- ── 7.1 subscriptions enriched columns (idempotent) ─────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2' AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'plan_id'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE subscriptions
       ADD COLUMN plan_id INT DEFAULT NULL,
       ADD COLUMN starts_at DATETIME DEFAULT NULL,
       ADD COLUMN ends_at DATETIME DEFAULT NULL,
       ADD COLUMN state ENUM(''trialing'',''active'',''grace'',''expired'',''cancelled'',''refunded'') NOT NULL DEFAULT ''active'',
       ADD COLUMN source ENUM(''payment'',''admin_grant'',''promo'',''trial'') NOT NULL DEFAULT ''payment'',
       ADD COLUMN auto_renew TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT "subscriptions enrichment columns exist" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Index on order_tracking_id for idempotent IPN / reconciliation.
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = 'anistrim2' AND TABLE_NAME = 'subscriptions' AND INDEX_NAME = 'uniq_order_tracking'
);
SET @idx_sql := IF(@idx_exists = 0,
    'ALTER TABLE subscriptions ADD UNIQUE KEY uniq_order_tracking (order_tracking_id)',
    'SELECT "uniq_order_tracking exists" AS info'
);
PREPARE stmt2 FROM @idx_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── 7.4 payment_events table (state transition log) ─────────
CREATE TABLE IF NOT EXISTS payment_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subscription_id INT DEFAULT NULL,
  reference VARCHAR(191) DEFAULT NULL,
  event VARCHAR(50) NOT NULL,
  payload JSON DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ref (reference),
  INDEX idx_sub (subscription_id)
) ENGINE=InnoDB;

-- Verify
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'anistrim2' AND TABLE_NAME = 'subscriptions'
  AND COLUMN_NAME IN ('plan_id','starts_at','ends_at','state','source','auto_renew') ORDER BY COLUMN_NAME;