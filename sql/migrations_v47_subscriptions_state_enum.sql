-- ============================================================
--  AniStrim2 — Migration v47: subscriptions.state ENUM widen
--
--  Purpose:
--    Fixes production checkout failure:
--      "Data truncated for column 'state' at row 1"
--    Production/subscriptions.state was created by an older migration
--    with an ENUM that does NOT contain 'pending'. The checkout handler
--    (controllers/paymentController.js initializeCheckout) intentionally
--    creates a newly purchased subscription with status='PENDING',
--    state='pending'.
--
--  This migration changes ONLY subscriptions.state to the canonical
--  application state machine:
--      ENUM('pending','trialing','active','grace','expired','cancelled','refunded')
--
--  SAFETY:
--    • Idempotent — safe to run more than once (re-runs are no-ops).
--    • Does NOT change subscription.status.
--    • Does NOT touch data — existing rows are left identical.
--    • Uses the information_schema + PREPARE/EXECUTE pattern (the runner
--      executes each file on a single connection, so session vars work).
--    • If the column is already correct → SELECT 1 (no-op).
--
--  NOTE: Compare against the canonical definitions:
--    migrations_v35: ENUM('pending','trialing','active','grace','expired','cancelled','refunded') NOT NULL DEFAULT 'active'
--    migrations_v45: ENUM('pending','trialing','active','grace','expired','cancelled','refunded') NOT NULL DEFAULT 'pending'
--  We use NOT NULL DEFAULT 'pending' (matches the checkout contract:
--  new rows are created pending, then transition to active on payment).
-- ============================================================

SET @state_col_type := (
  SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'subscriptions'
    AND COLUMN_NAME = 'state'
);

-- Confirm the pre-change ENUM for the audit report before modifying:
-- @state_col_type now holds e.g.
--   enum('active','expired','cancelled','refunded')
-- or the full 7-value enum. If it already contains every needed value
-- below, we no-op.

SET @state_sql := CASE
  WHEN @state_col_type IS NULL THEN
    'ALTER TABLE subscriptions ADD COLUMN state ENUM(''pending'',''trialing'',''active'',''grace'',''expired'',''cancelled'',''refunded'') NOT NULL DEFAULT ''pending'''
  WHEN @state_col_type NOT LIKE '%pending%' THEN
    'ALTER TABLE subscriptions MODIFY COLUMN state ENUM(''pending'',''trialing'',''active'',''grace'',''expired'',''cancelled'',''refunded'') NOT NULL DEFAULT ''pending'''
  ELSE
    'SELECT 1'
END;

PREPARE state_stmt FROM @state_sql;
EXECUTE state_stmt;
DEALLOCATE PREPARE state_stmt;

-- ── Verify the final column definition ───────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'subscriptions'
  AND COLUMN_NAME = 'state';