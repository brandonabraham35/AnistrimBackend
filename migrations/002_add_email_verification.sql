-- ============================================================
-- 002_add_email_verification.sql
-- Adds email-verification and Google-account columns to `users`.
-- Safe to re-run: every ALTER is guarded by an information_schema
-- check and executed via PREPARE, so it works on any MySQL version
-- (no reliance on ADD COLUMN IF NOT EXISTS, which is MariaDB-only).
-- ============================================================

-- 1. is_verified
SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_verified');
SET @s1 := IF(@c1 = 0,
  'ALTER TABLE users ADD COLUMN is_verified TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE p1 FROM @s1; EXECUTE p1; DEALLOCATE PREPARE p1;

-- 2. verification_code
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'verification_code');
SET @s2 := IF(@c2 = 0,
  'ALTER TABLE users ADD COLUMN verification_code VARCHAR(10) NULL',
  'SELECT 1');
PREPARE p2 FROM @s2; EXECUTE p2; DEALLOCATE PREPARE p2;

-- 3. verification_expires
SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'verification_expires');
SET @s3 := IF(@c3 = 0,
  'ALTER TABLE users ADD COLUMN verification_expires DATETIME NULL',
  'SELECT 1');
PREPARE p3 FROM @s3; EXECUTE p3; DEALLOCATE PREPARE p3;

-- 4. verification_attempts
SET @c4 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'verification_attempts');
SET @s4 := IF(@c4 = 0,
  'ALTER TABLE users ADD COLUMN verification_attempts INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE p4 FROM @s4; EXECUTE p4; DEALLOCATE PREPARE p4;

-- 5. verification_last_sent
SET @c5 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'verification_last_sent');
SET @s5 := IF(@c5 = 0,
  'ALTER TABLE users ADD COLUMN verification_last_sent DATETIME NULL',
  'SELECT 1');
PREPARE p5 FROM @s5; EXECUTE p5; DEALLOCATE PREPARE p5;

-- 6. auth_provider (new - used by Google auto-provisioning)
SET @c6 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'auth_provider');
SET @s6 := IF(@c6 = 0,
  "ALTER TABLE users ADD COLUMN auth_provider VARCHAR(20) NOT NULL DEFAULT 'local'",
  'SELECT 1');
PREPARE p6 FROM @s6; EXECUTE p6; DEALLOCATE PREPARE p6;

-- 7. google_id
SET @c7 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'google_id');
SET @s7 := IF(@c7 = 0,
  'ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL',
  'SELECT 1');
PREPARE p7 FROM @s7; EXECUTE p7; DEALLOCATE PREPARE p7;

-- 8. Index on google_id (drop the old non-unique idx_google first if present)
SET @i1 := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_google' AND NON_UNIQUE = 1);
SET @s8 := IF(@i1 > 0,
  'ALTER TABLE users DROP INDEX idx_google',
  'SELECT 1');
PREPARE p8 FROM @s8; EXECUTE p8; DEALLOCATE PREPARE p8;

-- A UNIQUE key (uq_users_google_id) or this index already existing means we
-- should not add a duplicate non-unique index on google_id.
SET @i3 := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND (INDEX_NAME = 'uq_users_google_id' OR INDEX_NAME = 'idx_users_google_id'));
SET @s9 := IF(@i3 = 0,
  'ALTER TABLE users ADD INDEX idx_users_google_id (google_id)',
  'SELECT 1');
PREPARE p9 FROM @s9; EXECUTE p9; DEALLOCATE PREPARE p9;