# SQL Schema Mismatch Fixes — COMPLETED ✅

## Root Causes Identified

### Root Cause #1 — `provider-usage` chart

**Error**: `Unknown column 'video_source' in 'field list'`
**File**: `controllers/adminController.js` line 767
**Issue**: Query used `COALESCE(video_source, 'direct')` but the `episodes` table has NEVER had a `video_source` column. Schema columns: `id, anime_id, episode_number, title, description, thumbnail_url, video_url, duration_sec, is_premium, view_count, created_at` + migrations added: `bunny_video_id, video_status, playback_url, embed_url, intro_start_time, intro_end_time, consumet_id`.

### Root Cause #2 — `recent-activity` timeline

**Error**: `Unknown column 'name' in 'field list'`
**File**: `controllers/adminController.js` line 815
**Issue**: Payments subquery used `name AS label` but the `payments` table has NO `name` column. The `hasColumn` guard only checked for `paid_at`, so the query ran but failed on `name`.

## Changes Made — `controllers/adminController.js`

### Fix 1: `getChartData` → `provider-usage` case (line ~765)

```javascript
// OLD: SELECT COALESCE(video_source, 'direct') AS provider, COUNT(*) AS count FROM episodes
// NEW: Uses getSchema() + hasColumn() to dynamically pick the right column
```

- Checks for `video_source` first (in case a migration adds it later)
- Falls back to `video_status` (from migration_v5 — always present)
- Falls back to `'direct'` string literal (safest fallback)

### Fix 2: `getRecentActivity` → payments subquery (line ~815)

```javascript
// OLD: SELECT 'payment' AS type, id, name AS label, ...
// NEW: SELECT 'payment' AS type, id, flw_tx_ref AS label, ...
```

- Replaced `name` with `flw_tx_ref` (exists in `payments` table, per schema.sql)

## Audit Verification

All other dashboard SQL queries were audited against the schema:

- ✅ `u.name` in activity_logs queries — correct (JOINs to users table which HAS `name`)
- ✅ `u.name` in payments queries — correct (JOINs to users table)
- ✅ `users.name` in getAllUsers, getUser, latestUsers — correct
- ✅ `anime.title`, `anime.view_count`, etc. — correct
- ✅ `episodes.video_url`, `episodes.view_count` — correct
- ✅ `watch_history.*` queries — correct
- ✅ `payments.*` queries (amount, status, plan, paid_at, flw_tx_ref) — correct

## No Database Changes Required

All fixes are in the backend controller logic only. The database schema remains untouched.
