-- ============================================================
--  AniStrim2 — Daily Views Migration for Viral Threshold Premium
--  Run this SQL in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v9_daily_views.sql
-- ============================================================
USE anistrim2;

-- Add daily_views column to anime table (Viral Threshold tracking)
ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS daily_views INT NOT NULL DEFAULT 0,
  ADD INDEX IF NOT EXISTS idx_daily_views (daily_views);

-- Verify the column was added
SELECT column_name, column_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'anistrim2'
  AND table_name = 'anime'
  AND column_name = 'daily_views';

