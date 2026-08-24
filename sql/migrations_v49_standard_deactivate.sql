-- ============================================================
--  AniStrim2 — Migration v49: Deactivate unused Standard plans
--
--  Purpose:
--    The Standard plans (standard-monthly = 9.99 UGX,
--    standard-annual = 99.99 UGX) were seeded in v35 as
--    placeholder rows. No authoritative Standard pricing
--    exists in the project. The plans cannot be purchased
--    through checkout (PLAN_CODE_BY_KEY only maps to
--    premium-monthly and premium-annual) and are not
--    displayed in any frontend.
--
--    This migration safely deactivates them by setting
--    is_active = 0 so they cannot be accidentally picked
--    up by future code, while preserving the rows for FK
--    integrity and historical reference.
--
--  SAFETY:
--    • Idempotent — safe to re-run.
--    • Preserves existing subscription/payment records.
--    • Does not delete rows — only deactivates.
--    • Does not modify premium plans.
--    • Uses "WHERE is_active != 0" so re-runs are no-ops.
-- ============================================================

-- Deactivate standard-monthly
UPDATE IGNORE plans
SET is_active = 0
WHERE code = 'standard-monthly' AND is_active != 0;

-- Deactivate standard-annual
UPDATE IGNORE plans
SET is_active = 0
WHERE code = 'standard-annual' AND is_active != 0;

-- Verify
SELECT code, name, amount, currency, is_active
FROM plans
WHERE code IN ('premium-monthly', 'premium-annual', 'standard-monthly', 'standard-annual')
ORDER BY code;