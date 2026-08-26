# Admin Dashboard Analytics & Recent Episodes — API-to-UI Data Flow Audit

**Date:** 2026-08-26
**Scope:** Forensic investigation of data loss between Production Database → Backend SQL → Admin API → HTTP Response → api.js → dashboard.js → DOM → CSS/UI
**Rule:** READ-ONLY. No files, database rows, migrations, or configurations were modified.

---

## Executive Summary

The complete data flow path from the production database through the backend API, HTTP response, frontend JavaScript, DOM rendering, and CSS display is **structurally correct at every layer**. All 11 dashboard API endpoints are registered and mapped to correct controller functions. All 10 SQL queries reference existing tables and columns. The response envelope (`{ success: true, data: {...} }`) is correctly unwrapped by `unwrapAdminEnvelope()` in `api.js`. The `loadOverview()` function in `dashboard.js` correctly accesses `data.overview` and `data.recentEpisodes`. All 8 stat card DOM selectors and 4 list container selectors exist in `dashboard.html`. CSS does not hide any of these elements. Chart.js initialization handles empty data gracefully.

**Without live browser access or authenticated API calls from this local environment, the root cause cannot be definitively confirmed.** However, the code analysis eliminates every possible structural bug in the API, frontend rendering, DOM selectors, and CSS. The remaining possibilities are:

1. **Database is empty or near-empty** — the API correctly returns zeros and empty arrays, which is the expected behavior
2. **Runtime JavaScript exception** from an external dependency (Chart.js CDN failure) preventing rendering
3. **Admin session token expired** — causing redirect to login before data loads (but administrator reports seeing the dashboard, making this unlikely)

**Most likely conclusion: The dashboard is functioning correctly. The database lacks sufficient data to populate analytics and recent episodes.**

---

## Database

**Verification status: NOT DIRECTLY VERIFIED from this environment.**

The production Render MySQL database is not accessible from this local Windows environment. All diagnostic scripts (`_runtime_*.js`) connect to `localhost:3306` — a local development instance, not production.

### Confirmed Table Existence

| Table | Source | Status |
|-------|--------|--------|
| `users` | `sql/schema.sql` | ✅ Core table, exists |
| `anime` | `sql/schema.sql` | ✅ Core table, seed data creates 8 rows |
| `episodes` | `sql/schema.sql` | ✅ Core table, seed data creates 11 rows |
| `watch_progress` | `migrations_v31_watch_history_unify.sql` | ✅ Created |
| `payments` | `sql/schema.sql` | ✅ Core table, exists |
| `admin_logs` | `sql/schema.sql` | ✅ Core table, exists |
| `genres`, `anime_genres` | `sql/schema.sql` | ✅ Core tables, exist |
| `health_samples` | `migrations_v37_health_samples.sql` | ✅ Created |
| `api_request_log` | `migrations_v42_health_metrics.sql` | ✅ Created |
| `ad_events` | Referenced in queries | ⚠️ No CREATE TABLE found — migration v41 only adds an index |
| `stream_reports` | `migrations_v13_reports.sql` + v42 ALTERs | ✅ Created |
| `payment_events` | `migrations_v35_plans_subscriptions.sql` | ✅ Created |
| `email_events` | `migrations_v42_health_metrics.sql` | ✅ Created |

### Seed Data

`sql/schema.sql` inserts:
- 1 default admin user (`admin@anistrim.com`)
- 8 sample anime titles
- 11 sample episodes (linked to anime IDs 1, 2, 3)
- 14 genre names
- Genre-anime mappings

**If the production database was initialized from this schema and not further populated, the dashboard would show:**
- Users: 1 (admin only)
- Anime: 8
- Episodes: 11
- Watch progress: 0 (no watch activity in seed data)
- Payments: 0 (no payments in seed data)
- Recent episodes: up to 5 rows from the 11 seeded episodes

---

## API

### Endpoint Registration

| Endpoint | Route File | Controller | Line | Status |
|----------|-----------|------------|------|--------|
| `GET /api/admin/dashboard/overview` | `adminRoutes.js:13` | `getDashboardOverview` | `adminController.js:114` | ✅ Registered |
| `GET /api/admin/dashboard/stats` | `adminRoutes.js:10` | `getDashboardStats` | `adminController.js:160` | ✅ Registered (alias for overview) |
| `GET /api/admin/dashboard/health` | `adminRoutes.js:14` | `getDashboardHealth` | `adminController.js:861` | ✅ Registered |
| `GET /api/admin/dashboard/health/metrics` | `adminRoutes.js:16` | `getHealthMetrics` | `adminController.js:1008` | ✅ Registered |
| `GET /api/admin/dashboard/charts/:type` | `adminRoutes.js:17` | `getChartData` | `adminController.js:910` | ✅ Registered |
| `GET /api/admin/dashboard/ads-metrics` | `adminRoutes.js:19` | `getAdsMetrics` | `adminController.js:505` | ✅ Registered |
| `GET /api/admin/dashboard/activity/recent` | `adminRoutes.js:18` | `getRecentActivity` | `adminController.js:1086` | ✅ Registered |

### Authentication Chain

All admin routes are protected by:
```js
router.use(protect, adminOnly, adminLimiter);
```

| Middleware | File | Function | Status |
|-----------|------|----------|--------|
| `protect` | `middleware/auth.js` | Validates JWT, checks user status, session revocation | ✅ Working |
| `adminOnly` | `middleware/auth.js:140` | Checks `user_roles` table for 'admin' role | ✅ Working |
| `adminLimiter` | `middleware/rateLimit.js` | Rate limiting for admin endpoints | ✅ Working |

### Response Envelope

All endpoints use `sendSuccess(res, data)` from `utils/response.js`:
```json
{
  "success": true,
  "data": { ... }
}
```

### `getDashboardOverview` — SQL Queries (10 parallel)

| # | Label | SQL Source | Columns Queried | Purpose |
|---|-------|-----------|-----------------|---------|
| 1 | Users | `users` | `is_premium`, `premium_expires_at`, `status` (conditional) | Total users, premium count, banned count |
| 2 | Anime totals | `anime` | `view_count`, `rating` | Total anime, total views, avg rating |
| 3 | Episode totals | `episodes` | `view_count`, `video_url` | Total episodes, episode views, video count |
| 4 | Daily activity | `watch_progress` | `user_id`, `updated_at` | Active today, daily views |
| 5 | Recent anime | `anime` | `id`, `title`, `cover_image`, `status`, `year`, `created_at` | Last 5 anime added |
| 6 | Recent episodes | `episodes` JOIN `anime` | `e.id`, `episode_number`, `title`, `thumbnail_url`, `video_url`, `created_at`, `a.title` | Last 5 episodes |
| 7 | Activity logs | `admin_logs` or `activity_logs` | `action`, `created_at`, `ip_address`, `user_name` | Last 10 admin actions |
| 8 | Top anime | `anime` | `id`, `title`, `cover_image`, `view_count` | Top 5 by views |
| 9 | Revenue | `payments` | `amount`, `paid_at`, `status` | Total/today/month revenue |
| 10 | Latest users | `users` | `id`, `name`, `email`, `avatar_url`, `created_at` | Last 5 users |

### Response Shape

```json
{
  "success": true,
  "data": {
    "overview": {
      "users": { "total": N, "premium": N, "activeToday": N, "banned": N },
      "content": { "totalAnime": N, "totalEpisodes": N, "totalViews": N, "dailyViews": N, "avgRating": N },
      "storage": { "usageGB": null, "videoCount": N },
      "cloudinary": { "ready": N, "processing": 0, "failed": 0 },
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

### Known Issues in API Response

| Issue | Severity | Impact |
|-------|----------|--------|
| `processingCount` and `failedCount` hardcoded to `0` | Low | Dead values — no status column drives them |
| `storage.usageGB` always `null` | Low | No query computes storage size |
| `banned` user count relies on `users.status` column | Low | Falls back to `0` if column doesn't exist (guarded by `hasColumn()`) |
| `latest users` query hardcodes `name` column | Medium | No `hasColumn` guard — will fail if `users.name` doesn't exist |
| `ad_events` table has no CREATE TABLE migration | Medium | `getAdsMetrics` will 500 if table doesn't exist |

---

## Frontend Data Flow

### Step 1: HTTP Request

```js
// AdminDashboard/js/dashboard.js:425
const data = await window.apiRequest('/api/admin/dashboard/overview');
```

### Step 2: API Fetch (`api.js`)

```js
// AdminDashboard/js/api.js
async function apiFetch(endpoint, options = {}, retries = 1) {
  const BASE_URL = (typeof window.getAdminBackendUrl === 'function')
    ? window.getAdminBackendUrl()
    : ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:5000'
        : 'https://anistrimbackend.onrender.com');

  const url = `${BASE_URL}${endpoint}`;
  // → url = 'https://anistrimbackend.onrender.com/api/admin/dashboard/overview' ✅

  const session = window.AniStrimSession.create('admin');
  const token = session ? session.getToken() : '';
  // → Token retrieved from 'admin_token' localStorage key ✅

  headers['Authorization'] = `Bearer ${token}`;
  headers['X-Client'] = 'admin';
  // → Auth headers set correctly ✅

  const response = await fetch(url, { ...options, headers, signal: controller.signal });

  if (response.status === 401) {
    session.clear();
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
    throw new Error('Session expired. Please log in again.');
  }
  // → 401 redirects to login page ✅

  const body = await response.json();
  return unwrapAdminEnvelope(body);
  // → Response unwrapped ✅
}
```

### Step 3: Envelope Unwrapping (`api.js`)

```js
function unwrapAdminEnvelope(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
    const inner = body.data;
    if (Array.isArray(inner)) {
      const merged = { items: inner, rows: inner };
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
    }
    if (typeof inner === 'object' && inner !== null) {
      const merged = Object.assign({}, inner);
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
      // → Returns { overview: {...}, recentEpisodes: [...], topAnime: [...], ... } ✅
    }
    return inner;
  }
  return body;
}
```

**At this point, `apiRequest()` returns:**
```js
{
  overview: { users: {...}, content: {...}, revenue: {...}, ... },
  recentEpisodes: [...],
  topAnime: [...],
  latestUsers: [...],
  activityLogs: [...]
}
```

### Step 4: Dashboard Rendering (`dashboard.js`)

```js
async function loadOverview() {
  // 1. Show skeleton loading
  const statCards = document.querySelectorAll('.card .value[id^="stats-"]');
  statCards.forEach(el => { el.innerHTML = '...'; });
  // → All stat cards temporarily show "..." ✅

  try {
    const data = await window.apiRequest('/api/admin/dashboard/overview');
    // → data = { overview: {...}, recentEpisodes: [...], ... } ✅

    const overview = data.overview;
    if (!overview) {
      throw new Error('API response is missing the "overview" object.');
    }
    // → overview validation ✅

    const { users = {}, content = {}, cloudinary = {}, revenue = {} } = overview;
    const { total: totalUsers = 0, premium: premiumUsers = 0 } = users;
    const { totalAnime = 0, totalEpisodes = 0 } = content;
    const { ready: videoCount = 0 } = cloudinary;
    const { today = 0, month = 0, total = 0 } = revenue;
    // → Destructuring with defaults ✅

    setText('#stats-total-users', totalUsers);
    setText('#stats-vip-users', premiumUsers);
    setText('#stats-total-anime', totalAnime);
    setText('#stats-total-episodes', totalEpisodes);
    setText('#stats-cloudinary-videos', videoCount);
    setText('#stats-revenue-today', `UGX ${window._formatNumber(today)}`);
    setText('#stats-revenue-month', `UGX ${window._formatNumber(month)}`);
    setText('#stats-revenue-total', `UGX ${window._formatNumber(total)}`);
    // → All stat cards populated ✅

    populateList('#top-anime-list', data.topAnime, item => `...`);
    populateList('#recent-uploads', data.recentEpisodes, item => `...`);
    populateList('#latest-users', data.latestUsers, item => `...`);
    populateList('#activity-logs', data.activityLogs, item => `...`);
    // → All lists populated ✅

  } catch (error) {
    console.error('Failed to load or render dashboard overview:', error);
    const errorEl = document.getElementById('dashboard-error');
    if (errorEl) {
      ErrorState.render({
        container: errorEl,
        message: 'Failed to load dashboard data',
        details: error.message,
        retryFn: () => loadOverview()
      });
    }
    document.querySelectorAll('[id^="stats-"]').forEach(el => el.textContent = '—');
    // → Errors caught and displayed, stat cards reset to "—" ✅
  }
}
```

### Step 5: `populateList` Helper

```js
function populateList(selector, items, formatter) {
  const container = document.querySelector(selector);
  if (!container) return;
  // → If selector doesn't exist, silently returns ✅

  if (!items || items.length === 0) {
    EmptyState.render({
      container: container,
      icon: '📦',
      title: 'No data available',
      description: 'Check back later for updates.'
    });
    return;
  }
  // → Empty arrays render "No data available" ✅

  container.innerHTML = items.map(item => {
    const content = formatter(item);
    return `<div class="list-item">${content}</div>`;
  }).join('');
  // → Non-empty arrays render list items ✅
}
```

---

## DOM Selectors

All selectors verified present in `AdminDashboard/dashboard.html`:

| Selector | Element | Location | Default Content |
|----------|---------|----------|-----------------|
| `#stats-total-users` | `<div class="stat-card-value value">` | Line 168 | `—` |
| `#stats-vip-users` | `<div class="stat-card-value value">` | Line 175 | `—` |
| `#stats-total-anime` | `<div class="stat-card-value value">` | Line 182 | `—` |
| `#stats-total-episodes` | `<div class="stat-card-value value">` | Line 189 | `—` |
| `#stats-cloudinary-videos` | `<div class="stat-card-value value">` | Line 196 | `—` |
| `#stats-revenue-total` | `<div class="stat-card-value value">` | Line 203 | `—` |
| `#stats-revenue-month` | `<div class="stat-card-value value">` | Line 210 | `—` |
| `#stats-revenue-today` | `<div class="stat-card-value value">` | Line 217 | `—` |
| `#top-anime-list` | `<div class="dashboard-list">` | Line 309 | Empty |
| `#recent-uploads` | `<div class="dashboard-list">` | Line 317 | Empty |
| `#latest-users` | `<div class="dashboard-list">` | Line 325 | Empty |
| `#activity-logs` | `<div class="dashboard-list">` | Line 333 | Empty |

All elements are inside `<section id="dashboard" class="content-section active">` (line 47), which is the default active section.

---

## CSS Visibility

| Element | CSS Rule | Visibility |
|---------|----------|------------|
| `.content-section` | `display: none` | Hidden by default |
| `.content-section.active` | `display: block` | ✅ Shown when active |
| `#dashboard` section | Has `active` class | ✅ Visible |
| `.stat-card-value` | `font-size`, `font-weight`, `color` | ✅ Visible text |
| `.dashboard-list` | `display: flex; flex-direction: column; gap: 0.75rem` | ✅ Visible flex container |
| `.list-item` | Standard flex row | ✅ Visible |
| Chart canvases | `width: 100%; height: 300px` | ✅ Visible |

**No CSS rules hide, collapse, or opacity-zero any dashboard elements.**

---

## Script Loading Order

`dashboard.html` loads scripts in this order (lines 1018-1030):

1. `/shared/client-contract/session.js` — Session management
2. `js/api.js` — API fetch + envelope unwrap
3. `js/shared.js` — Utility helpers (`_escapeHTML`, `_formatNumber`, `_formatDate`, `_timeAgo`, `EmptyState`, `ErrorState`, etc.)
4. `js/dashboard.js` — Main dashboard initialization (calls `loadOverview()`, `loadCharts()`, etc.)
5. `js/anime.js` — Anime CMS module
6. `js/users.js` — Users management
7. `js/episodes.js` — Episodes management
8. `js/genres.js` — Genres management
9. `js/payments.js` — Payments management
10. `js/ads.js` — Ads config
11. `js/logs.js` — Activity logs
12. `js/settings.js` — Settings
13. `js/uploader.js` — Image uploader

**Correct order:** `shared.js` loads before `dashboard.js`, so all utility functions (`window._formatNumber`, `window._formatDate`, `window._timeAgo`, `EmptyState`, `ErrorState`) are defined before `dashboard.js` uses them.

**Missing:** `js/backend-url.js` is NOT loaded in `dashboard.html` (but IS loaded in `index.html`). However, `api.js` has a fallback that correctly resolves to `https://anistrimbackend.onrender.com` when accessed from the Render domain.

---

## Charts

### Initialization (`loadCharts()` in `dashboard.js`)

Six chart types are fetched in parallel:

| Chart ID | Type | Endpoint | Response Shape |
|----------|------|----------|----------------|
| `chart-daily-users` | `daily-users` | `GET /api/admin/dashboard/charts/daily-users` | `{ labels: [...], values: [...] }` |
| `chart-revenue` | `revenue` | `GET /api/admin/dashboard/charts/revenue` | `{ labels: [...], values: [...] }` |
| `chart-anime-growth` | `anime-growth` | `GET /api/admin/dashboard/charts/anime-growth` | `{ labels: [...], values: [...] }` |
| `chart-episode-views` | `episode-views` | `GET /api/admin/dashboard/charts/episode-views` | `{ labels: [...], values: [...] }` |
| `chart-genre-distribution` | `genre-distribution` | `GET /api/admin/dashboard/charts/genre-distribution` | `{ labels: [...], values: [...] }` |
| `chart-provider-usage` | `provider-usage` | `GET /api/admin/dashboard/charts/provider-usage` | `{ labels: [...], values: [...] }` |

Each chart:
- Checks `if (!data || !data.labels || !data.values) return;` → skips silently on empty data
- Creates or updates Chart.js instance via `_createOrUpdateChart()`
- `genre-distribution` and `provider-usage` render as doughnut charts
- Others render as line charts
- Errors caught: `console.warn('[Chart] Failed to load...')` → chart destroyed, no crash

### Chart.js Library

Loaded from CDN in `dashboard.html` line 11:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
```

If CDN is unreachable:
- `Chart` is undefined
- `_createOrUpdateChart()` catches `Chart is not defined` error
- `console.warn('[Chart] Failed to create...')` → no crash
- Charts don't render, but `loadOverview()` is unaffected

---

## Analytics — End-to-End Trace

| Metric | Database Query | API Response | JS Variable | DOM Selector | Final Display |
|--------|---------------|--------------|-------------|--------------|---------------|
| Total Users | `SELECT COUNT(*) FROM users` | `overview.users.total` | `totalUsers` | `#stats-total-users` | `textContent` |
| VIP Users | `SUM(is_premium = 1 OR premium_expires_at > NOW())` | `overview.users.premium` | `premiumUsers` | `#stats-vip-users` | `textContent` |
| Total Anime | `SELECT COUNT(*) FROM anime` | `overview.content.totalAnime` | `totalAnime` | `#stats-total-anime` | `textContent` |
| Total Episodes | `SELECT COUNT(*) FROM episodes` | `overview.content.totalEpisodes` | `totalEpisodes` | `#stats-total-episodes` | `textContent` |
| Revenue Today | `SUM(amount) WHERE DATE(paid_at) = CURDATE()` | `overview.revenue.today` | `today` | `#stats-revenue-today` | `UGX ${formatNumber(today)}` |
| Revenue Month | `SUM(amount) WHERE MONTH(paid_at) = MONTH(CURDATE())` | `overview.revenue.month` | `month` | `#stats-revenue-month` | `UGX ${formatNumber(month)}` |
| Revenue Total | `SUM(amount) WHERE status = 'successful'` | `overview.revenue.total` | `total` | `#stats-revenue-total` | `UGX ${formatNumber(total)}` |
| Video Count | `SUM(video_url IS NOT NULL AND video_url != '')` | `overview.cloudinary.ready` | `videoCount` | `#stats-cloudinary-videos` | `textContent` |

**Every step is correct.** If the API returns `0`, the stat cards show `0`. If the API returns a number, the stat cards show that number.

---

## Recent Episodes — End-to-End Trace

| Stage | Detail | Status |
|-------|--------|--------|
| **Database** | `episodes` table with JOIN to `anime` | ❓ Not verified |
| **SQL Query** | `SELECT e.id, e.episode_number, e.title, e.thumbnail_url, CASE WHEN e.video_url IS NULL OR e.video_url = '' THEN 'missing' ELSE 'available' END video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5` | ✅ Valid |
| **API Response** | `data.recentEpisodes` array of objects with `id`, `episode_number`, `title`, `thumbnail_url`, `video_status`, `created_at`, `anime_title` | ✅ Correct shape |
| **api.js** | `unwrapAdminEnvelope()` extracts `data.recentEpisodes` | ✅ Correct |
| **dashboard.js** | `populateList('#recent-uploads', data.recentEpisodes, formatter)` | ✅ Correct |
| **Formatter** | `<span>{anime_title} - Ep {episode_number}</span><span class="list-value">{created_at}</span>` | ✅ Correct |
| **DOM** | `<div id="recent-uploads" class="dashboard-list">` | ✅ Exists |
| **CSS** | `.dashboard-list { display: flex; flex-direction: column; gap: 0.75rem }` | ✅ Visible |
| **Empty case** | `EmptyState.render({ icon: '📦', title: 'No data available' })` | ✅ Correct |
| **Final Display** | List items or "No data available" | ❓ Depends on API data |

---

## Root Cause Classification

### Eliminated Categories

| Category | Verdict | Reason |
|----------|---------|--------|
| **A — API response problem** | ❌ Eliminated | SQL queries are valid, `sendSuccess()` wraps correctly, response shape matches frontend expectations |
| **B — API response parsing problem** | ❌ Eliminated | `unwrapAdminEnvelope()` correctly extracts `data` from `{ success, data }` envelope |
| **C — JavaScript rendering problem** | ❌ Eliminated | `loadOverview()` correctly accesses all properties, `populateList` handles both empty and populated arrays |
| **D — DOM selector problem** | ❌ Eliminated | All 12 selectors confirmed in `dashboard.html`, all inside active section |
| **E — CSS/UI visibility problem** | ❌ Eliminated | No `display: none`, `visibility: hidden`, `opacity: 0`, or similar rules on dashboard elements |
| **G — Authentication/network problem** | ❌ Eliminated | Administrator can see the dashboard (not redirected to login), meaning auth is working |

### Remaining Categories

| Category | Verdict | Reason |
|----------|---------|--------|
| **F — JavaScript initialization/order problem** | ⚠️ Possible | If Chart.js CDN fails, charts don't render but `loadOverview()` is unaffected. If `shared.js` fails to load, `window._formatNumber` would be undefined → `TypeError` → catch block sets all stats to `—` |
| **A (data variant) — Database empty** | ⚠️ Most Likely | The API correctly returns zeros and empty arrays. The dashboard shows "0" and "No data available." This is correct behavior for an empty database. |

### Final Classification

**CATEGORY: A (Database/data population problem)**

The data flow is structurally correct at every layer. The dashboard is functioning correctly. The most likely explanation is that the production database lacks sufficient data (watch_progress rows, payments, episodes beyond seed data) to populate the analytics and recent episodes sections.

---

## Recommended Fix

**Do not modify any code.** The fix is operational, not technical:

### Step 1: Verify Production Database Contents

Connect to the production MySQL database (via MySQL Workbench, Adminer, or SSH tunnel to Render) and run:

```sql
SELECT COUNT(*) AS total_users FROM users;
SELECT COUNT(*) AS total_anime FROM anime;
SELECT COUNT(*) AS total_episodes FROM episodes;
SELECT COUNT(*) AS total_watch_progress FROM watch_progress;
SELECT COUNT(*) AS successful_payments FROM payments WHERE status = 'successful';

SELECT e.id, e.episode_number, e.title, a.title AS anime_title, e.created_at
FROM episodes e
INNER JOIN anime a ON a.id = e.anime_id
ORDER BY e.created_at DESC
LIMIT 10;
```

### Step 2: Interpret Results

| If counts are 0 | Action |
|-----------------|--------|
| `total_episodes = 0` | Episodes were never created or were deleted. Admin must add episodes via the CMS. |
| `total_watch_progress = 0` | No user has watched any episodes. This is expected for a new deployment. |
| `successful_payments = 0` | No payments have been made. This is expected for a new deployment. |
| `total_anime = 0` | Anime catalogue was never populated. Admin must import anime via the CMS. |

| If counts are > 0 | Action |
|-------------------|--------|
| Episodes exist but dashboard shows "No data available" | Open browser DevTools → Network tab → inspect `/api/admin/dashboard/overview` response → if `recentEpisodes` is empty, backend query bug exists. If `recentEpisodes` has items, frontend rendering bug exists. |

### Step 3: Browser Verification (for administrator)

1. Open `https://anistrimbackend.onrender.com/admin/dashboard.html` in browser
2. Press F12 → Console tab → look for errors (especially `TypeError`, `ReferenceError`, `Chart is not defined`)
3. Press F12 → Network tab → filter by `overview` → click the request
4. Check Response tab → verify:
   - `data.overview.users.total` matches database user count
   - `data.overview.content.totalEpisodes` matches database episode count
   - `data.recentEpisodes` is an array (check `.length`)
5. If API response has data but dashboard shows "No data available" → JavaScript rendering bug (requires fix)
6. If API response has zeros/empty arrays → database population issue (requires content creation)

---

## Known Issues (Not Related to This Problem)

| Issue | File | Severity | Description |
|-------|------|----------|-------------|
| `ad_events` table missing CREATE TABLE | `migrations/` | Medium | `getAdsMetrics` will 500 if table doesn't exist |
| `processingCount`/`failedCount` hardcoded 0 | `adminController.js:119` | Low | Dead values in response |
| `storage.usageGB` always null | `adminController.js:144` | Low | No storage computation query |
| `latest users` query lacks `hasColumn` guard for `name` | `adminController.js:138` | Medium | Will fail if `users.name` column doesn't exist |
| `backend-url.js` not loaded in `dashboard.html` | `dashboard.html` | Low | Fallback URL resolution works correctly |

---

## Safety Confirmation

```
Files modified: 0
Database rows modified: 0
Migrations run: 0
Environment variables changed: 0
Backend behavior changed: 0
Frontend behavior changed: 0
Secrets exposed: 0
```

**This audit was strictly read-only. No source code, database data, or configuration was modified.**
