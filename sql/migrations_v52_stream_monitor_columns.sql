-- ============================================================
--  AniStrim2 — Migration v52: Stream Source Monitor Columns
--
--  Adds columns required by the background stream source monitor
--  (services/streamSourceMonitor) to the episode_stream_cache table.
--
--  These columns track verification history so the monitor can:
--    - Skip recently-verified sources
--    - Record HTTP response details
--    - Track failure counts for alerting
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v52_stream_monitor_columns.sql
-- ============================================================

ALTER TABLE episode_stream_cache
  ADD COLUMN last_verified_at DATETIME NULL
    COMMENT 'When the source was last successfully verified (HEAD/Range probe).',
  ADD COLUMN response_status INT NULL
    COMMENT 'HTTP status code from last verification probe.',
  ADD COLUMN content_type VARCHAR(128) NULL
    COMMENT 'Content-Type header from last verification probe.',
  ADD COLUMN last_failed_at DATETIME NULL
    COMMENT 'When the source last failed verification.',
  ADD COLUMN failure_count INT NOT NULL DEFAULT 0
    COMMENT 'Consecutive verification failure count.',
  ADD INDEX idx_last_verified_at (last_verified_at),
  ADD INDEX idx_failure_count (failure_count);

-- Verify the columns were added.
DESCRIBE episode_stream_cache;
