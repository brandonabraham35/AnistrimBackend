-- ============================================================
--  AniStrim2 — Migration v29: Identity & Account Lifecycle
--
--  Adds the account lifecycle columns to users, plus the
--  session / login-history / email-change tables.
--
--  Safe / idempotent — uses information_schema guards.
-- ============================================================
USE anistrim2;

-- ── 1. users.username ───────────────────────────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'username'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE users ADD COLUMN username VARCHAR(32) UNIQUE DEFAULT NULL AFTER name',
    'SELECT "username column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. users.display_name ───────────────────────────────────
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'display_name'
);
SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE users ADD COLUMN display_name VARCHAR(80) DEFAULT NULL AFTER username',
    'SELECT "display_name column already exists" AS info'
);
PREPARE stmt2 FROM @alter_sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── 3. users.email_verified_at ──────────────────────────────
SET @col_exists3 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'email_verified_at'
);
SET @alter_sql3 := IF(@col_exists3 = 0,
    'ALTER TABLE users ADD COLUMN email_verified_at DATETIME DEFAULT NULL AFTER email',
    'SELECT "email_verified_at column already exists" AS info'
);
PREPARE stmt3 FROM @alter_sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ── 4. users.status ─────────────────────────────────────────
SET @col_exists4 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'status'
);
SET @alter_sql4 := IF(@col_exists4 = 0,
    "ALTER TABLE users ADD COLUMN status ENUM('pending','active','suspended','deactivated','deleted') NOT NULL DEFAULT 'pending' AFTER is_verified",
    'SELECT "status column already exists" AS info'
);
PREPARE stmt4 FROM @alter_sql4;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- ── 5. users.status_reason ──────────────────────────────────
SET @col_exists5 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'status_reason'
);
SET @alter_sql5 := IF(@col_exists5 = 0,
    'ALTER TABLE users ADD COLUMN status_reason VARCHAR(255) DEFAULT NULL AFTER status',
    'SELECT "status_reason column already exists" AS info'
);
PREPARE stmt5 FROM @alter_sql5;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- ── 6. users.auth_provider ──────────────────────────────────
SET @col_exists6 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'auth_provider'
);
SET @alter_sql6 := IF(@col_exists6 = 0,
    "ALTER TABLE users ADD COLUMN auth_provider ENUM('password','google','both') NOT NULL DEFAULT 'password' AFTER status_reason",
    'SELECT "auth_provider column already exists" AS info'
);
PREPARE stmt6 FROM @alter_sql6;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

-- ── 7. users.last_login_at ──────────────────────────────────
SET @col_exists7 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'last_login_at'
);
SET @alter_sql7 := IF(@col_exists7 = 0,
    'ALTER TABLE users ADD COLUMN last_login_at DATETIME DEFAULT NULL AFTER auth_provider',
    'SELECT "last_login_at column already exists" AS info'
);
PREPARE stmt7 FROM @alter_sql7;
EXECUTE stmt7;
DEALLOCATE PREPARE stmt7;

-- ── 8. users.onboarded_at ───────────────────────────────────
SET @col_exists8 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'onboarded_at'
);
SET @alter_sql8 := IF(@col_exists8 = 0,
    'ALTER TABLE users ADD COLUMN onboarded_at DATETIME DEFAULT NULL AFTER last_login_at',
    'SELECT "onboarded_at column already exists" AS info'
);
PREPARE stmt8 FROM @alter_sql8;
EXECUTE stmt8;
DEALLOCATE PREPARE stmt8;

-- ── 9. users.token_version ──────────────────────────────────
SET @col_exists9 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'token_version'
);
SET @alter_sql9 := IF(@col_exists9 = 0,
    'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER onboarded_at',
    'SELECT "token_version column already exists" AS info'
);
PREPARE stmt9 FROM @alter_sql9;
EXECUTE stmt9;
DEALLOCATE PREPARE stmt9;

-- ── 10. users.deleted_at ────────────────────────────────────
SET @col_exists10 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'anistrim2'
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'deleted_at'
);
SET @alter_sql10 := IF(@col_exists10 = 0,
    'ALTER TABLE users ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER token_version',
    'SELECT "deleted_at column already exists" AS info'
);
PREPARE stmt10 FROM @alter_sql10;
EXECUTE stmt10;
DEALLOCATE PREPARE stmt10;

-- ── 11. user_sessions table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id             CHAR(36) PRIMARY KEY,          -- session id (uuid), goes in JWT as `sid`
  user_id        INT NOT NULL,
  refresh_hash   CHAR(64) NOT NULL,             -- sha256 of refresh token
  device_name    VARCHAR(120),
  platform       ENUM('web','android','ios','unknown') NOT NULL DEFAULT 'unknown',
  user_agent     VARCHAR(255),
  ip_hash        CHAR(64),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     DATETIME NOT NULL,
  revoked_at     DATETIME DEFAULT NULL,
  INDEX idx_user (user_id),
  INDEX idx_refresh (refresh_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 12. login_history table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS login_history (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  event      ENUM('login_success','login_failed','logout','password_reset',
                  'email_changed','google_login','session_revoked') NOT NULL,
  provider   VARCHAR(20),
  ip_hash    CHAR(64),
  user_agent VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at)
) ENGINE=InnoDB;

-- ── 13. email_change_requests table ─────────────────────────
CREATE TABLE IF NOT EXISTS email_change_requests (
  id CHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  new_email VARCHAR(191) NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 14. Backfill: existing verified users become active ─────
UPDATE users SET status = 'active', email_verified_at = created_at WHERE is_verified = 1;

-- ── 15. Backfill: auth_provider from existing state ─────────
UPDATE users SET auth_provider = 'google' WHERE google_id IS NOT NULL AND password_hash IS NULL;
UPDATE users SET auth_provider = 'both'   WHERE google_id IS NOT NULL AND password_hash IS NOT NULL;

-- ── 16. Verify ──────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'anistrim2'
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME IN ('username','display_name','email_verified_at','status','status_reason',
                      'auth_provider','last_login_at','onboarded_at','token_version','deleted_at')
ORDER BY COLUMN_NAME;