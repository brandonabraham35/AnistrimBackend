-- ============================================================
--  AniStrim2 — Migration v34: Recommendations (Phase 6.3)
--
--  user_recommendations: materialised per-user rows written by the nightly
--    rebuild (node-cron). Homepage reads this single indexed table.
--  user_genre_vector: per-user genre affinity (completed-minutes, decayed
--    with a 30-day half-life), normalised.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_recommendations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  anime_id INT NOT NULL,
  score DECIMAL(8,5) NOT NULL,
  reason VARCHAR(255) DEFAULT NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq (user_id, anime_id),
  INDEX idx_user_score (user_id, score DESC),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_genre_vector (
  user_id INT PRIMARY KEY,
  vector JSON NOT NULL,                       -- { "Action": 0.42, "Fantasy": 0.30, ... } normalised
  last_decay_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user_recommendations','user_genre_vector') ORDER BY TABLE_NAME;
