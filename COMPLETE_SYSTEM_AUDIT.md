# AniStrim Complete End-to-End System Audit

## Phase A: Admin Dashboard CMS Restoration

### (Highest Priority — Broken Functionality)

### 1. Anime Page

| Action                       | Status | Issue                                                                                               |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| Add Anime                    | ⚠️     | Modal works, but form submission uses FormData for checkboxes which may send "on"/"off" not "1"/"0" |
| Edit Anime                   | ⚠️     | Modal populates but needs verification                                                              |
| Delete Anime                 | ✅     | Fixed with `_confirm()`                                                                             |
| View Details                 | ⚠️     | Modal has fallback logic showing stale data on API failure                                          |
| Bulk Delete                  | ❌     | Uses old custom confirm modal, not `_confirm()`                                                     |
| Bulk Featured/Premium/Status | ❌     | Same — uses old confirm modal                                                                       |
| Select All                   | ✅     | Works                                                                                               |
| Individual Selection         | ✅     | Works                                                                                               |
| Import Anime                 | ⚠️     | Kitsu search works, import may fail silently                                                        |
| Sync Metadata                | ⚠️     | Button exists, endpoint exists, untested                                                            |
| Search                       | ✅     | Works                                                                                               |
| Filters                      | ✅     | Works                                                                                               |
| Sorting                      | ✅     | Works                                                                                               |
| Pagination                   | ✅     | Works                                                                                               |
| Badges                       | ❌     | Uses inline HTML instead of `Badge.status()`, `Badge.featured()`, `Badge.premium()`                 |

### 2. Episodes Page (Worst — Most Broken)

| Action              | Status | Issue                                                        |
| ------------------- | ------ | ------------------------------------------------------------ |
| Add Episode         | ❌     | No modal, no form, no button handler                         |
| Edit Episode        | ❌     | References `window.openEpisodeModal(id)` which doesn't exist |
| Delete Episode      | ❌     | Uses `window.confirm()` instead of `_confirm()`              |
| Bulk Delete         | ❌     | No handler                                                   |
| Search              | ❌     | Missing                                                      |
| Filters             | ❌     | Missing                                                      |
| Pagination          | ❌     | Missing                                                      |
| Sorting             | ❌     | Missing                                                      |
| Loading/Empty/Error | ❌     | All inline HTML instead of shared components                 |

### 3. Users Page

| Action              | Status | Issue                                                                 |
| ------------------- | ------ | --------------------------------------------------------------------- |
| Edit User           | ❌     | No edit modal                                                         |
| Delete User         | ❌     | Uses `window.confirm()`                                               |
| Suspend/Unban       | ❌     | Uses `window.confirm()`                                               |
| Premium Management  | ❌     | No premium toggle or expiry display                                   |
| Watch/Login History | ❌     | Missing                                                               |
| Badges              | ❌     | Inline instead of `Badge.role()`, `Badge.premium()`, `Badge.status()` |
| Loading/Empty/Error | ❌     | Inline HTML                                                           |

### 4. Payments Page

| Action              | Status | Issue   |
| ------------------- | ------ | ------- |
| Search              | ❌     | Missing |
| Date Range          | ❌     | Missing |
| Status Filter       | ❌     | Missing |
| Pagination          | ❌     | Missing |
| Export CSV          | ❌     | Missing |
| Refund Workflow     | ❌     | Missing |
| Transaction Details | ❌     | Missing |

### 5. Genres Page

| Action       | Status | Issue                                      |
| ------------ | ------ | ------------------------------------------ |
| Edit Genre   | ❌     | No edit functionality                      |
| Delete Genre | ❌     | Uses `window.confirm()` + inline `onclick` |
| Search       | ❌     | Missing                                    |
| Pagination   | ❌     | Missing                                    |

### 6. Ads Page

| Action               | Status | Issue                    |
| -------------------- | ------ | ------------------------ |
| Scheduling           | ❌     | No date-range scheduling |
| Placement Management | ❌     | Missing                  |
| Delete Ad            | ❌     | Uses `window.confirm()`  |

### 7. Logs Page

| Action       | Status | Issue   |
| ------------ | ------ | ------- |
| Categories   | ❌     | Missing |
| Search       | ❌     | Missing |
| Date Filters | ❌     | Missing |
| Pagination   | ❌     | Missing |
| Export       | ❌     | Missing |
| Auto Refresh | ❌     | Missing |

### 8. Settings Page

| Action          | Status | Issue                |
| --------------- | ------ | -------------------- |
| Validation      | ❌     | No form validation   |
| Reset           | ❌     | No reset to defaults |
| Import/Export   | ❌     | Missing              |
| Category Groups | ❌     | No grouping          |

---

## Phase B: Frontend Application Audit

### Authentication Flow

| Step                           | Status | Notes                                                    |
| ------------------------------ | ------ | -------------------------------------------------------- |
| GET /api/auth/google/client-id | ✅     | Endpoint exists                                          |
| POST /api/auth/google/verify   | ✅     | Controller exists, properly handles create/link/existing |
| POST /api/auth/login           | ✅     | Works, handles Google-only accounts gracefully           |
| POST /api/auth/signup          | ✅     | Works                                                    |
| JWT Token                      | ✅     | 7-day expiry                                             |
| Admin redirect                 | ✅     | `data.user.isAdmin ? 'admin.html' : 'index.html'`        |
| Error handling                 | ✅     | Meaningful user-facing messages                          |
| auth popup GIS flow            | ✅     | In-app popup, no redirect, proper retry/timeout          |

### Watch Page Flow

| Step                   | Status | Notes                                                                               |
| ---------------------- | ------ | ----------------------------------------------------------------------------------- |
| Load anime data        | ✅     | Works                                                                               |
| Load episodes list     | ✅     | Works                                                                               |
| Find current episode   | ⚠️     | May fail if `epId` doesn't match DB record — fallback chain exists but confusing    |
| Check premium lock     | ✅     | Works                                                                               |
| Play from DB video_url | ✅     | Works                                                                               |
| Stream via API         | ✅     | resolveAndPlayStream works with fallback                                            |
| HLS support            | ✅     | Works via hls.js                                                                    |
| Save progress          | ✅     | Works every 10s                                                                     |
| Resume playback        | ✅     | Works                                                                               |
| Skip intro             | ✅     | Works for premium                                                                   |
| Autoplay next          | ✅     | Works for premium                                                                   |
| Next episode banner    | ✅     | Works                                                                               |
| Mid-roll ads (free)    | ✅     | Works every 10 min                                                                  |
| Download               | ⚠️     | `downloadEpisode()` creates an `<a>` tag with API token in URL — **SECURITY ISSUE** |
| Provider switcher      | ✅     | Works                                                                               |

### Home/Browse/Details

| Feature                   | Status | Notes                   |
| ------------------------- | ------ | ----------------------- |
| Hero slider               | ✅     | Works                   |
| Trending/Popular/New rows | ✅     | Works                   |
| Continue Watching         | ✅     | Works                   |
| Browse search             | ✅     | Works                   |
| Browse genre filter       | ✅     | Works                   |
| Browse status filter      | ✅     | Works                   |
| Browse error handling     | ✅     | Reload with retry       |
| Details page              | ✅     | Works with backup fetch |
| Episode list on details   | ✅     | Works with retry        |
| Watchlist add             | ✅     | Works                   |
| Premium UI                | ✅     | Badge, upgrade prompts  |

---

## Phase C: Backend Audit

### Auth Routes

| Route                          | Status | Notes                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------------------- |
| POST /api/auth/login           | ✅     | Has validation, error handling, last_login update                         |
| POST /api/auth/signup          | ✅     | Has validation, duplicate check, last_login update                        |
| POST /api/auth/google/verify   | ✅     | Full verification chain: issuer, audience, email_verified, find-or-create |
| GET /api/auth/google/client-id | ✅     | Returns client ID from env                                                |

### Admin Routes

| Route                                | Status | Notes                                                                                                       |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| GET /admin/stats                     | ✅     | Same as dashboard/overview                                                                                  |
| GET /admin/dashboard/overview        | ✅     | Complex query with joins, fallback for missing tables                                                       |
| GET /admin/dashboard/health          | ✅     | NEW — added in Phase E                                                                                      |
| GET /admin/dashboard/charts/:type    | ✅     | NEW — 6 chart types                                                                                         |
| GET /admin/dashboard/activity/recent | ✅     | NEW — unified timeline                                                                                      |
| GET /admin/users                     | ✅     | Works                                                                                                       |
| PUT /admin/users/:id                 | ✅     | Works                                                                                                       |
| POST /admin/users/bulk-delete        | ✅     | Works, prevents self-delete                                                                                 |
| GET /admin/anime                     | ✅     | Pagination, filters, sorting, genre join                                                                    |
| GET /admin/anime/:id                 | ✅     | Returns genres + episode count                                                                              |
| POST /admin/anime                    | ✅     | Uses schema-aware column insertion                                                                          |
| PUT /admin/anime/:id                 | ✅     | Schema-aware                                                                                                |
| DELETE /admin/anime/:id              | ✅     | Cleans up Cloudinary assets                                                                                 |
| PUT /admin/anime/bulk                | ✅     | 6 valid actions                                                                                             |
| POST /admin/anime/bulk-delete        | ✅     | Cleans up assets                                                                                            |
| GET /admin/anime/import/search       | ✅     | Consumet search                                                                                             |
| POST /admin/anime/import             | ✅     | Consumet import                                                                                             |
| PUT /admin/anime/:id/sync            | ✅     | Consumet sync                                                                                               |
| GET /admin/genres                    | ✅     | Works                                                                                                       |
| POST /admin/genres                   | ✅     | Works                                                                                                       |
| DELETE /admin/genres/:id             | ✅     | Works                                                                                                       |
| POST /admin/anime/:animeId/episodes  | ✅     | Works                                                                                                       |
| GET /admin/anime/:animeId/episodes   | ✅     | Works                                                                                                       |
| GET /admin/episodes                  | ✅     | Works                                                                                                       |
| GET /admin/episodes/:id              | ✅     | Works                                                                                                       |
| PUT /admin/episodes/:id              | ✅     | Schema-aware                                                                                                |
| DELETE /admin/episodes/:id           | ✅     | Cleans up assets                                                                                            |
| POST /admin/episodes/bulk-delete     | ✅     | Cleans up assets                                                                                            |
| GET /admin/settings                  | ✅     | Works                                                                                                       |
| PUT /admin/settings                  | ✅     | Works                                                                                                       |
| GET /admin/ads                       | ✅     | Works                                                                                                       |
| POST /admin/ads                      | ✅     | Works                                                                                                       |
| PUT /admin/ads/:id                   | ✅     | Works                                                                                                       |
| DELETE /admin/ads/:id                | ✅     | Works                                                                                                       |
| GET /admin/payments                  | ❌     | **Doesn't exist** — payments.js calls `/api/admin/payments` but route is `PUT /api/admin/payments/:id` only |
| PUT /admin/payments/:id              | ✅     | Works                                                                                                       |
| GET /admin/logs                      | ✅     | Works, supports both activity_logs and admin_logs tables                                                    |

### Missing Backend Endpoints

1. **`GET /api/admin/payments`** — Payments list with pagination (CRITICAL — payments.js calls this but route doesn't exist)
2. **`PUT /api/admin/genres/:id`** — Update genre name
3. **`GET /api/admin/users/:id`** — Single user details
4. **`GET /api/admin/users/:id/watch-history`** — Watch history
5. **`GET /api/admin/users/:id/login-history`** — Login history
6. **`POST /api/admin/payments/:id/refund`** — Refund workflow
7. **`GET /api/admin/ads/:id/stats`** — Ad performance
8. **`GET /api/admin/logs?category&search&from&to&page&limit`** — Filtered logs
9. **`POST /api/admin/settings/import`** — Import settings
10. **`GET /api/admin/settings/export`** — Export settings

---

## Phase D: Security Audit

### Issues Found

| Issue                     | SeverITY | Location                     | Details                                                                                                                                                     |
| ------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT token in URL          | **HIGH** | watch.js `downloadEpisode()` | `a.href = API + '/api/download/' + ep.id + '?token=' + encodeURIComponent(token)` — Token exposed in URL, logged in server logs, visible in browser history |
| Inline onclick handlers   | MEDIUM   | genres.js                    | `onclick="deleteGenre(${g.id})"` — XSS vector if genre names are user-controllable                                                                          |
| XSS via description       | LOW      | Multiple                     | `_escapeHTML()` used in most places but not consistently                                                                                                    |
| SQL Injection             | ✅ SAFE  | All                          | Parameterized queries throughout                                                                                                                            |
| JWT verification          | ✅ SAFE  | middleware/auth.js           | Proper `jwt.verify()`                                                                                                                                       |
| Google token verification | ✅ SAFE  | googleVerifyController.js    | Proper `OAuth2Client.verifyIdToken()` with audience + issuer check                                                                                          |
| Password hashing          | ✅ SAFE  | authController.js            | bcrypt with salt                                                                                                                                            |

---

## Phase E: Performance Audit

| Area                   | Status | Notes                                                                         |
| ---------------------- | ------ | ----------------------------------------------------------------------------- |
| DB Pool Size           | ⚠️     | `connectionLimit: 3` — Very low, may cause queueing under load                |
| No Redis Cache         | ⚠️     | Cache service exists but Redis may not be configured                          |
| Streaming Cache        | ✅     | 5-min TTL on stream results                                                   |
| Large Payloads         | ⚠️     | `/api/admin/anime` returns all fields including descriptions — could be heavy |
| Image Optimization     | ⚠️     | No lazy loading in admin dashboard, no WebP/AVIF                              |
| Unnecessary Re-renders | ⚠️     | Dashboard `loadOverview()` replaces all content on 30s interval               |

---

## Summary: Files Requiring Modification

### Backend

| File                             | Changes                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `controllers/adminController.js` | Add `getPayments()`, add genre update, add user detail endpoints |
| `routes/adminRoutes.js`          | Add missing routes                                               |
| `routes/paymentRoutes.js`        | Verify admin payments endpoint exists                            |

### Admin Dashboard Frontend

| File                            | Changes                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| `AdminDashboard/js/anime.js`    | Fix bulk confirm to use `_confirm()`, use Badge component                |
| `AdminDashboard/js/episodes.js` | Complete rewrite — DataTable, modals, search, filters, pagination        |
| `AdminDashboard/js/users.js`    | Add edit modal, use Badge, use shared components                         |
| `AdminDashboard/js/payments.js` | Add search, filters, pagination, export                                  |
| `AdminDashboard/js/genres.js`   | Add edit, use shared components, remove inline onclick                   |
| `AdminDashboard/js/ads.js`      | Use `_confirm()`, add scheduling                                         |
| `AdminDashboard/js/logs.js`     | Complete rewrite — DataTable, categories, filters, pagination, export    |
| `AdminDashboard/js/settings.js` | Add validation, reset, category groups                                   |
| `AdminDashboard/dashboard.html` | Add episode modals, user modals, payment details modal, genre edit modal |

### Frontend (User-Facing)

| File                | Changes                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `Frontend/watch.js` | Fix `downloadEpisode()` — use POST with body instead of GET with token in URL |

---

## Implementation Order

### First: Fix Critical Issues

1. **Add `GET /api/admin/payments`** — Payments page is completely broken without this
2. **Fix `downloadEpisode()` token leak** — Security issue
3. **Fix bulk confirm in anime.js** — Use `_confirm()` consistently

### Second: Restore Broken CMS Modules

4. **Episodes** — Complete rewrite (most broken module)
5. **Users** — Add edit modal, use Badge
6. **Payments** — Add search, filters, pagination
7. **Genres** — Add edit, remove inline onclick
8. **Ads** — Use `_confirm()`
9. **Logs** — Complete rewrite
10. **Settings** — Add validation, reset

### Third: Apply Shared Components

11. Replace inline badges with `Badge.*` throughout
12. Replace inline loading/empty/error with shared components
13. Convert tables to `DataTable`

### Fourth: Regression Test

14. Test every CRUD operation on every page
15. Test Google auth flow end-to-end
16. Test streaming pipeline with each provider
17. Verify no console errors
