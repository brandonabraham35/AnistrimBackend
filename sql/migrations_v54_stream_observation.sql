-- ============================================================
--  AniStrim2 — Migration v54: Stream Observation & Lifetime Tracking
--
--  Adds columns for the stream observation system that empirically
--  determines CDN URL lifetimes by tracking direct and proxied
--  health checks over time.
--
--  New columns extend episode_stream_cache with:
--    observation fields for direct vs proxy comparison
--    enhanced URL fingerprinting
--    lifetime tracking
--    classification transitions
--
--  These complement the existing observation/classification columns
--  from migrations v51-v53.
-- ============================================================

-- Add direct-vs-proxy observation columns
ALTER TABLE episode_stream_cache
  ADD COLUMN IF NOT EXISTS last_direct_check_at DATETIME NULL
  COMMENT 'Last direct (skipProxy=true) health check timestamp.',
  ADD COLUMN IF NOT EXISTS last_direct_status INT NULL
  COMMENT 'HTTP status from last direct health check.',
  ADD COLUMN IF NOT EXISTS last_proxy_check_at DATETIME NULL
  COMMENT 'Last proxy (skipProxy=false) health check timestamp.',
  ADD COLUMN IF NOT EXISTS last_proxy_status INT NULL
  COMMENT 'HTTP status from last proxy health check.',
  ADD COLUMN IF NOT EXISTS last_check_path VARCHAR(10) NULL
  COMMENT 'DIRECT or PROXY — which path was used for the most recent check.',
  ADD COLUMN IF NOT EXISTS last_check_duration_ms INT NULL
  COMMENT 'Response time in ms for the most recent health check.',
  ADD COLUMN IF NOT EXISTS last_check_content_type VARCHAR(128) NULL
  COMMENT 'Content-Type from the most recent health check.';

-- Add rotation tracking columns
ALTER TABLE episode_stream_cache
  ADD COLUMN IF NOT EXISTS original_host VARCHAR(255) NULL
  COMMENT 'CDN host from the first resolution of this cache row.',
  ADD COLUMN IF NOT EXISTS current_host VARCHAR(255) NULL
  COMMENT 'CDN host from the most recent resolution.',
  ADD COLUMN IF NOT EXISTS host_changed_at DATETIME NULL
  COMMENT 'When the CDN host last changed.',
  ADD COLUMN IF NOT EXISTS token_changed_at DATETIME NULL
  COMMENT 'When the CDN token last changed.',
  ADD COLUMN IF NOT EXISTS rotation_count INT NOT NULL DEFAULT 0
  COMMENT 'Number of observed URL rotations.';

-- Add lifetime/expiry evidence columns
ALTER TABLE episode_stream_cache
  ADD COLUMN IF NOT EXISTS url_observed_lifetime_seconds INT NULL
  COMMENT 'Longest observed period this exact URL was confirmed alive.',
  ADD COLUMN IF NOT EXISTS url_first_failure_at DATETIME NULL
  COMMENT 'First time this exact URL was observed to fail.',
  ADD COLUMN IF NOT EXISTS url_last_failure_at DATETIME NULL
  COMMENT 'Most recent failure for this exact URL.',
  ADD COLUMN IF NOT EXISTS url_failure_count INT NOT NULL DEFAULT 0
  COMMENT 'How many times this exact URL has been observed to fail.',
  ADD COLUMN IF NOT EXISTS probe_playback_match_count INT NOT NULL DEFAULT 0
  COMMENT 'Count of observations where probe and playback agreed.',
  ADD COLUMN IF NOT EXISTS probe_false_positive_count INT NOT NULL DEFAULT 0
  COMMENT 'Count of observations where probe=PASS but playback=FAIL.',
  ADD COLUMN IF NOT EXISTS probe_false_negative_count INT NOT NULL DEFAULT 0
  COMMENT 'Count of observations where probe=FAIL but playback=PASS.';

-- Verify columns were added
DESCRIBE episode_stream_cache;