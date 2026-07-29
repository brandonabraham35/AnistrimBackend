# AniStrim Admin Dashboard Restoration & CMS Completion Plan

## Phase 0: Foundation ✅ COMPLETE

- [x] Create shared.js component framework
- [x] Create shared.css styles
- [x] Integrate into dashboard.html
- [x] Redirect Frontend/admin.html → AdminDashboard

---

## PHASE A: RESTORE EXISTING CMS FUNCTIONALITY

### A1: Dashboard Restoration ✅ COMPLETE

- [x] Fix ErrorState usage (was called as function, now uses ErrorState.render())
- [x] Fix EmptyState usage (was called as function, now uses EmptyState.render())
- [x] Remove fallback definitions for shared functions from dashboard.js
- [x] Verify all stat cards populate
- [x] Verify auto-refresh works

### A2: Anime CMS Restoration ✅ COMPLETE (Shared.js Migration)

- [x] Remove duplicate `_debounce()` — now uses shared `window.debounce`
- [x] Replace custom `_showConfirm()` with shared `_confirm()` from shared.js
- [x] Replace `window.confirm()` in single anime import → `_confirm()`
- [x] Replace `window.confirm()` in bulk import → `_confirm()`
- [x] Remove fallback definitions for shared functions
- [x] Add/Edit/Delete/Bulk Delete all functional
- [x] Import Anime from Consumet works
- [x] Search, Filters, Pagination, Sorting work
- [x] Featured/Premium/Status toggle

### A3: Episodes Restoration ✅ COMPLETE

- [x] Fix delete episode (replaced window.confirm with \_confirm())
- [x] Restore episode list loading from API
- [x] Restore Manage Episodes from Anime section

### A4: Users Restoration ✅ COMPLETE

- [x] Remove duplicate `_debounce()` (now uses shared `_debounce`)
- [x] Replace inline badge HTML with `Badge.role()` for admin/user indicator
- [x] Replace inline badge HTML with `Badge.premium()` for premium/free indicator
- [x] Replace inline badge HTML with `Badge.status()` for user status
- [x] Fix single user delete confirmation (replaced confirm with \_confirm())
- [x] Fix bulk user delete confirmation (replaced confirm with \_confirm())
- [x] Restore Ban/Unban user
- [x] Restore Search, Filters, Pagination

### A5: Payments Restoration ✅ COMPLETE

- [x] Restore payment list from API
- [x] Restore Status change dropdown

### A6: Genres Restoration ✅ COMPLETE

- [x] Remove inline onclick handlers (use event delegation now)
- [x] Fix delete confirmation (replaced window.confirm with \_confirm())
- [x] Restore Add Genre form
- [x] Restore Delete Genre

### A7: Ads Restoration ✅ COMPLETE

- [x] Create missing `#ad-modal` in dashboard.html
- [x] Add `#ads-table` with columns (Preview, Title, Type, Active, Target, Actions)
- [x] Add `#add-ad-btn` button to Ads Config header
- [x] Restore Add Ad functionality
- [x] Restore Edit Ad
- [x] Fix delete confirmation (replaced window.confirm with \_confirm())
- [x] Restore status toggle (checkbox)

### A8: Logs Restoration ✅ COMPLETE

- [x] Restore log list from API

### A9: Settings Restoration ✅ COMPLETE

- [x] Dynamically generate settings form fields from SETTINGS_FIELDS config
- [x] Fields: site_name, announcement, maintenance_mode, premium_monthly_amount, premium_yearly_amount, contact_email, cloudinary_cloud_name
- [x] Replace inline `onsubmit` with proper `addEventListener('submit', ...)`
- [x] Restore Save settings
- [x] Verify all fields save correctly

---

## PHASE B: REPLACE DUPLICATE CODE WITH SHARED.JS ✅ COMPLETE

- [x] Replace `window.confirm()` with `_confirm()` in episodes.js
- [x] Replace `window.confirm()` with `_confirm()` in users.js
- [x] Replace `window.confirm()` with `_confirm()` in ads.js
- [x] Replace `window.confirm()` with `_confirm()` in genres.js
- [x] Replace `window.confirm()` with `_confirm()` in anime.js (single delete, bulk delete, import)
- [x] Replace custom `_showConfirm()` with shared `_confirm()` in anime.js
- [x] Replace duplicate `_debounce()` with shared `_debounce` in anime.js
- [x] Replace duplicate `_debounce()` with shared `_debounce` in users.js
- [x] Replace inline badge HTML with `Badge` utilities in users.js
- [x] Replace inline badge HTML with `Badge` utilities in anime.js
- [x] Remove fallback definitions in dashboard.js
- [x] Add fallback definitions in anime.js for edge cases
- [x] Fix ErrorState/EmptyState function → object method calls in dashboard.js

---

## PHASE C: BACKEND VERIFICATION ⏳ IN PROGRESS

- [x] Dashboard overview — GET /api/admin/dashboard/overview
- [x] Anime CRUD — GET/POST/PUT/DELETE /api/admin/anime
- [x] Anime bulk — PUT /api/admin/anime/bulk, POST /api/admin/anime/bulk-delete
- [x] Anime import — GET /api/admin/anime/import/search, POST /api/admin/anime/import, PUT /api/admin/anime/:id/sync
- [x] Genres — GET/POST/DELETE /api/admin/genres
- [x] Episodes — GET/POST/PUT/DELETE /api/admin/episodes
- [x] Users — GET /api/admin/users, PUT /api/admin/users/:id
- [x] Users bulk — POST /api/admin/users/bulk-delete
- [x] Payments — PUT /api/admin/payments/:id
- [x] Ads — GET/POST/PUT/DELETE /api/admin/ads
- [x] Logs — GET /api/admin/logs
- [x] Settings — GET/PUT /api/admin/settings
- [ ] Verify all middleware (protect, adminOnly) is applied

---

## PHASE D: REGRESSION TESTING ⏳ TO BE PERFORMED

- [ ] Dashboard: cards, refresh, loading, error states
- [ ] Anime: Add, Edit, Delete, Bulk Delete, Import, Search, Filters, Pagination, Sort
- [ ] Episodes: Add, Edit, Delete, Manage from Anime, Pagination
- [ ] Users: List, Ban, Unban, Delete, Bulk Delete, Search, Filters, Pagination
- [ ] Payments: List, Status changes
- [ ] Genres: Add, Delete
- [ ] Ads: Add, Edit, Delete, Status toggle
- [ ] Logs: List
- [ ] Settings: Load, Save

---

## PHASE E: ADVANCED DASHBOARD (Future — Only After Everything Works)

- [ ] Live Charts (viewer trends, revenue timeline, user growth)
- [ ] Provider Health widgets
- [ ] Database Health
- [ ] Cache Health
- [ ] Storage Usage
- [ ] Streaming Provider Status
- [ ] Revenue Graphs
- [ ] User Growth
- [ ] Anime Growth
- [ ] Recent Activity Timeline
- [ ] Notifications
- [ ] Analytics
- [ ] Automation
- [ ] Media Manager
