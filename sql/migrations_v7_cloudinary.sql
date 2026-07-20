-- Cloudinary media-provider migration. Safe and non-destructive.
USE anistrim2;

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS cloudinary_public_id VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS thumbnail_public_id VARCHAR(255) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_episodes_cloudinary_public_id (cloudinary_public_id);

ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS cover_public_id VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_public_id VARCHAR(255) DEFAULT NULL;
