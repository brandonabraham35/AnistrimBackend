-- ============================================================
--  AniStrim2 — Migration v30: User Preferences & Profile
--
--  Adds the user_preferences table storing per-user playback and
--  display preferences, seeded into the canonical DTO/onboarding.
-- ============================================================
USE anistrim2;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INT PRIMARY KEY,
  genres JSON,
  autoplay_next TINYINT(1) DEFAULT 1,
  autoplay_countdown INT DEFAULT 10,
  default_quality VARCHAR(10) DEFAULT 'auto',
  subtitles_on TINYINT(1) DEFAULT 1,
  subtitle_lang VARCHAR(10) DEFAULT 'en',
  playback_rate DECIMAL(3,2) DEFAULT 1.00,
  skip_intro_auto TINYINT(1) DEFAULT 0,
  reduce_motion TINYINT(1) DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify (schema-agnostic — uses the connected database, not a hard-coded name)
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'user_preferences'
ORDER BY ORDINAL_POSITION;
