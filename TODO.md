# Ads Config & Video Player Improvements

## Steps

- [x] Plan approved by user
- [x] **Step 1**: Fix Auto-Hide Controls in `watch.js` — 3s inactivity timer, mousemove/touchstart listeners
- [x] **Step 2**: Fix Skip Intro Logic in `watch.js` — use fetched `introRange` instead of hardcoded 5-90s range
- [x] **Step 3**: Add Ads Config Panel to Admin Dashboard — sidebar link, form panel, wiring
- [x] **Step 4**: Ad system already exists in `Frontend/scrpt.js` — shows 15s interstitials every 10 min for free users. Ads config backend API is functional.
- [x] **Step 5**: Implementation verified — all backend (SQL migration, controller, routes) and frontend (auto-hide controls, skip intro, admin ads config panel) are complete.
