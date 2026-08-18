-- ============================================================
--  AniStrim2 — Migration v41: ad_events frequency-cap index
--
--  Supports the server-side frequency-cap lookback in
--  adsController.getPolicy:
--    SELECT COUNT(*) FROM ad_events
--    WHERE user_id=? AND slot=? AND event='impression'
--      AND created_at > NOW() - INTERVAL 1 HOUR
--
--  Uses DATABASE() (never a hardcoded schema name) so it works
--  regardless of the connected DB name.
-- ============================================================

SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_events' AND INDEX_NAME = 'idx_user_slot_time'
);
SET @alter_sql := IF(@idx_exists = 0,
    'ALTER TABLE ad_events ADD INDEX idx_user_slot_time (user_id, slot, created_at)',
    'SELECT "ad_events.idx_user_slot_time exists" AS info'
);
PREPARE stmt FROM @alter_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify
SELECT INDEX_NAME FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_events' AND INDEX_NAME = 'idx_user_slot_time';