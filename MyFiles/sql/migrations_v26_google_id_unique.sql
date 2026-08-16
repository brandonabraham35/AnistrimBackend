-- Migration V26: UNIQUE index on users.google_id
-- Closes the TOCTOU race on Google auto-provisioning so a rapid double-tap can
-- never create duplicate rows via the google_id lookup branch.
-- MySQL allows multiple NULL google_id values, so manual users are unaffected.
-- Idempotent (mirrors the V25 INFORMATION_SCHEMA pattern).

-- 1. Null out pre-existing duplicate google_id values (keep the lowest id).
--    Plain inline UPDATE (no correlated subquery inside a derived table, which
--    MySQL rejects when it is run through PREPARE).
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

-- 2. Drop the old non-unique index on google_id, if present.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_google' AND NON_UNIQUE = 1
);
SET @drop_sql := IF(@idx_exists > 0,
  'ALTER TABLE users DROP INDEX idx_google',
  'SELECT 1'
);
PREPARE stmt FROM @drop_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add a UNIQUE index on google_id, if not already present.
SET @uniq_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'uq_users_google_id'
);
SET @uniq_sql := IF(@uniq_exists = 0,
  'ALTER TABLE users ADD UNIQUE INDEX uq_users_google_id (google_id)',
  'SELECT 1'
);
PREPARE stmt2 FROM @uniq_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;