-- ============================================================
--  AniStrim2 — Migration v38: Phase 1 Reconciliation
--
--  Fixes drift between migrations/002 (VARCHAR(20) DEFAULT 'local')
--  and sql/migrations_v29 (ENUM('password','google','both')).
--  Also moves v26's UNIQUE google_id index here so it is applied
--  even if v26 was skipped, and adds the `attempts` column to
--  email_change_requests for OTP lockout on email change.
--
--  Safe / idempotent — uses information_schema guards.
-- ============================================================

-- ── 1. Reconcile auth_provider to the Phase-1 ENUM ──────────
SET @col_type := (
    SELECT COLUMN_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'auth_provider'
);
SET @alter_sql := IF(
    @col_type IS NULL OR @col_type NOT LIKE '%enum%',
    "ALTER TABLE users MODIFY auth_provider ENUM('password','google','both') NOT NULL DEFAULT 'password'",
    'SELECT "auth_provider already ENUM" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. Migrate legacy 'local' values to 'password' ──────────
UPDATE users SET auth_provider = 'password' WHERE auth_provider = 'local';

-- ── 3. UNIQUE index on google_id (moved from v26) ───────────
-- Drop the old non-unique index if present.
SET @idx_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
      AND INDEX_NAME = 'idx_users_google_id' AND NON_UNIQUE = 1
);
SET @drop_sql := IF(@idx_exists > 0,
    'ALTER TABLE users DROP INDEX idx_users_google_id',
    'SELECT 1'
);
PREPARE stmt2 FROM @drop_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- Null out pre-existing duplicate google_id values (keep the lowest id).
UPDATE users u
JOIN (
  SELECT google_id, MIN(id) AS keep_id
  FROM users
  WHERE google_id IS NOT NULL
  GROUP BY google_id
  HAVING COUNT(*) > 1
) d ON d.google_id = u.google_id
SET u.google_id = NULL
WHERE u.id <> d.keep_id;

-- Add the UNIQUE index if not already present.
SET @uniq_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
      AND INDEX_NAME = 'uq_users_google_id'
);
SET @uniq_sql := IF(@uniq_exists = 0,
    'ALTER TABLE users ADD UNIQUE INDEX uq_users_google_id (google_id)',
    'SELECT 1'
);
PREPARE stmt3 FROM @uniq_sql;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ── 4. email_change_requests.attempts (OTP lockout) ─────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'email_change_requests'
      AND COLUMN_NAME  = 'attempts'
);
SET @alter_sql2 := IF(@col_exists = 0,
    'ALTER TABLE email_change_requests ADD COLUMN attempts INT NOT NULL DEFAULT 0 AFTER otp_hash',
    'SELECT "attempts column already exists" AS info'
);
PREPARE stmt4 FROM @alter_sql2;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- ── 5. Widen verification_code to CHAR(64) for hashed OTPs ──
SET @col_type2 := (
    SELECT COLUMN_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'verification_code'
);
SET @alter_sql3 := IF(
    @col_type2 IS NULL OR @col_type2 NOT LIKE '%char(64)%',
    'ALTER TABLE users MODIFY verification_code CHAR(64) NULL',
    'SELECT "verification_code already CHAR(64)" AS info'
);
PREPARE stmt5 FROM @alter_sql3;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- Null out any existing plaintext codes (they are now invalid).
UPDATE users SET verification_code = NULL WHERE verification_code IS NOT NULL AND CHAR_LENGTH(verification_code) < 64;

-- ── 6. Add new login_history event types ────────────────────
SET @col_type3 := (
    SELECT COLUMN_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'login_history'
      AND COLUMN_NAME  = 'event'
);
SET @alter_sql4 := IF(
    @col_type3 IS NULL OR @col_type3 NOT LIKE '%password_changed%',
    "ALTER TABLE login_history MODIFY event ENUM('login_success','login_failed','logout','password_reset','email_changed','google_login','session_revoked','password_changed','account_deactivated','account_deleted') NOT NULL",
    'SELECT "login_history event enum already extended" AS info'
);
PREPARE stmt6 FROM @alter_sql4;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

-- ── 7. Verify ───────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME IN ('auth_provider','verification_code')
ORDER BY COLUMN_NAME;
