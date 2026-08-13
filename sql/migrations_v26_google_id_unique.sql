-- Migration V26: UNIQUE index on users.google_id
-- Closes the TOCTOU race on Google auto-provisioning so a rapid double-tap can
-- never create duplicate rows via the google_id lookup branch.
-- MySQL allows multiple NULL google_id values, so manual users are unaffected.
-- Idempotent (mirrors the V25 INFORMATION_SCHEMA pattern).

-- 1. Drop the old non-unique index on google_id, if present
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_google' AND NON_UNIQUE = 1
);
SET @drop_sql := IF(@idx_exists > 0,
  'ALTER TABLE users DROP INDEX idx_google',
  'SELECT "idx_google not found or already unique" AS info'
);
PREPARE stmt FROM @drop_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add a UNIQUE index on google_id, if not already present
SET @uniq_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'uq_users_google_id'
);
SET @uniq_sql := IF(@uniq_exists = 0,
  'ALTER TABLE users ADD UNIQUE INDEX uq_users_google_id (google_id)',
  'SELECT "uq_users_google_id already exists" AS info'
);
PREPARE stmt2 FROM @uniq_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. Null-out any pre-existing duplicate google_id values (would block step 2)
SET @dupe_sql := (
  SELECT IF(
    @uniq_exists = 0,
    'UPDATE users u JOIN (
       SELECT google_id FROM users
       WHERE google_id IS NOT NULL
       GROUP BY google_id HAVING COUNT(*) > 1
     ) d ON d.google_id = u.google_id
     SET u.google_id = NULL
     WHERE u.id > (SELECT MIN(id) FROM users WHERE google_id = u.google_id)',
    'SELECT "no dedupe needed" AS info'
  )
);
PREPARE stmt3 FROM @dupe_sql;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;