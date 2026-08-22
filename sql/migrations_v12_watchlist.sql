-- ============================================================
--  AniStrim2 — Migration v12: User Watchlists Table
--  Users can save and categorize anime into personal lists.
--
--  Uses table name 'user_watchlists' to avoid conflicts.
--  Stores anime_id as VARCHAR to support external/Anilist-based
--  anime that may not exist in the local anime table.
--
--  Run this in MySQL Workbench or your MySQL client:
--    mysql -u root -p anistrim2 < sql/migrations_v12_watchlist.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS user_watchlists (
  id            INT             AUTO_INCREMENT PRIMARY KEY,
  user_id       INT             NOT NULL,
  anime_id      VARCHAR(255)    NOT NULL,
  anime_title   VARCHAR(255)    DEFAULT NULL,
  anime_cover   VARCHAR(500)    DEFAULT NULL,
  status        ENUM('WATCHING','COMPLETED','ON_HOLD','DROPPED','PLAN_TO_WATCH')
                                NOT NULL DEFAULT 'PLAN_TO_WATCH',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_anime (user_id, anime_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Verify
DESCRIBE user_watchlists;


