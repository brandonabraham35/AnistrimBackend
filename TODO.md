# AniStrim Admin Dashboard Restoration & CMS Completion

## Phase 1 — Critical Backend & Security ✅ COMPLETE

- [x] `GET /api/admin/payments` endpoint exists with pagination, search, status/date filtering
- [x] Route `router.get('/payments', admin.getPayments)` exists in adminRoutes
- [x] Download security fixed — uses Authorization header, no token in URL
- [x] Frontend `downloadEpisode()` uses `fetch()` with `Authorization` header

## Phase 1b — Missing Backend Endpoints

- [ ] `PUT /api/admin/genres/:id` — Update genre name (controller + route)
- [ ] `GET /api/admin/users/:id` — Single user details
- [ ] `GET /api/admin/users/:id/watch-history` — Watch history
- [ ] `GET /api/admin/users/:id/login-history` — Login history

## Phase 2 — Shared Component Migration (Anime Page) ✅ COMPLETE

- [x] Anime page uses `_confirm()` for all confirmations
- [x] Users page uses `_confirm()` for all confirmations
- [x] Genres page uses `_confirm()` for all confirmations
- [x] Ads page uses `_confirm()` for all confirmations
- [x] `Badge.role()`, `Badge.premium()`, `Badge.status()` used in users.js
- [x] shared.js provides all shared components globally

## Phase 3 — Restore Broken CMS Modules

### 3a. Episodes — Complete Rewrite

- [ ] Rewrite episodes.js with DataTable, CRUD modals, search, filters, pagination
- [ ] Episode Modal HTML already exists in dashboard.html

### 3b. Users Enhancement

- [x] Edit User Modal HTML added to dashboard.html
- [ ] users.js — Add edit modal handler, premium management, subscription expiry
- [ ] Use SkeletonLoader/EmptyState/ErrorState for loading states

### 3c. Payments Enhancement

- [x] Search, date filter, status filter, pagination controls added to dashboard.html
- [x] Backend `GET /api/admin/payments` endpoint exists with full pagination
- [x] Export CSV button added to dashboard.html
- [ ] payments.js — Wire up search, filters, pagination, export

### 3d. Genres Enhancement

- [x] Edit Genre Modal HTML added to dashboard.html
- [x] Search input added to dashboard.html
- [x] Pagination container added to dashboard.html
- [ ] genres.js — Add edit handler, search, pagination
- [ ] Backend `PUT /api/admin/genres/:id` endpoint needed

### 3e. Ads Enhancement ✅ COMPLETE

- [x] ads.js rewritten with scheduling fields (start/end date)
- [x] Scheduling fields added to ad modal in dashboard.html
- [x] Uses `_confirm()` for delete
- [x] Uses SkeletonLoader/EmptyState/ErrorState for loading states
- [x] Schedule info displayed in ads table

### 3f. Logs — Complete Rewrite ✅ COMPLETE

- [x] logs.js rewritten with categories, search, date range, pagination, export
- [x] Severity badges for different action types
- [x] Log toolbar added to dashboard.html (search, category filter, date range, export)
- [x] Pagination and table info added to dashboard.html

### 3g. Settings Enhancement ✅ COMPLETE

- [x] settings.js rewritten with validation, reset-to-defaults, import/export
- [x] Category groups (General, Premium, Streaming, Maintenance)
- [x] Real-time field validation on blur
- [x] Reset button with confirmation dialog
- [x] Export/Import settings as JSON files

## Phase 4 — End-to-End Regression Testing

- [ ] Test every CRUD operation on every page
- [ ] Test Google auth flow end-to-end
- [ ] Test streaming pipeline
- [ ] Verify no console errors
