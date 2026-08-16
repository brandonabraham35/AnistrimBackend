-- ============================================================
-- Migration V17: Add last_login column to users table
-- Tracks when users last authenticated via email/password or Google
-- ============================================================

-- Add last_login column if it doesn't exist
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login DATETIME DEFAULT NULL AFTER updated_at;

-- Update existing records to set last_login to created_at as initial value
UPDATE users SET last_login = created_at WHERE last_login IS NULL;

-- Add index for login queries
ALTER TABLE users
  ADD INDEX IF NOT EXISTS idx_last_login (last_login);
