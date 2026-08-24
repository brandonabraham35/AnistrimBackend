-- ============================================================
--  AniStrim2 — Migration v48: Fix plans.amount for correct UGX pricing
--
--  Purpose:
--    The plans table seed data in migrations_v35 inserted placeholder
--    amounts (14.99, 149.99) that do NOT represent the intended UGX
--    prices. The checkout flow (controllers/paymentController.js
--    initializeCheckout) reads planRow.amount and sends it directly
--    to Pesapal, so Pesapal received 14.99 instead of 15000.
--
--  Correct amounts:
--    premium-monthly: 15000  (UGX 15,000/month)
--    premium-annual:  180000 (UGX 180,000/year)
--    standard-monthly: 9.99  (unchanged — placeholder for free tier)
--    standard-annual:  99.99 (unchanged — placeholder for free tier)
--
--  SAFETY:
--    • Idempotent — can be re-run.
--    • Only updates premium plans (standard tiers are placeholders).
--    • Does not change subscriptions, settings, or frontend.
--    • UPDATE uses `IGNORE` to avoid errors.
-- ============================================================

-- Fix premium-monthly amount
UPDATE IGNORE plans
SET amount = 15000
WHERE code = 'premium-monthly' AND amount != 15000;

-- Fix premium-annual amount
UPDATE IGNORE plans
SET amount = 180000
WHERE code = 'premium-annual' AND amount != 180000;

-- Verify the fix
SELECT code, name, amount, currency
FROM plans
WHERE code IN ('premium-monthly', 'premium-annual', 'standard-monthly', 'standard-annual')
ORDER BY code;