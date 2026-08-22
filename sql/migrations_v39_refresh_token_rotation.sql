-- ============================================================
--  AniStrim2 — Migration v39: Refresh-Token Rotation Tracking
--
--  Adds a child table `session_refresh_tokens` that records EVERY
--  issued refresh token hash for a session. This enables real
--  reuse detection: when a presented hash is already marked
--  `used_at`, the whole session family is revoked.
--
--  Safe / idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS session_refresh_tokens (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id    CHAR(36) NOT NULL,
  refresh_hash  CHAR(64) NOT NULL,
  used_at       DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refresh_hash (refresh_hash),
  INDEX idx_session (session_id),
  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Backfill: existing user_sessions.refresh_hash rows become the
-- "current" (unused) token for each session.
INSERT IGNORE INTO session_refresh_tokens (session_id, refresh_hash)
SELECT id, refresh_hash FROM user_sessions WHERE refresh_hash IS NOT NULL;
