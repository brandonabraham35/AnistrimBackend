# Fix "Unknown column 'name' in 'field list'" Error

## Root Cause

The `getRecentActivity()` function in `controllers/adminController.js` hardcodes `name AS label` without checking if the `name` column exists in the `users` table. The live database schema may differ from `sql/schema.sql`.

## Steps

- [x] Step 1: Read and analyze `controllers/adminController.js` — DONE
- [x] Step 2: Read `sql/schema.sql` and migration files to understand actual schema — DONE
- [x] Step 3: Identify all hardcoded `name` references across affected functions — DONE
- [x] Step 4: Show plan to user and get approval — DONE
- [x] Step 5: Fix `getRecentActivity()` — use `hasColumn()` for `name` in users query — DONE
- [x] Step 6: Fix `getDashboardOverview()` — use `hasColumn()` for `u.name` in logs queries — DONE
- [x] Step 7: Fix `getActivityLogs()` — use `hasColumn()` for `u.name` in logs queries — DONE
- [x] Step 8: Fix `getPayments()` — use `hasColumn()` for `u.name` in SELECT/WHERE — DONE
- [x] Step 9: Verify no other hardcoded `name` references remain in problematic functions — DONE
