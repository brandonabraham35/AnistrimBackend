-- ============================================================
--  AniStrim2 — Migration v37: System Health Samples (Phase 9)
--
--  Persists a health sample every 5 min so the admin dashboard can
--  render sparklines and answer "when did this start?".
-- ============================================================
USE anistrim2;

CREATE TABLE IF NOT EXISTS health_samples (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  component VARCHAR(30) NOT NULL,
  status ENUM('up','degraded','down') NOT NULL,
  latency_ms INT DEFAULT NULL,
  last_error VARCHAR(500) DEFAULT NULL,
  sampled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_component_time (component, sampled_at)
) ENGINE=InnoDB;

-- Verify
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'anistrim2' AND TABLE_NAME = 'health_samples';