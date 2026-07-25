-- ============================================================
--  Migration v15: Subscriptions Table for Pesapal Payments
--  Run this in MySQL Workbench or via your migration runner
-- ============================================================

-- 1. Create the subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT             NOT NULL,
  reference     VARCHAR(191)    NOT NULL UNIQUE,       -- Merchant reference (tx_ref)
  amount        DECIMAL(10,2)   NOT NULL,
  currency      VARCHAR(10)     NOT NULL DEFAULT 'UGX',
  status        ENUM('PENDING','COMPLETED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  plan          ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  order_tracking_id VARCHAR(191) DEFAULT NULL,         -- Pesapal order tracking ID
  payment_method   VARCHAR(80)  DEFAULT NULL,
  paid_at       DATETIME        DEFAULT NULL,
  expires_at    DATETIME        DEFAULT NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_reference (reference),
  INDEX idx_status (status),
  INDEX idx_order_tracking (order_tracking_id)
) ENGINE=InnoDB;

-- 2. Ensure users table has the required premium columns
--    (Already exists in schema.sql, but we add IF NOT EXISTS for safety)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_premium TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS premium_expires_at DATETIME DEFAULT NULL;

