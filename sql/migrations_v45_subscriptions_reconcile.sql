-- ============================================================
--  Migration v45: Subscriptions table reconciliation
--
--  Root cause of "Unknown column 'plan' in 'field list'":
--    v15 (migrations_v15_subscriptions.sql) defines `plan` inside
--    CREATE TABLE IF NOT EXISTS subscriptions (...).  When a
--    pre-existing subscriptions table exists (created by an older
--    migration or manually), CREATE TABLE IF NOT EXISTS is a NO-OP
--    and `plan` is never added.
--
--    v35 (migrations_v35_plans_subscriptions.sql) adds several
--    enriched columns via ALTER TABLE, but does NOT add `plan`
--    (it assumes v15 already provided it).
--
--    Result: production databases without `plan` fail on every
--    INSERT into subscriptions, breaking /api/payments/checkout.
--
--  This forward-only reconciliation migration:
--    1. Creates the table with the full current schema (fresh installs).
--    2. Adds any missing columns on pre-existing tables (idempotent).
--    3. Expands the `plan` ENUM to include 'admin_grant' (adminController
--       inserts plan='admin_grant'; v15 only had 'monthly','yearly').
--    4. Expands the `status` ENUM to include 'CANCELLED' (cancel flow
--       sets status='CANCELLED' but v15 only had 4 values).
--    5. Ensures the uniq_order_tracking index exists.
--
--  Idempotent on re-runs:
--    - CREATE TABLE IF NOT EXISTS is MySQL-native.
--    - ADD COLUMN IF NOT EXISTS is normalized by the runner and errcodes
--      ER_DUP_FIELDNAME / ER_DUP_KEYNAME are caught as idempotent skips.
--    - ENUM widening uses information_schema guards + PREPARE/EXECUTE so
--      MODIFY only runs when the column exists but lacks the needed value.
-- ============================================================

USE anistrim2;

-- ── 1. Fresh-install table (current canonical schema contract) ──
CREATE TABLE IF NOT EXISTS subscriptions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT NOT             NOT NULL,
  reference         VARCHAR(191)        NOT NULL UNIQUE,
  amount            DECIMAL(10,2)       NOT NULL,
  currency          VARCHAR(10)         NOT NULL DEFAULT 'UGX',
  status            ENUM('PENDING','COMPLETED','FAILED','REFUNDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  plan              ENUM('monthly','yearly','admin_grant') NOT NULL DEFAULT 'monthly',
  order_tracking_id VARCHAR(191)        DEFAULT NULL,
  payment_method    VARCHAR(80)         DEFAULT NULL,
  paid_at           DATETIME            DEFAULT NULL,
  expires_at        DATETIME            DEFAULT NULL,
  plan_id           INT                 DEFAULT NULL,
  starts_at         DATETIME            DEFAULT NULL,
  ends_at           DATETIME            DEFAULT NULL,
  state             ENUM('pending','trialing','active','grace','expired','cancelled','refunded') NOT NULL DEFAULT 'pending',
  source            ENUM('payment','admin_grant','promo','trial') NOT NULL DEFAULT 'payment',
  auto_renew        TINYINT(1)          NOT NULL DEFAULT 0,
  created_at        TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_reference (reference),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- ── 2. Reconcile missing columns on pre-existing tables ──
-- The migration runner strips IF NOT EXISTS (MariaDB syntax) from
-- ADD COLUMN and catches ER_DUP_FIELDNAME — making these re-runs safe.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS order_tracking_id VARCHAR(191) DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(80) DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_id INT DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS starts_at DATETIME DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ends_at DATETIME DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS state ENUM('pending','trialing','active','grace','expired','cancelled','refunded') NOT NULL DEFAULT 'pending';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS source ENUM('payment','admin_grant','promo','trial') NOT NULL DEFAULT 'payment';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew TINYINT(1) NOT NULL DEFAULT 0;

-- ── 3. Reconcile `plan` column (PRIMARY BUG FIX) ──
-- If the column does not exist (v15 CREATE TABLE was a no-op on a
-- pre-existing table) → ADD it with the full enum.
-- If the column exists but its enum lacks 'admin_grant' → MODIFY it.
-- Uses information_schema + PREPARE/EXECUTE (runner uses a single
-- connection per migration file, so session state is preserved).
SET @plan_col_type := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'plan'
);

SET @plan_sql := CASE
  WHEN @plan_col_type IS NULL THEN
    'ALTER TABLE subscriptions ADD COLUMN plan ENUM(''monthly'',''yearly'',''admin_grant'') NOT NULL DEFAULT ''monthly'''
  WHEN @plan_col_type NOT LIKE '%admin_grant%' THEN
    'ALTER TABLE subscriptions MODIFY COLUMN plan ENUM(''monthly'',''yearly'',''admin_grant'') NOT NULL DEFAULT ''monthly'''
  ELSE
    'SELECT 1'
END;

PREPARE plan_stmt FROM @plan_sql;
EXECUTE plan_stmt;
DEALLOCATE PREPARE plan_stmt;

-- ── 4. Reconcile `status` ENUM (add CANCELLED) ──
-- adminController.cancel and paymentController.cancel set
-- status='CANCELLED', but v15 only defined ENUM('PENDING','COMPLETED','FAILED','REFUNDED').
SET @status_col_type := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'status'
);

SET @status_sql := CASE
  WHEN @status_col_type IS NULL THEN
    'ALTER TABLE subscriptions ADD COLUMN status ENUM(''PENDING'',''COMPLETED'',''FAILED'',''REFUNDED'',''CANCELLED'') NOT NULL DEFAULT ''PENDING'''
  WHEN @status_col_type NOT LIKE '%CANCELLED%' THEN
    'ALTER TABLE subscriptions MODIFY COLUMN status ENUM(''PENDING'',''COMPLETED'',''FAILED'',''REFUNDED'',''CANCELLED'') NOT NULL DEFAULT ''PENDING'''
  ELSE
    'SELECT 1'
END;

PREPARE status_stmt FROM @status_sql;
EXECUTE status_stmt;
DEALLOCATE PREPARE status_stmt;

-- ── 5. Ensure unique index on order_tracking_id exists ──
ALTER TABLE subscriptions ADD UNIQUE INDEX IF NOT EXISTS uniq_order_tracking (order_tracking_id);

-- ── 6. Verify ──
SELECT COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions'
ORDER BY ORDINAL_POSITION;
