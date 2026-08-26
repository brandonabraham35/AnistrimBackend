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
CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT DEFAULT NULL,
    event_type VARCHAR(40) NOT NULL,
    client_platform VARCHAR(20) NOT NULL DEFAULT 'unknown',
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
) ENGINE=InnoDB;

-- ── 2. client_platform on watch_progress ───────────────────
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS client_platform VARCHAR(20) NOT NULL DEFAULT 'unknown';

-- ── 3. last_platform on users ──────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_platform VARCHAR(20) DEFAULT NULL;

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
