-- migrations_v56_password_reset_tokens.sql
-- Persistent, atomic single-use password-reset token consumption.
--
-- Previously the used-reset-token state lived only in an in-memory Map
-- (authController.js), so a Node restart could make a used token valid again
-- and two concurrent requests could both consume the same token. This table
-- makes consumption durable and atomic: resetPassword flips `used_at` from
-- NULL to NOW() in a single UPDATE, so only one request can ever succeed.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jwt_id VARCHAR(64) NOT NULL,          -- reset-token jti (unique, single-use)
  user_id INT NOT NULL,
  email VARCHAR(191) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,                -- NULL = unused; NOW() = consumed
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pwdreset_jwt_id (jwt_id),
  INDEX idx_pwdreset_expires (expires_at),
  INDEX idx_pwdreset_user (user_id),
  CONSTRAINT fk_pwdreset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
