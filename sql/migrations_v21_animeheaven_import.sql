-- ============================================================
--  AniStrim2 — Migration v21: AnimeHeaven Import Identifiers
--
--  PURPOSE:
--    Persist AnimeHeaven identifiers permanently so playback can
--    resolve an episode WITHOUT re-running AnimeHeaven search.
--
--    • anime.animeheaven_slug          — the AnimeHeaven anime.php?<id>
--    • episodes.animeheaven_episode_key — the AnimeHeaven gate key
--
--  Safe / idempotent: uses information_schema guards so it can be
--  re-run without error.
-- ============================================================

-- ── 1. anime.animeheaven_slug ──────────────────────────────
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'anime'
      AND COLUMN_NAME  = 'animeheaven_slug'
);
SET @alter_sql := IF(@col_exists = 0,
    'ALTER TABLE anime ADD COLUMN animeheaven_slug VARCHAR(255) DEFAULT NULL',
    'SELECT "animeheaven_slug column already exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. anime index on animeheaven_slug ─────────────────────
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'anime'
      AND INDEX_NAME   = 'idx_animeheaven_slug'
);
SET @idx_sql := IF(@idx_exists = 0,
    'CREATE INDEX idx_animeheaven_slug ON anime (animeheaven_slug)',
    'SELECT "index idx_animeheaven_slug already exists" AS info'
);
PREPARE stmt2 FROM @idx_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ── 3. episodes.animeheaven_episode_key ────────────────────
SET @col_exists2 := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'episodes'
      AND COLUMN_NAME  = 'animeheaven_episode_key'
);
SET @alter_sql2 := IF(@col_exists2 = 0,
    'ALTER TABLE episodes ADD COLUMN animeheaven_episode_key VARCHAR(128) DEFAULT NULL',
    'SELECT "animeheaven_episode_key column already exists" AS info'
);
PREPARE stmt3 FROM @alter_sql2;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ── 4. episodes index on animeheaven_episode_key ───────────
SET @idx_exists2 := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'episodes'
      AND INDEX_NAME   = 'idx_animeheaven_episode_key'
);
SET @idx_sql2 := IF(@idx_exists2 = 0,
    'CREATE INDEX idx_animeheaven_episode_key ON episodes (animeheaven_episode_key)',
    'SELECT "index idx_animeheaven_episode_key already exists" AS info'
);
PREPARE stmt4 FROM @idx_sql2;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- ── 5. Verify ──────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('anime', 'episodes')
  AND COLUMN_NAME IN ('animeheaven_slug', 'animeheaven_episode_key')
ORDER BY TABLE_NAME, COLUMN_NAME;
