-- ============================================================
--  AniStrim2 — Migration v10: Add consumet_id to episodes
--  This supports the "Save Everything" import architecture where
--  episodes are bulk-inserted from Consumet during anime import.
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v10_consumet_id.sql
-- ============================================================
USE anistrim2;

-- Add consumet_id column for storing the Consumet episode ID (e.g. "naruto-episode-1")
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS consumet_id VARCHAR(255) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_episodes_consumet_id (consumet_id);

-- Verify the column was added
SELECT column_name, column_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'anistrim2'
  AND table_name = 'episodes'
  AND column_name = 'consumet_id';

