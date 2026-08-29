-- ============================================================
--  AniStrim2 — Migration v53: Stream Source Classification
--
--  Adds classification and observation metadata to the existing
--  episode_stream_cache table.
--
--  Compatible with MySQL 5.7+ (no ADD COLUMN IF NOT EXISTS).
--  Each column is added with its own ALTER TABLE statement so
--  that already-existing columns are skipped without aborting
--  the entire migration.
--
--  Classification fields:
--    url_classification          — TEMPORARY / UNKNOWN / STABLE
--    classification_confidence   — LOW / MEDIUM / HIGH
--    classification_reason       — Human-readable explanation
--
--  Observation fields:
--    observed_first_success_at   — First time verified alive
--    observed_last_success_at    — Most recent successful verification
--    observed_first_failure_at   — First time verification failed
--    observed_lifetime_seconds   — Seconds between first and last success
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v53_stream_classification.sql
-- ============================================================

-- url_classification
ALTER TABLE episode_stream_cache
  ADD COLUMN url_classification VARCHAR(20) NULL
  COMMENT 'TEMPORARY/UNKNOWN/STABLE — evidence-based URL lifetime classification.';

-- classification_confidence
ALTER TABLE episode_stream_cache
  ADD COLUMN classification_confidence VARCHAR(10) NULL
  COMMENT 'LOW/MEDIUM/HIGH — confidence in the classification.';

-- classification_reason
ALTER TABLE episode_stream_cache
  ADD COLUMN classification_reason TEXT NULL
  COMMENT 'Human-readable explanation of the classification.';

-- observed_first_success_at
ALTER TABLE episode_stream_cache
  ADD COLUMN observed_first_success_at DATETIME NULL
  COMMENT 'First time the source was verified alive (HEAD/Range 2xx).';

-- observed_last_success_at
ALTER TABLE episode_stream_cache
  ADD COLUMN observed_last_success_at DATETIME NULL
  COMMENT 'Most recent successful verification timestamp.';

-- observed_first_failure_at
ALTER TABLE episode_stream_cache
  ADD COLUMN observed_first_failure_at DATETIME NULL
  COMMENT 'First time the source failed verification (403/404).';

-- observed_lifetime_seconds
ALTER TABLE episode_stream_cache
  ADD COLUMN observed_lifetime_seconds INT NULL
  COMMENT 'Seconds between first_success_at and last_success_at.';

-- Index on url_classification
ALTER TABLE episode_stream_cache
  ADD INDEX idx_url_classification (url_classification);

-- Verify the columns were added.
DESCRIBE episode_stream_cache;