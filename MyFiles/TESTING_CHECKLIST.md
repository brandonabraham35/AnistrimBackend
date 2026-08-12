# AniStrim CMS Upgrade Testing Checklist

## Backend API Verification
- [ ] GET `/api/admin/dashboard/overview` returns 200 OK with correct JSON structure.
- [ ] Stats (total users, anime, etc.) match database counts.
- [ ] Revenue calculations (today, monthly, total) are accurate.
- [ ] Cloudinary video counts are correctly aggregated from the `episodes` table.
- [ ] Activity logs and latest users return the most recent entries.
- [ ] Error handling: Dashboard still loads even if one table is missing or query fails.

## Frontend UI Verification
- [ ] Stats cards show correct data with modern styling.
- [ ] Revenue section displays today's and monthly totals.
- [ ] Encoding queue displays correct counts for ready, processing, and failed videos.
- [ ] Recent Uploads shows recent episodes with correct formatting.
- [ ] Top Anime and Recent Payments lists are populated.
- [ ] Activity logs timeline displays recent actions.
- [ ] Auto-refresh: Data updates every 30 seconds without page reload.
- [ ] Responsive Layout: Dashboard is usable on mobile and tablet.

## Regression Testing
- [ ] Login still works correctly for admin users.
- [ ] Access denied for non-admin users.
- [ ] Anime CRUD (Create, Read, Update, Delete) still works.
- [ ] Episode management and Cloudinary video uploads still work.
- [ ] Settings and Ads management still work.
- [ ] Activity logging still works for all admin actions.

## Cloudinary Integration
- [ ] Image uploads to Cloudinary succeed.
- [ ] Video uploads, metadata checks, and asset deletion succeed.
