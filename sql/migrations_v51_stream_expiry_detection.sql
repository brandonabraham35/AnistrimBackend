-- ============================================================
--  AniStrim2 — Migration v51: Stream Source Expiry Detection
--
--  Extends the existing episode_stream_cache table with upstream
--  source expiry detection fields. This does NOT change existing
--  expires_at semantics (which represents AniStrim's cache TTL).
--
--  New columns:
--    detected_expires_at — expiry parsed from upstream source URL or response
--    expiry_source       — how the expiry was determined (url, header, unknown)
--    verification_status — current health state of the cached source
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v51_stream_expiry_detection.sql
-- ============================================================

-- Add expiry detection columns to the existing episode_stream_cache table.
ALTER TABLE episode_stream_cache
  ADD COLUMN IF NOT EXISTS detected_expires_at DATETIME NULL
    COMMENT 'Expiry parsed from upstream source URL or response headers. NULL = unknown.',
  ADD COLUMN IF NOT EXISTS expiry_source VARCHAR(20) NOT NULL DEFAULT 'unknown'
    COMMENT 'How expiry was determined: url, header, unknown.',
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'unknown'
    COMMENT 'Current health: active, expired, invalid, unknown.',
  ADD INDEX IF NOT EXISTS idx_detected_expires_at (detected_expires_at),
  ADD INDEX IF NOT EXISTS idx_verification_status (verification_status);

-- Verify the columns were added.
DESCRIBE episode_stream_cache;
