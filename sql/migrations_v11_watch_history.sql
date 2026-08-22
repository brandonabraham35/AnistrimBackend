-- ============================================================
--  AniStrim2 — Migration v11: Watch History Table
--  Tracks per-episode video playback progress for "Resume Watching"
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v11_watch_history.sql
-- ============================================================

-- Create the watch_history table
CREATE TABLE IF NOT EXISTS watch_history (
  id                    INT             AUTO_INCREMENT PRIMARY KEY,
  user_id               INT             NOT NULL,
  anime_id              VARCHAR(255)    NOT NULL,
  episode_number        INT             NOT NULL,
  progress_seconds      INT             NOT NULL DEFAULT 0,
  total_duration_seconds INT            NOT NULL DEFAULT 0,
  updated_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_anime_episode (user_id, anime_id, episode_number),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify the table was created
DESCRIBE watch_history;


