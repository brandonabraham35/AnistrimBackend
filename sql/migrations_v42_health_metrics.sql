-- ============================================================
--  AniStrim2 — Migration v42: Health Metrics & Admin Widgets
--
--  Adds the per-request latency/status source (api_request_log), the
--  email-delivery event log (email_events), and optional provider /
--  episode_id columns on stream_reports so admin dashboard widgets can
--  aggregate:
--    1. Health history sparklines (health_samples, already exists)
--    2. p50/p95 latency + 5xx/total per hour (api_request_log)
--    3. Stream failures by provider + top failing episodes (stream_reports)
--    4. Failed payments by state/day (payment_events)
--    5. Email failures (email_events)
--
--  ALTERs are plain + idempotent-aware: the migration runner treats
--  ER_DUP_FIELDNAME / ER_DUP_KEYNAME / "already exists" as skips, so this
--  file is safe to re-run.
-- ============================================================
USE anistrim2;

-- ── Per-request latency + status source ─────────────────────
CREATE TABLE IF NOT EXISTS api_request_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  method VARCHAR(10)  NOT NULL,
  path   VARCHAR(255) NOT NULL,
  status_code INT NOT NULL,
  latency_ms  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_at (created_at),
  INDEX idx_status_time (status_code, created_at)
) ENGINE=InnoDB;

-- ── Email delivery event log ────────────────────────────────
CREATE TABLE IF NOT EXISTS email_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  to_email VARCHAR(191) DEFAULT NULL,
  subject  VARCHAR(255) DEFAULT NULL,
  status   ENUM('success','failure') NOT NULL,
  error    VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_time (status, created_at)
) ENGINE=InnoDB;

-- ── stream_reports: optional provider + episode_id ──────────
-- User-reported stream failures don't currently carry a provider or a
-- resolved episode_id. Adding them (idempotently) lets the admin widget
-- group by provider and by episode. They are optional (NULL) so existing
-- reports keep working; the aggregate coalesces to a sensible fallback.
ALTER TABLE stream_reports
  ADD COLUMN provider VARCHAR(50) DEFAULT NULL;
ALTER TABLE stream_reports
  ADD COLUMN episode_id INT DEFAULT NULL;

-- Verify
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'anistrim2'
  AND TABLE_NAME IN ('api_request_log', 'email_events');