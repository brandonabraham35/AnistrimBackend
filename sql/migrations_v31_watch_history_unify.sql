-- ============================================================
--  AniStrim2 — Migration v31: Watch History Unification
--
--  Phase 3: Kill the dual watch_history model. The legacy tables
--  keyed on (anime_id VARCHAR, episode_number) and the schema.sql
--  table keyed on episode_id converge into one authoritative
--  `watch_progress` table keyed on episode_id.
--
--  Steps:
--    1. Create watch_progress (authoritative, keyed on episode_id).
--    2. Create watch_dismissed (user dismisses an anime from the CW rail).
--    3. Migrate legacy watch_history rows in, resolving
--       (anime_id, episode_number) → episodes.id; drop unresolvable rows.
--    4. Rename the legacy tables to _legacy_ for a two-week retention window.
-- ============================================================

-- ── 1. Authoritative watch_progress table ─────────────────
CREATE TABLE IF NOT EXISTS watch_progress (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL,
  anime_id       INT NOT NULL,
  episode_id     INT NOT NULL,
  season_number  SMALLINT NOT NULL DEFAULT 1,
  episode_number SMALLINT NOT NULL,
  position_sec   INT NOT NULL DEFAULT 0,
  duration_sec   INT NOT NULL DEFAULT 0,
  percent        DECIMAL(5,2) AS (IF(duration_sec>0, LEAST(100, position_sec*100/duration_sec), 0)) STORED,
  completed      TINYINT(1) NOT NULL DEFAULT 0,
  completed_at   DATETIME DEFAULT NULL,
  device         VARCHAR(20) DEFAULT NULL,
  started_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq (user_id, episode_id),
  INDEX idx_cw (user_id, updated_at),
  INDEX idx_user_anime (user_id, anime_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 2. watch_dismissed table ──────────────────────────────
CREATE TABLE IF NOT EXISTS watch_dismissed (
  user_id      INT NOT NULL,
  anime_id     INT NOT NULL,
  dismissed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, anime_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── 3. Migrate legacy rows from watch_history ──────────────
-- The legacy table (v11) has columns:
--   id, user_id, anime_id (VARCHAR), episode_number, progress_seconds,
--   total_duration_seconds, updated_at, and optionally episode_id (v20).
-- We resolve (anime_id, episode_number) → episodes.id and keep rows that
-- resolve. Rows that can't resolve are dropped (per spec).

-- Only run if the legacy watch_history table exists.
SET @has_wh := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'watch_history'
);

SET @migrate_sql := IF(@has_wh > 0,
    'INSERT IGNORE INTO watch_progress
       (user_id, anime_id, episode_id, season_number, episode_number, position_sec, duration_sec, completed, updated_at)
     SELECT
       wh.user_id,
       e.anime_id,
       e.id AS episode_id,
       1 AS season_number,
       wh.episode_number,
       COALESCE(wh.progress_seconds, 0) AS position_sec,
       COALESCE(wh.total_duration_seconds, 0) AS duration_sec,
       CASE WHEN COALESCE(wh.total_duration_seconds, 0) > 0
              AND COALESCE(wh.progress_seconds, 0) >= COALESCE(wh.total_duration_seconds, 0) * 0.95
            THEN 1 ELSE 0 END AS completed,
       COALESCE(wh.updated_at, NOW()) AS updated_at
     FROM watch_history wh
     JOIN episodes e ON e.anime_id = CAST(wh.anime_id AS UNSIGNED)
                     AND e.episode_number = wh.episode_number
     ON DUPLICATE KEY UPDATE
       position_sec   = GREATEST(watch_progress.position_sec, VALUES(position_sec)),
       duration_sec   = VALUES(duration_sec),
       completed      = VALUES(completed),
       completed_at   = IF(VALUES(completed)=1, COALESCE(watch_progress.completed_at, NOW()), watch_progress.completed_at),
       updated_at     = GREATEST(watch_progress.updated_at, VALUES(updated_at))',
    'SELECT "watch_history table does not exist — skipping migration" AS info'
);
PREPARE stmt FROM @migrate_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 4. Rename legacy table to _legacy_ (two-week retention) ──
SET @has_wh2 := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'watch_history'
);
SET @rename_sql := IF(@has_wh2 > 0,
    'RENAME TABLE watch_history TO watch_history_legacy_',
    'SELECT "watch_history already renamed" AS info'
);
PREPARE stmt2 FROM @rename_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── Verify ─────────────────────────────────────────────────
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('watch_progress','watch_dismissed') ORDER BY TABLE_NAME;

