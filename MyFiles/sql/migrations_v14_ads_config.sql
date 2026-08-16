-- Remote monetization configuration. The singleton row is always id = 1.
CREATE TABLE IF NOT EXISTS ads_config (
  id INT PRIMARY KEY,
  banner_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interstitial_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interstitial_clicks_between INT NOT NULL DEFAULT 3,
  pre_roll_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO ads_config (id) VALUES (1)
ON DUPLICATE KEY UPDATE id = VALUES(id);
