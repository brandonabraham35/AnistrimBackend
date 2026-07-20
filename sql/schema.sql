-- ============================================================
--  AniStrim2 — MySQL Workbench Schema
--  Run this entire file in MySQL Workbench once to set up
--  your full database. Execute with Ctrl+Shift+Enter
-- ============================================================

-- 1. Create & select the database
CREATE DATABASE IF NOT EXISTS anistrim2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE anistrim2;

-- ============================================================
-- TABLE: users
-- Stores every registered user + their premium status
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120)        NOT NULL,
  email         VARCHAR(191)        NOT NULL UNIQUE,
  password_hash VARCHAR(255),                         -- NULL for Google OAuth users
  google_id     VARCHAR(191)        DEFAULT NULL,
  avatar_url    VARCHAR(500)        DEFAULT NULL,
  is_premium    TINYINT(1)          NOT NULL DEFAULT 0,
  is_admin      TINYINT(1)          NOT NULL DEFAULT 0,
  premium_expires_at DATETIME       DEFAULT NULL,     -- When premium lapses
  created_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_google (google_id)
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: anime
-- Every anime title in the catalogue
-- ============================================================
CREATE TABLE IF NOT EXISTS anime (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  mal_id        INT                 DEFAULT NULL,     -- MyAnimeList ID (optional)
  title         VARCHAR(255)        NOT NULL,
  title_japanese VARCHAR(255)       DEFAULT NULL,
  description   TEXT                DEFAULT NULL,
  cover_image   VARCHAR(500)        DEFAULT NULL,     -- URL or /uploads/ path
  banner_image  VARCHAR(500)        DEFAULT NULL,
  trailer_url   VARCHAR(500)        DEFAULT NULL,
  rating        DECIMAL(3,2)        DEFAULT 0.00,
  year          SMALLINT            DEFAULT NULL,
  studio        VARCHAR(120)        DEFAULT NULL,
  status        ENUM('airing','completed','upcoming') NOT NULL DEFAULT 'completed',
  is_premium    TINYINT(1)          NOT NULL DEFAULT 0,  -- Premium-only title
  is_featured   TINYINT(1)          NOT NULL DEFAULT 0,  -- Show in hero slider
  view_count    INT                 NOT NULL DEFAULT 0,
  created_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_featured (is_featured),
  INDEX idx_status (status),
  FULLTEXT idx_search (title, description)
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: genres
-- Master list of genres (Action, Drama, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS genres (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(80) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: anime_genres  (many-to-many)
-- Links anime to multiple genres
-- ============================================================
CREATE TABLE IF NOT EXISTS anime_genres (
  anime_id  INT NOT NULL,
  genre_id  INT NOT NULL,
  PRIMARY KEY (anime_id, genre_id),
  FOREIGN KEY (anime_id) REFERENCES anime(id)  ON DELETE CASCADE,
  FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: episodes
-- Every episode linked to an anime title
-- ============================================================
CREATE TABLE IF NOT EXISTS episodes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  anime_id      INT                 NOT NULL,
  episode_number SMALLINT           NOT NULL,
  title         VARCHAR(255)        DEFAULT NULL,
  description   TEXT                DEFAULT NULL,
  thumbnail_url VARCHAR(500)        DEFAULT NULL,
  video_url     VARCHAR(1000)       DEFAULT NULL,     -- Cloudinary / S3 URL
  duration_sec  INT                 DEFAULT 1440,     -- 24 min default
  is_premium    TINYINT(1)          NOT NULL DEFAULT 0,
  view_count    INT                 NOT NULL DEFAULT 0,
  created_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_anime_ep (anime_id, episode_number),
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,
  INDEX idx_anime (anime_id)
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: watchlist
-- Each row = one user tracking one anime
-- ============================================================
CREATE TABLE IF NOT EXISTS watchlist (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT                 NOT NULL,
  anime_id      INT                 NOT NULL,
  status        ENUM('watching','plan_to_watch','completed','dropped') NOT NULL DEFAULT 'plan_to_watch',
  episodes_watched SMALLINT         NOT NULL DEFAULT 0,
  added_at      DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_anime (user_id, anime_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (anime_id) REFERENCES anime(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: watch_history
-- Tracks exactly which episode a user watched + progress
-- ============================================================
CREATE TABLE IF NOT EXISTS watch_history (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT                 NOT NULL,
  episode_id    INT                 NOT NULL,
  progress_sec  INT                 NOT NULL DEFAULT 0,  -- Seconds watched
  completed     TINYINT(1)          NOT NULL DEFAULT 0,
  watched_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_episode (user_id, episode_id),
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: payments
-- Every Flutterwave transaction — success or failed
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT             NOT NULL,
  flw_tx_id         VARCHAR(191)    DEFAULT NULL,     -- Flutterwave transaction_id
  flw_tx_ref        VARCHAR(191)    NOT NULL UNIQUE,  -- Your unique reference
  amount            DECIMAL(10,2)   NOT NULL,
  currency          VARCHAR(10)     NOT NULL DEFAULT 'UGX',
  status            ENUM('pending','successful','failed','refunded') NOT NULL DEFAULT 'pending',
  payment_method    VARCHAR(80)     DEFAULT NULL,     -- 'mobilemoney', 'card', etc.
  plan              ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  paid_at           DATETIME        DEFAULT NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_status (status),
  INDEX idx_flw_ref (flw_tx_ref)
) ENGINE=InnoDB;

-- ============================================================
-- TABLE: admin_logs
-- Audit trail for every admin action
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  admin_id    INT             NOT NULL,
  action      VARCHAR(255)    NOT NULL,
  target_type VARCHAR(80)     DEFAULT NULL,   -- 'anime', 'user', 'episode'
  target_id   INT             DEFAULT NULL,
  detail      TEXT            DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- SEED DATA: Genres
-- ============================================================
INSERT IGNORE INTO genres (name) VALUES
  ('Action'), ('Adventure'), ('Comedy'), ('Drama'),
  ('Fantasy'), ('Horror'), ('Mystery'), ('Romance'),
  ('Sci-Fi'), ('Slice of Life'), ('Sports'),
  ('Supernatural'), ('Thriller'), ('Psychological');

-- ============================================================
-- SEED DATA: Default Admin User
-- Password: admin123  (bcrypt hash — change immediately!)
-- ============================================================
INSERT IGNORE INTO users (name, email, password_hash, is_admin, is_premium) VALUES
  ('Admin', 'admin@anistrim.com',
   '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17ldy',
   1, 1);

-- ============================================================
-- SEED DATA: Sample Anime Titles
-- ============================================================
INSERT IGNORE INTO anime (id, title, title_japanese, description, cover_image, rating, year, studio, status, is_premium, is_featured) VALUES
(1, 'Attack on Titan: Final Season', '進撃の巨人 Final Season',
 'The Survey Corps face the world outside Paradis Island as Eren Yeager''s transformation forces former allies to confront a terrifying future.',
 'https://cdn.myanimelist.net/images/anime/1948/120625l.jpg', 9.00, 2020, 'MAPPA', 'completed', 0, 1),

(2, 'Jujutsu Kaisen', '呪術廻戦',
 'A boy swallows a cursed talisman and becomes host to a powerful curse. He enrolls in a school of sorcerers.',
 'https://cdn.myanimelist.net/images/anime/1171/109222l.jpg', 8.90, 2020, 'MAPPA', 'airing', 0, 1),

(3, 'Demon Slayer: Kimetsu no Yaiba', '鬼滅の刃',
 'A young boy becomes a demon slayer after his family is slaughtered and his sister turned into a demon.',
 'https://cdn.myanimelist.net/images/anime/1286/99889l.jpg', 9.20, 2019, 'ufotable', 'airing', 0, 1),

(4, 'Frieren: Beyond Journey''s End', '葬送のフリーレン',
 'An elven mage who outlives her companions reflects on the meaning of time and human connection.',
 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg', 9.30, 2023, 'Madhouse', 'completed', 0, 1),

(5, 'Fullmetal Alchemist: Brotherhood', '鋼の錬金術師',
 'Two brothers search for a Philosopher''s Stone after an attempt to revive their deceased mother goes catastrophically wrong.',
 'https://cdn.myanimelist.net/images/anime/1208/94745l.jpg', 9.70, 2009, 'Bones', 'completed', 0, 0),

(6, 'Death Note', 'デスノート',
 'A high school student discovers a supernatural notebook that allows him to kill anyone by writing their name.',
 'https://cdn.myanimelist.net/images/anime/9/9453l.jpg', 9.40, 2006, 'Madhouse', 'completed', 1, 0),

(7, 'Cowboy Bebop', 'カウボーイビバップ',
 'A ragtag crew of bounty hunters chase criminals across the solar system while dealing with their troubled pasts.',
 'https://cdn.myanimelist.net/images/anime/4/19644l.jpg', 9.60, 1998, 'Sunrise', 'completed', 0, 0),

(8, 'Steins;Gate', 'シュタインズ・ゲート',
 'A group of friends create a device that can send messages to the past, attracting the attention of a mysterious org.',
 'https://cdn.myanimelist.net/images/anime/1935/127974l.jpg', 9.10, 2011, 'White Fox', 'completed', 1, 0);

-- Link genres to anime
INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES
(1, 1),(1, 4),(1, 12),
(2, 1),(2, 12),(2, 3),
(3, 1),(3, 5),(3, 12),
(4, 2),(4, 5),(4, 4),
(5, 1),(5, 2),(5, 4),
(6, 8),(6, 12),(6, 13),
(7, 1),(7, 2),(7, 9),
(8, 4),(8, 9),(8, 13);

-- Sample episodes for Anime ID 1 (Attack on Titan)
INSERT IGNORE INTO episodes (anime_id, episode_number, title, duration_sec, is_premium) VALUES
(1, 1,  'The Other Side of the Sea',   1455, 0),
(1, 2,  'Midnight Train',              1380, 0),
(1, 3,  'The Door of Hope',            1410, 0),
(1, 4,  'From One Hand to Another',    1425, 1),
(1, 5,  'Declaration of War',          1440, 1),
(1, 6,  'The War Hammer Titan',        1395, 1),
(2, 1,  'Ryomen Sukuna',               1440, 0),
(2, 2,  'For Myself',                  1380, 0),
(2, 3,  'Girl of Steel',               1400, 0),
(3, 1,  'Cruelty',                     1410, 0),
(3, 2,  'Trainer Urokodaki',           1380, 0);

-- ============================================================
-- VERIFY: Check all tables were created
-- ============================================================
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = 'anistrim2'
ORDER BY table_name;
