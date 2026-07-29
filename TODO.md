# Admin Dashboard Enhancement TODO

## Phase 0: Foundation ✅ COMPLETE

- [x] Create `AdminDashboard/js/shared.js` - Shared component framework
  - [x] Utility functions (escapeHTML, showToast, debounce, formatDate, formatNumber)
  - [x] SkeletonLoader system (table, card, stat, chart, form skeletons)
  - [x] Confirmation dialog (Promise-based)
  - [x] ModalManager (unified open/close/create/edit/delete/preview modals)
  - [x] EmptyState component
  - [x] ErrorState component
  - [x] Badge utilities
  - [x] DataTable class (search, filters, sorting, pagination, bulk selection)
  - [x] Loading overlay system
  - [x] Form validation
- [x] Create `AdminDashboard/css/shared.css` - Shared component styles (skeletons, badges, empty/error states, modals, datatable)
- [x] Integrate shared.js + shared.css into `AdminDashboard/dashboard.html`
- [x] Redirect `Frontend/admin.html` → AdminDashboard (auto-redirect authenticated users to dashboard.html, others to index.html)

## Phase 1: Dashboard

- [ ] Add skeleton loading states (using SkeletonLoader)
- [ ] Refactor dashboard.js to use shared.js components
- [ ] Add live charts (viewer trends, revenue timeline, user growth)
- [ ] Add provider health, database health, cache health widgets
- [ ] Add storage usage widget
- [ ] Add recent activity timeline
- [ ] Add auto-refresh controls

## Phase 2: Anime (already robust - minor polish)

- [ ] Add camera icon/media gallery functionality
- [ ] Add bulk metadata editing modal
- [ ] Add collection management

## Phase 3: Episodes

- [ ] Add search, filters, sorting, pagination
- [ ] Add bulk action toolbar
- [ ] Add subtitle status, quality indicators
- [ ] Add stream status indicators
- [ ] Add broken stream report integration

## Phase 4: Users

- [ ] Add watch history view
- [ ] Add premium expiry tracking
- [ ] Add advanced role management
- [ ] Add ban/unban flow improvements

## Phase 5: Payments

- [ ] Add search, date range filter, status filter
- [ ] Add pagination
- [ ] Add refund workflow
- [ ] Add CSV export
- [ ] Add revenue analytics sub-panel with charts

## Phase 6: Genres (already working - minor polish)

## Phase 7: Ads

- [ ] Create missing `#ad-modal` in HTML
- [ ] Add scheduling UI
- [ ] Add placement management
- [ ] Add performance metrics

## Phase 8: Logs

- [ ] Add category tabs (Auth, Streaming, Payment, Admin, API, System)
- [ ] Add search, date filter, export
- [ ] Add auto-refresh
- [ ] Add log level badges

## Phase 9: Settings

- [ ] Dynamically generate settings form from backend config
- [ ] Add grouped categories (General, Auth, Streaming, Proxy, Maintenance)

## Phase 10: New CMS Modules

- [ ] Analytics page (viewers, top anime, engagement, retention, geography)
- [ ] Notifications page (broadcast, push, email, maintenance)
- [ ] Media Manager (posters, banners, trailers, subtitles, grid/list view)
- [ ] Automation page (scheduled jobs, health checks, cache, backup)

## Phase 11: Audit & Polish

- [ ] Audit every button, icon, menu item
- [ ] Implement missing functionality
- [ ] Remove dead elements
- [ ] Add comprehensive error boundaries
- [ ] Test all CRUD operations
- [ ] Ensure responsive layout
