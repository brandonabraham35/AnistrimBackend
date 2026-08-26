-- ============================================================
--  AniStrim2 — Migration v50: Unified Cross-Platform Analytics
--
--  Adds centralized analytics infrastructure:
--    1. analytics_events table for granular event tracking
--    2. client_platform column on watch_progress
--    3. last_platform column on users
--    4. Composite indexes for efficient analytics queries
--
--  All platforms (Web, Mobile, Desktop) share the same user_id
--  and contribute to the same analytics. The X-Client header
--  (web|mobile|desktop) determines the platform attribution.
--
--  Safe / idempotent: uses information_schema guards throughout.
-- ============================================================

-- ── 1. analytics_events table ──────────────────────────────
SET @table_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'analytics_events'
);

SET @create_sql := IF(@table_exists = 0,
    'CREATE TABLE analytics_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT DEFAULT NULL,
        event_type VARCHAR(40) NOT NULL,
        client_platform VARCHAR(20) NOT NULL DEFAULT ''unknown'',
        session_id VARCHAR(64) DEFAULT NULL,
        anime_id INT DEFAULT NULL,
        episode_id INT DEFAULT NULL,
        metadata JSON DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_event (user_id, event_type, created_at),
        INDEX idx_platform (client_platform, created_at),
        INDEX idx_anime (anime_id, event_type, created_at),
        INDEX idx_episode (episode_id, event_type, created_at),
        INDEX idx_type_date (event_type, created_at)
    ) ENGINE=InnoDB',
    'SELECT "analytics_events table already exists" AS info'
);

PREPARE stmt FROM @create_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. client_platform on watch_progress ───────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'watch_progress'
      AND COLUMN_NAME  = 'client_platform'
);

SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE watch_progress ADD COLUMN client_platform VARCHAR(20) NOT NULL DEFAULT ''unknown''',
    'SELECT "watch_progress.client_platform column already exists" AS info'
);

PREPARE stmt2 FROM @alter_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── 3. last_platform on users ──────────────────────────────
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'last_platform'
);

SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE users ADD COLUMN last_platform VARCHAR(20) DEFAULT NULL',
    'SELECT "users.last_platform column already exists" AS info'
);

PREPARE stmt3 FROM @alter_sql2;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ── 4. Verify ─────────────────────────────────────────────
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'analytics_events';

SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'watch_progress'
  AND COLUMN_NAME = 'client_platform';

SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME = 'last_platform';
