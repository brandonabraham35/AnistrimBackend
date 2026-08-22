-- ============================================================
--  AniStrim2 — Migration v25: Manual Registration Email Verification
--
--  Adds the columns needed for strict OTP-based email verification
--  on manual (email/password) signups, plus anti-abuse fields:
--
--    • users.is_verified             — TINYINT(1), default 0 (false)
--    • users.verification_code       — VARCHAR(6), the 6-digit OTP
--    • users.verification_expires    — DATETIME, when the OTP expires
--    • users.verification_attempts   — TINYINT, failed OTP attempts (lockout)
--    • users.verification_last_sent  — DATETIME, throttle for resend
--    • UNIQUE KEY on users.email     — closes the signup TOCTOU race
--    • INDEX on (email, verification_expires)
--
--  Existing Google-only users and admins are marked verified so they are
--  not locked out by the new gate.
--
--  Safe / idempotent — uses information_schema guards.
-- ============================================================

-- ── 1. users.is_verified ─────────────────────────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'is_verified'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE users ADD COLUMN is_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER is_premium',
    'SELECT "is_verified column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. users.verification_code ───────────────────────────────
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'verification_code'
);
SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE users ADD COLUMN verification_code VARCHAR(6) DEFAULT NULL AFTER is_verified',
    'SELECT "verification_code column already exists" AS info'
);
PREPARE stmt2 FROM @alter_sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── 3. users.verification_expires ────────────────────────────
SET @col_exists3 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'verification_expires'
);
SET @alter_sql3 := IF(@col_exists3 = 0,
    'ALTER TABLE users ADD COLUMN verification_expires DATETIME DEFAULT NULL AFTER verification_code',
    'SELECT "verification_expires column already exists" AS info'
);
PREPARE stmt3 FROM @alter_sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ── 4. users.verification_attempts (OTP lockout) ─────────────
SET @col_exists4 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'verification_attempts'
);
SET @alter_sql4 := IF(@col_exists4 = 0,
    'ALTER TABLE users ADD COLUMN verification_attempts TINYINT NOT NULL DEFAULT 0 AFTER verification_expires',
    'SELECT "verification_attempts column already exists" AS info'
);
PREPARE stmt4 FROM @alter_sql4;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- ── 5. users.verification_last_sent (resend throttle) ────────
SET @col_exists5 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'verification_last_sent'
);
SET @alter_sql5 := IF(@col_exists5 = 0,
    'ALTER TABLE users ADD COLUMN verification_last_sent DATETIME DEFAULT NULL AFTER verification_attempts',
    'SELECT "verification_last_sent column already exists" AS info'
);
PREPARE stmt5 FROM @alter_sql5;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- ── 6. UNIQUE KEY on users.email (closes signup race) ────────
SET @key_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND INDEX_NAME   = 'uniq_users_email'
);
SET @key_sql := IF(@key_exists = 0,
    'ALTER TABLE users ADD UNIQUE KEY uniq_users_email (email)',
    'SELECT "uniq_users_email key already exists" AS info'
);
PREPARE stmt6 FROM @key_sql;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

-- ── 7. INDEX on (email, verification_expires) ────────────────
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND INDEX_NAME   = 'idx_users_verification'
);
SET @idx_sql := IF(@idx_exists = 0,
    'CREATE INDEX idx_users_verification ON users (email, verification_expires)',
    'SELECT "idx_users_verification index already exists" AS info'
);
PREPARE stmt7 FROM @idx_sql;
EXECUTE stmt7;
DEALLOCATE PREPARE stmt7;

-- ── 8. Mark Google-only users and admins as verified ─────────
UPDATE users SET is_verified = 1 WHERE password_hash IS NULL OR is_admin = 1;

-- ── 9. Verify ────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME IN ('is_verified', 'verification_code', 'verification_expires', 'verification_attempts', 'verification_last_sent')
ORDER BY COLUMN_NAME;
