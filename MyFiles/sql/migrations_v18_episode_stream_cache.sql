-- ============================================================
--  AniStrim2 — Migration v18: Episode Stream Cache
--
--  Persistent, database-backed cache for successfully-resolved
--  AnimeHeaven stream sources. This is PLAYBACK INFRASTRUCTURE ONLY.
--
--  It does NOT change how administrators add/edit/delete anime or
--  episodes. It does NOT change the `episodes` table semantics.
--  It only stores the reusable PRE-PROXY AnimeHeaven source data so
--  subsequent plays can reuse a resolved stream without re-contacting
--  AnimeHeaven (while the cache entry remains valid).
--
--  IMPORTANT: The cached `stream_data` stores the PRE-PROXY source
--  (targetUrl + referer/origin/cookies + quality + subtitle metadata),
--  NOT the ephemeral /api/stream-proxy/:streamId URL. On a cache hit
--  the existing streamProxy pipeline re-registers the context and
--  generates a fresh ephemeral proxy URL for the browser.
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v18_episode_stream_cache.sql
-- ============================================================
USE anistrim2;

-- Create the episode stream cache table.
-- The FK (episode_id -> episodes.id) with ON DELETE CASCADE means that when
-- an administrator deletes an episode, its cached stream rows are removed
-- automatically by the database. No admin-delete logic changes are needed.
CREATE TABLE IF NOT EXISTS episode_stream_cache (
    id            INT             AUTO_INCREMENT PRIMARY KEY,
    episode_id    INT             NOT NULL,
    provider      VARCHAR(50)     NOT NULL,
    stream_type   VARCHAR(50)     NULL,
    stream_data   JSON            NOT NULL,
    resolved_at   DATETIME        NOT NULL,
    expires_at    DATETIME        NOT NULL,
    last_used_at  DATETIME        NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,

    -- One active cache record per (episode, provider).
    UNIQUE KEY uq_episode_provider (episode_id, provider),
    -- Index for efficient expiry sweeps.
    INDEX idx_expires_at (expires_at),

    CONSTRAINT fk_episode_stream_cache_episode
        FOREIGN KEY (episode_id)
        REFERENCES episodes(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify the table was created.
DESCRIBE episode_stream_cache;
