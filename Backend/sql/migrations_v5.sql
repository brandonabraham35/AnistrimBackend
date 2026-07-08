-- migrations_v5.sql
USE anistrim2;

-- 1. Update episodes table for Bunny Stream integration
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS bunny_video_id VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS video_status   VARCHAR(50)  DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS playback_url   TEXT         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS embed_url      TEXT         DEFAULT NULL;

-- 2. Update anime table
ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT NULL;

-- 3. Update users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status ENUM('active', 'banned') NOT NULL DEFAULT 'active';

-- 4. Create activity_logs table
CREATE TABLE IF NOT EXISTS activity_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT             NOT NULL,
  action      VARCHAR(255)    NOT NULL,
  target_type VARCHAR(80)     DEFAULT NULL,
  target_id   INT             DEFAULT NULL,
  details     TEXT            DEFAULT NULL,
  ip_address  VARCHAR(45)     DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Create settings table
CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(100) PRIMARY KEY,
  `value`     TEXT,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 6. Create ads table
CREATE TABLE IF NOT EXISTS ads (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(255)    NOT NULL,
  type        ENUM('banner', 'video') NOT NULL DEFAULT 'banner',
  image_url   VARCHAR(500)    DEFAULT NULL,
  video_url   VARCHAR(500)    DEFAULT NULL,
  target_url  VARCHAR(500)    DEFAULT NULL,
  frequency   INT             NOT NULL DEFAULT 1,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  target_free_only TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 7. Seed initial settings
INSERT IGNORE INTO settings (`key`, `value`) VALUES
('site_name', 'AniStrim'),
('maintenance_mode', '0'),
('premium_price_monthly', '15000'),
('premium_price_yearly', '180000'),
('contact_email', 'support@anistrim.com'),
('announcement', 'Welcome to the upgraded AniStrim!'),
('bunny_cdn_hostname', 'https://anistrim.b-cdn.net');
