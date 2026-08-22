-- ============================================================
--  AniStrim2 — Migration v13: Broken Stream Reports
--  Users can report broken/malfunctioning video streams,
--  and administrators can review & resolve/dismiss reports
--  from the Admin Dashboard.
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v13_reports.sql
-- ============================================================


CREATE TABLE IF NOT EXISTS stream_reports (
  id              INT             AUTO_INCREMENT PRIMARY KEY,
  user_id         INT             NOT NULL,
  anime_id        VARCHAR(255)    NOT NULL,
  episode_number  INT             NOT NULL,
  issue_type      ENUM('BROKEN_VIDEO','AUDIO_ISSUE','SUBTITLE_ISSUE','WRONG_EPISODE','OTHER')
                                  NOT NULL DEFAULT 'BROKEN_VIDEO',
  status          ENUM('PENDING','RESOLVED','DISMISSED')
                                  NOT NULL DEFAULT 'PENDING',
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify
DESCRIBE stream_reports;


