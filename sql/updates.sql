-- Run this in MySQL Workbench to add new columns
-- Select your database first: USE your_database_name;


-- FIX 5: Add reset token columns
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token         VARCHAR(191) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reset_token_expires DATETIME     DEFAULT NULL;

-- Verify
DESCRIBE users;
