-- ============================================================
--  AniStrim2 — Migration v32: Episode Markers (Skip Intro/Outro)
--
--  Phase 4.4 (Item 11): layered skip markers resolved by source
--  priority: admin → aniskip → provider → auto → none.
-- ============================================================

CREATE TABLE IF NOT EXISTS episode_markers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  episode_id INT NOT NULL,
  kind ENUM('intro','outro','recap') NOT NULL,
  start_sec INT NOT NULL,
  end_sec INT NOT NULL,
  source ENUM('admin','aniskip','provider','auto') NOT NULL,
  confidence DECIMAL(3,2) DEFAULT 1.00,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq (episode_id, kind, source),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'episode_markers';
