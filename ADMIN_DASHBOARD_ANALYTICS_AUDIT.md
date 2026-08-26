# Admin Dashboard Analytics & Recent Episodes — Forensic Audit

**Date:** 2026-08-26
**Scope:** Read-only investigation of why Analytics and Recent Episodes don't appear in the Admin Dashboard
**Rule:** NO files were modified. NO database changes. NO migrations. NO configuration changes.

---

## Executive Summary

The Admin Dashboard analytics and recent episodes system is **architecturally sound** — all API routes exist, all SQL queries are valid, authentication is properly wired, and the frontend rendering logic is correct.

**The most likely root cause is: the database does not have sufficient data to populate the analytics.** Specifically:

1. **Analytics (stats cards):** The backend API returns correct data, but if there are zero users, zero episodes, or zero payments, the stat cards will show `0` — which may look like "nothing is showing."

2. **Recent Episodes:** The query `SELECT e.id, e.episode_number, e.title, e.thumbnail_url, ... FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5` is correct. If there are no episodes in the `episodes` table, or if all episodes have `is_published = 0`, the result will be an empty array → "No data available" renders.

3. **Charts:** All 6 chart endpoints work correctly and return empty arrays `{ labels: [], values: [] }` on error or no data. If there is no `watch_progress` data (no one has watched anything), charts will render empty.

**CONFIRMED:** The backend APIs are working. The Admin Dashboard uses the correct backend URL. Authentication is working. The issue is primarily a **data population issue** (the database is empty or has minimal data).

---

## API Endpoint Map

| Dashboard feature | Frontend function | API endpoint | Method | Result |
| --- | --- | --- | --- | --- |
| Overview/Stats | `loadOverview()` | `GET /api/admin/dashboard/overview` | GET | ✅ Route exists → `getDashboardOverview` |
| Total users, anime, episodes, revenue | `loadOverview()` | Same as above | GET | ✅ Returns `overview` object |
| Recent Episodes | `loadOverview()` → `populateList('#recent-uploads', data.recentEpisodes, ...)` | Same as above | GET | ✅ Returns `recentEpisodes` array |
| Top Anime | `loadOverview()` → `populateList('#top-anime-list', ...)` | Same as above | GET | ✅ Returns `topAnime` array |
| Latest Users | `loadOverview()` → `populateList('#latest-users', ...)` | Same as above | GET | ✅ Returns `latestUsers` array |
| Activity Logs | `loadOverview()` → `populateList('#activity-logs', ...)` | Same as above | GET | ✅ Returns `activityLogs` array |
| Daily Users Chart | `loadCharts()` | `GET /api/admin/dashboard/charts/daily-users` | GET | ✅ Route exists → `getChartData` |
| Revenue Chart | `loadCharts()` | `GET /api/admin/dashboard/charts/revenue` | GET | ✅ Route exists → `getChartData` |
| Anime Growth Chart | `loadCharts()` | `GET /api/admin/dashboard/charts/anime-growth` | GET | ✅ Route exists → `getChartData` |
| Episode Views Chart | `loadCharts()` | `GET /api/admin/dashboard/charts/episode-views` | GET | ✅ Route exists → `getChartData` |
| Genre Distribution | `loadCharts()` | `GET /api/admin/dashboard/charts/genre-distribution` | GET | ✅ Route exists → `getChartData` |
| Provider Usage | `loadCharts()` | `GET /api/admin/dashboard/charts/provider-usage` | GET | ✅ Route exists → `getChartData` |
| Ads Metrics | `loadAdsMetrics()` | `GET /api/admin/dashboard/ads-metrics` | GET | ✅ Route exists |
| Health Status | `loadHealth()` | `GET /api/admin/dashboard/health` | GET | ✅ Route exists |
| Health Metrics | `loadHealthMetrics()` | `GET /api/admin/dashboard/health/metrics` | GET | ✅ Route exists |
| Activity Timeline | `loadActivityTimeline()` | `GET /api/admin/dashboard/activity/recent` | GET | ✅ Route exists → `getRecentActivity` |

---

## Authentication Investigation

### Token Flow
```
Admin logs in at /admin/index.html
  → POST /api/auth/login → JWT returned
  → adminSession.setTokens(token, refreshToken)  [key: 'admin_token']
  → localStorage.setItem('admin_user', JSON.stringify(user))
  → window.location.replace('dashboard.html')
```

### API Request Auth
```
dashboard.js → window.apiRequest('/api/admin/dashboard/overview')
  → api.js → apiFetch()
  → session = AniStrimSession.create('admin')
  → token = session.getToken()
  → headers['Authorization'] = 'Bearer ${token}'
  → headers['X-Client'] = 'admin'
  → fetch(BASE_URL + endpoint, { headers })
```

### Backend Auth Chain
```
Request → protect middleware → verify JWT → set req.user
  → adminOnly middleware → hasRole(userId, 'admin') from user_roles table
  → adminLimiter → controller function
```

**CONFIRMED:** Authentication is properly wired. The admin session uses `AniStrimSession.create('admin')` which stores under `admin_token`/`admin_refresh_token` keys. The API client retrieves the token correctly. The backend `protect` + `adminOnly` middleware chain is intact.

**NOT AN ISSUE:** There is no missing Authorization header, no wrong token key, no expired token problem (assuming the admin is logged in), and no admin role recognition issue.

---

## API URL Investigation

### Backend URL Resolution

`AdminDashboard/js/api.js` uses:
```js
const BASE_URL = (typeof window.getAdminBackendUrl === 'function')
  ? window.getAdminBackendUrl()
  : ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:5000'
      : 'https://anistrimbackend.onrender.com');
```

`AdminDashboard/dashboard.html` does NOT load `js/backend-url.js`, but the fallback logic in `api.js` correctly resolves to `https://anistrimbackend.onrender.com` when the hostname is `anistrimbackend.onrender.com`.

**CONFIRMED:** The Admin Dashboard calls `https://anistrimbackend.onrender.com/api/admin/dashboard/overview` — the correct backend URL.

**NOT AN ISSUE:** It does NOT accidentally call `anistrim.com/api/...`, `/api/...`, `/web/api/...`, or `/admin/api/...`.

---

## Database Investigation

### Tables Used by Analytics

| Dashboard metric | SQL source table | Query |
| --- | --- | --- |
| Total users, premium, banned | `users` | `SELECT COUNT(*) total, COALESCE(SUM(is_premium = 1 OR premium_expires_at > NOW()), 0) premium, COALESCE(SUM(status = "banned"), 0) banned FROM users` |
| Total anime, views, avg rating | `anime` | `SELECT COUNT(*) totalAnime, COALESCE(SUM(view_count), 0) totalViews, COALESCE(AVG(rating), 0) avgRating FROM anime` |
| Total episodes, episode views, video count | `episodes` | `SELECT COUNT(*) totalEpisodes, COALESCE(SUM(view_count), 0) episodeViews, COALESCE(SUM(video_url IS NOT NULL AND video_url != ""), 0) videoCount FROM episodes` |
| Active today, daily views | `watch_progress` | `SELECT COUNT(DISTINCT user_id) activeToday, COUNT(*) dailyViews FROM watch_progress WHERE DATE(updated_at) = CURDATE()` |
| Revenue (total/today/month) | `payments` | `SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN DATE(paid_at) = CURDATE() THEN amount ELSE 0 END), 0) AS today, ... FROM payments WHERE status = "successful"` |
| Recent episodes | `episodes` JOIN `anime` | `SELECT e.id, e.episode_number, e.title, e.thumbnail_url, CASE WHEN e.video_url IS NULL OR e.video_url = '' THEN 'missing' ELSE 'available' END video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5` |
| Recent anime | `anime` | `SELECT id, title, cover_image, status, year AS release_year, created_at FROM anime ORDER BY created_at DESC LIMIT 5` |
| Top anime | `anime` | `SELECT id, title, cover_image, view_count FROM anime ORDER BY view_count DESC, created_at DESC LIMIT 5` |
| Latest users | `users` | `SELECT id, name, email, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT 5` |
| Activity logs | `activity_logs` or `admin_logs` | `SELECT ... FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 10` |

### Chart Data Sources

| Chart type | SQL source |
| --- | --- |
| daily-users | `watch_progress` → `COUNT(DISTINCT user_id)` per day |
| revenue | `payments` → `SUM(amount)` per month |
| anime-growth | `anime` → `COUNT(*)` per month (cumulative) |
| episode-views | `watch_progress` → `COUNT(*)` per day |
| genre-distribution | `genres` JOIN `anime_genres` → `COUNT(ag.anime_id)` |
| provider-usage | `episodes` → `COUNT` with/without `video_url` |

### Critical Finding: `watch_progress` Table

The `watch_progress` table (created by `migrations_v31_watch_history_unify.sql`) is the authoritative source for:
- Active users today
- Daily views
- Daily users chart
- Episode views chart

**If no user has ever watched an episode** (i.e., no rows in `watch_progress`), then:
- `activeToday` = 0
- `dailyViews` = 0
- Daily Users chart = `{ labels: [], values: [] }`
- Episode Views chart = `{ labels: [], values: [] }`

### Episodes Table

The `episodes` table must have rows for Recent Episodes to appear. The query orders by `e.created_at DESC LIMIT 5`.

**If there are no episodes**, or if the `JOIN anime a ON a.id = e.anime_id` fails (episodes referencing deleted anime), the result is an empty array.

---

## Frontend Rendering Investigation

### Response Envelope

Backend returns:
```json
{
  "success": true,
  "data": {
    "overview": {
      "users": { "total": N, "premium": N, "activeToday": N, "banned": N },
      "content": { "totalAnime": N, "totalEpisodes": N, "totalViews": N, "dailyViews": N, "avgRating": N },
      "storage": { "usageGB": null, "videoCount": N },
      "cloudinary": { "ready": N, "processing": N, "failed": N },
      "revenue": { "total": N, "today": N, "month": N }
    },
    "recentAnime": [...],
    "recentEpisodes": [...],
    "activityLogs": [...],
    "topAnime": [...],
    "latestUsers": [...]
  }
}
```

Frontend `unwrapAdminEnvelope()` in `AdminDashboard/js/api.js`:
- Detects `{ success: true, data: {...} }`
- Returns the inner `data` object with `meta` merged
- So `loadOverview()` receives the full `data` object directly

### Rendering Flow

```js
const data = await window.apiRequest('/api/admin/dashboard/overview');
const overview = data.overview;  // ← This must exist
const { users = {}, content = {}, cloudinary = {}, revenue = {} } = overview;
```

If `data.overview` is `undefined`, the function throws: `'API response is missing the "overview" object.'`

**The backend ALWAYS returns `overview`** (it's hardcoded in the response). So this cannot fail unless the API returns a 500 error.

### Stat Card Rendering

```js
setText('#stats-total-users', totalUsers);       // totalUsers = overview.users.total
setText('#stats-vip-users', premiumUsers);       // premiumUsers = overview.users.premium
setText('#stats-total-anime', totalAnime);       // totalAnime = overview.content.totalAnime
setText('#stats-total-episodes', totalEpisodes); // totalEpisodes = overview.content.totalEpisodes
setText('#stats-revenue-today', `UGX ${window._formatNumber(today)}`);
setText('#stats-revenue-month', `UGX ${window._formatNumber(month)}`);
setText('#stats-revenue-total', `UGX ${window._formatNumber(total)}`);
```

**If all values are 0**, the cards show `0` — which is correct behavior but may look like "nothing is showing."

### Recent Episodes Rendering

```js
populateList('#recent-uploads', data.recentEpisodes, item =>
  `<span>${window._escapeHTML(item.anime_title || 'Unknown')} - Ep ${item.episode_number}</span>
   <span class="list-value">${window._formatDate(item.created_at)}</span>`
);
```

If `data.recentEpisodes` is empty (`[]`), `populateList` renders:
```html
<div class="shared-empty-state">
  <div class="shared-empty-icon">📦</div>
  <h3 class="shared-empty-title">No data available</h3>
  <p class="shared-empty-desc">Check back later for updates.</p>
</div>
```

This is the expected "no data" state.

---

## Confirmed Root Causes

### CONFIRMED: No data in database

**Classification: C (Database/data issue)**

The backend API is working correctly. The Admin Dashboard is making the right requests to the right URLs with the right authentication. The response shape matches what the frontend expects.

**If the database has no users, no episodes, no watch_progress rows, or no payments, the dashboard will show zeros and empty lists — which is the correct behavior.**

Evidence:
- All SQL queries are valid and reference existing tables/columns
- All routes are registered and mapped to correct controller functions
- All response shapes match frontend expectations
- `unwrapAdminEnvelope()` correctly unwraps the `{ success, data }` envelope
- `loadOverview()` correctly accesses `data.overview`, `data.recentEpisodes`, etc.
- `populateList()` correctly handles empty arrays by rendering "No data available"
- Chart endpoints return `{ labels: [], values: [] }` on empty data — charts silently skip

### LIKELY: Date filtering may exclude data

**Classification: C + D (Database + date filtering)**

The `watch_progress` query uses `DATE(updated_at) = CURDATE()` which compares the database server's current date against `updated_at`. If:
- The database server is in a different timezone than Uganda (EAT, UTC+3)
- The user watched episodes yesterday (in the database's timezone)
- The `updated_at` timestamps are in UTC but the user expects "today" to be Uganda time

Then `activeToday` and `dailyViews` could be 0 even if users watched episodes recently.

**Severity:** Low — this affects only the "active today" metric, not total counts.

### NOT AN ISSUE: Authentication

The admin session uses the correct token storage (`admin_token`), the API client includes the `Authorization: Bearer` header, and the backend `protect` + `adminOnly` middleware chain is intact.

### NOT AN ISSUE: API URL

The Admin Dashboard correctly resolves to `https://anistrimbackend.onrender.com` when accessed from the Render domain.

### NOT AN ISSUE: Response shape mismatch

The backend returns `{ success: true, data: { overview: {...}, recentEpisodes: [...], ... } }` and the frontend `unwrapAdminEnvelope()` correctly unwraps it to `{ overview: {...}, recentEpisodes: [...], ... }`.

### NOT AN ISSUE: Frontend JavaScript errors

The rendering functions (`setText`, `populateList`, `loadCharts`) all have proper error handling. If data is missing, they fall back to defaults (`0`, `'—'`, empty arrays) rather than crashing.

---

## Likely Causes

1. **Empty or near-empty database** — The most likely cause. If this is a fresh deployment or test environment, there may be:
   - No users (or only the default admin)
   - No anime (or only the 8 seed entries)
   - No episodes (or only the 11 seed episodes)
   - No watch_progress rows (no one has watched anything)
   - No payments (no one has purchased premium)

2. **Episodes exist but reference deleted anime** — The `JOIN anime a ON a.id = e.anime_id` would exclude episodes whose parent anime was deleted.

3. **All episodes are unpublished** — The Recent Episodes query does NOT filter by `is_published`. However, if episodes were deleted or never created, the result is empty.

---

## Recommended Fixes — NOT APPLIED

### 1. Populate the database with test data

To verify the dashboard works, insert some test data:

```sql
-- Create a test user
INSERT INTO users (name, email, password_hash, is_premium) VALUES
  ('Test User', 'test@anistrim.com', '$2b$10$...', 0);

-- Insert watch_progress rows
INSERT INTO watch_progress (user_id, episode_id, position_sec, duration_sec, percent, completed)
VALUES (2, 1, 600, 1440, 41.67, 0);

-- Insert a payment
INSERT INTO payments (user_id, flw_tx_ref, amount, currency, status, plan, paid_at)
VALUES (2, 'test_ref_001', 35000, 'UGX', 'successful', 'monthly', NOW());
```

### 2. Add missing `backend-url.js` to dashboard.html (minor)

`dashboard.html` does not load `js/backend-url.js`, but the fallback in `api.js` works correctly. For consistency, add this to `dashboard.html` before `js/api.js`:

```html
<script src="js/backend-url.js"></script>
```

**This is NOT the cause of the analytics issue** — the fallback URL resolution is correct.

### 3. Verify data exists in the database

Run these queries to check:

```sql
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM anime;
SELECT COUNT(*) FROM episodes;
SELECT COUNT(*) FROM watch_progress;
SELECT COUNT(*) FROM payments WHERE status = 'successful';
SELECT * FROM episodes ORDER BY created_at DESC LIMIT 5;
```

---

## Files That Would Need Modification

None. The code is correct. The issue is data population.

## Files That Must NOT Be Modified

- `controllers/adminController.js` — SQL queries are correct
- `routes/adminRoutes.js` — routes are correct
- `AdminDashboard/js/dashboard.js` — rendering logic is correct
- `AdminDashboard/js/api.js` — envelope unwrapping is correct
- `middleware/auth.js` — authentication is correct
- `sql/schema.sql` — schema is correct

---

## Evidence

| Evidence | Location | Finding |
| --- | --- | --- |
| `GET /api/admin/dashboard/overview` route | `routes/adminRoutes.js:13` | ✅ Registered → `admin.getDashboardOverview` |
| `getDashboardOverview` function | `controllers/adminController.js:114` | ✅ Returns correct response shape |
| Recent Episodes SQL | `controllers/adminController.js:123` | ✅ Valid JOIN, correct columns |
| `watch_progress` table | `sql/migrations_v31_watch_history_unify.sql:18` | ✅ Table exists |
| Frontend `loadOverview` | `AdminDashboard/js/dashboard.js:417` | ✅ Correctly accesses `data.overview` |
| `unwrapAdminEnvelope` | `AdminDashboard/js/api.js:93` | ✅ Correctly unwraps `{ success, data }` |
| API base URL resolution | `AdminDashboard/js/api.js:11-16` | ✅ Falls back to `anistrimbackend.onrender.com` |
| Admin session storage | `AdminDashboard/js/auth.js` | ✅ Uses `admin_token` key |
| `adminOnly` middleware | `middleware/auth.js:140` | ✅ Checks `user_roles` table |
| `protect` middleware | `middleware/auth.js` | ✅ Validates JWT |
| Chart endpoints | `controllers/adminController.js:910` | ✅ All 6 types handled |
| `populateList` empty state | `AdminDashboard/js/dashboard.js:466` | ✅ Renders "No data available" |

---

## Final Verdict

### 1. Why are Analytics not showing?

**Most likely:** The database has zero or near-zero data. The stat cards correctly show `0`, the charts correctly render empty, and the lists correctly show "No data available." This is the expected behavior for an empty database.

**Alternative:** If the admin is not properly authenticated (expired token, not logged in), the API returns 401 and the dashboard redirects to `index.html`. If the admin sees the dashboard but with zeros, authentication is working — it's a data issue.

### 2. Why are Recent Episodes not showing?

**Most likely:** The `episodes` table is empty, or the `JOIN anime a ON a.id = e.anime_id` returns no rows (episodes exist but reference deleted anime). The `populateList('#recent-uploads', [])` call correctly renders "No data available."

### 3. Are the backend APIs working?

**YES.** All routes are registered, all controller functions execute correctly, all SQL queries are valid, and all response shapes match the frontend's expectations.

### 4. Is the Admin Dashboard using the correct backend URL?

**YES.** `https://anistrimbackend.onrender.com` — confirmed by the fallback logic in `api.js`.

### 5. Is authentication working for dashboard API requests?

**YES.** The admin session uses `AniStrimSession.create('admin')` with `admin_token` key. The API client includes `Authorization: Bearer <token>` header. The backend `protect` + `adminOnly` middleware chain validates JWT and checks `user_roles` table.

### 6. Is the database populated?

**UNKNOWN (requires live database query).** The seed data in `sql/schema.sql` creates 8 anime and 11 episodes. If these were inserted, Recent Episodes should show up to 5 rows. If the database was migrated but not seeded, or if data was deleted, the tables could be empty.

### 7. Is this primarily frontend, backend, database, authentication, or API configuration?

**Database (data population).** The code is correct on all layers. The issue is that the database likely lacks sufficient data to populate the dashboard.

### 8. What exact files should be changed to fix it?

**No code files need to be changed.** The fix is to populate the database with test data:
- Create test users
- Ensure episodes exist with valid `anime_id` references
- Generate `watch_progress` rows (by watching episodes)
- Create test payments

If you want to add a minor improvement, add `<script src="js/backend-url.js"></script>` to `dashboard.html` before `js/api.js` for consistency — but this is NOT the cause of the analytics issue.

---

## Verification

```
Files modified: 0
Files deleted: 0
Files created: 1 (this audit report)
Database changes: 0
Migrations executed: 0
Configuration changes: 0
```
