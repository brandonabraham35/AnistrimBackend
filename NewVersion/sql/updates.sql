-- Run this in MySQL Workbench to add new columns
USE anistrim2;

-- FIX 5: Add reset token columns
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token         VARCHAR(191) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reset_token_expires DATETIME     DEFAULT NULL;

-- Verify
DESCRIBE users;
