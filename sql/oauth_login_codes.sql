-- OAuth login codes table for multi-instance support
-- Replaces in-memory Map with persistent storage
CREATE TABLE IF NOT EXISTS oauth_login_codes (
  code CHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  intent ENUM('login', 'signup') NOT NULL DEFAULT 'login',
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_expires_at (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Clean up expired codes older than 1 hour (run periodically)
DELETE FROM oauth_login_codes WHERE expires_at < NOW() - INTERVAL 1 HOUR;
