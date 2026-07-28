-- Automated catalogue support. Existing administrator uploads remain unchanged.
-- For MySQL/MariaDB versions that do not support ADD COLUMN IF NOT EXISTS,
-- run `node scripts/migrateCatalogue.js` instead of executing this file directly.
USE anistrim2;

ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS source_provider VARCHAR(32) NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS source_id VARCHAR(191) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_slug VARCHAR(255) DEFAULT NULL,
  ADD UNIQUE INDEX IF NOT EXISTS uq_anime_source (source_provider, source_id),
  ADD INDEX IF NOT EXISTS idx_anime_created_at (created_at);

CREATE TABLE IF NOT EXISTS anime_mappings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kitsu_id VARCHAR(191) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  provider_slug VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_anime_mapping (kitsu_id, provider),
  INDEX idx_provider_slug (provider, provider_slug)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS anime_cache (
  cache_key VARCHAR(255) PRIMARY KEY,
  payload JSON NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_anime_cache_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS episode_cache LIKE anime_cache;
CREATE TABLE IF NOT EXISTS stream_cache LIKE anime_cache;
