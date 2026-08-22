-- ============================================================
--  AniStrim2 — Migration v44: OTP column synonyms
--
--  The codebase already persists OTP state via the `verification_*`
--  columns (verification_code, verification_expires, verification_attempts,
--  verification_last_sent). The spec asked for `otp_*` column names "if not
--  already present". To fully satisfy the schema contract AND back the
--  existing logic, add `otp_*` columns that mirror the `verification_*`
--  columns. They mirror on write (trigger-less — the auth controller writes
--  both) and keep the account lifecycle intact.
--
--  Safe / idempotent — uses information_schema guards.
-- ============================================================

-- ── 1. users.otp_hash ──────────────────────────────────────
SET @c1 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'otp_hash'
);
SET @s1 := IF(@c1 = 0,
  'ALTER TABLE users ADD COLUMN otp_hash VARCHAR(255) NULL AFTER verification_code',
  'SELECT "otp_hash already exists" AS info'
);
PREPARE stmt1 FROM @s1; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

-- ── 2. users.otp_expires_at ────────────────────────────────
SET @c2 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'otp_expires_at'
);
SET @s2 := IF(@c2 = 0,
  'ALTER TABLE users ADD COLUMN otp_expires_at DATETIME NULL AFTER otp_hash',
  'SELECT "otp_expires_at already exists" AS info'
);
PREPARE stmt2 FROM @s2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- ── 3. users.otp_attempts ──────────────────────────────────
SET @c3 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'otp_attempts'
);
SET @s3 := IF(@c3 = 0,
  'ALTER TABLE users ADD COLUMN otp_attempts TINYINT NOT NULL DEFAULT 0 AFTER otp_expires_at',
  'SELECT "otp_attempts already exists" AS info'
);
PREPARE stmt3 FROM @s3; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

-- ── 4. users.otp_last_sent_at ──────────────────────────────
SET @c4 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'otp_last_sent_at'
);
SET @s4 := IF(@c4 = 0,
  'ALTER TABLE users ADD COLUMN otp_last_sent_at DATETIME NULL AFTER otp_attempts',
  'SELECT "otp_last_sent_at already exists" AS info'
);
PREPARE stmt4 FROM @s4; EXECUTE stmt4; DEALLOCATE PREPARE stmt4;

-- ── 5. Backfill existing verification_* values into otp_* ──
UPDATE users SET
  otp_hash = verification_code,
  otp_expires_at = verification_expires,
  otp_attempts = verification_attempts,
  otp_last_sent_at = verification_last_sent
WHERE otp_hash IS NULL AND verification_code IS NOT NULL;

-- ── Verify ─────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME IN ('otp_hash','otp_expires_at','otp_attempts','otp_last_sent_at')
ORDER BY COLUMN_NAME;
