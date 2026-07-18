-- AniStrim dashboard feature-parity migration.
-- Safe to run after migrations_v5.sql. It enables intro skip metadata used by
-- the episode editor; the API remains backward compatible if it is not run yet.
USE anistrim2;

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS intro_start_time INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS intro_end_time INT DEFAULT NULL;
