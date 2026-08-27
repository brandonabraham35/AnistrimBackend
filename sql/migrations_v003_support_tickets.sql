-- ============================================================
-- 003_support_tickets.sql
-- Support ticket system for authenticated users.
-- Safe to re-run: every ALTER/CREATE is guarded by an
-- information_schema check.
-- ============================================================

-- 1. support_tickets table
SET @table_exists := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_tickets');

SET @create_sql := IF(@table_exists = 0,
  'CREATE TABLE support_tickets (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    ticket_number   VARCHAR(32)     NOT NULL UNIQUE,
    user_id         INT             NOT NULL,
    category        VARCHAR(40)     NOT NULL,
    subject         VARCHAR(150)    NOT NULL,
    message         TEXT            NOT NULL,
    anime_id        INT             DEFAULT NULL,
    episode_id      INT             DEFAULT NULL,
    status          VARCHAR(20)     NOT NULL DEFAULT ''open'',
    priority        VARCHAR(20)     NOT NULL DEFAULT ''normal'',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at     DATETIME        DEFAULT NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_ticket_number (ticket_number),
    INDEX idx_anime_id (anime_id),
    INDEX idx_episode_id (episode_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE SET NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  'SELECT 1');

PREPARE stmt_create FROM @create_sql;
EXECUTE stmt_create;
DEALLOCATE PREPARE stmt_create;
