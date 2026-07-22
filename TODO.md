# TODO: Import Modal Enhancements

## Done

- [x] Updated API base URL in `api.js` to Render production URL
- [x] Updated `connectionLimit` in `config/db.js` from 10 to 4

## Completed

- [x] **dashboard.js**: Rewrite `renderKitsuSearchResults()` - added "Import All Results" button, individual button changes to "✅ Imported" (green, disabled, no refresh), sequential `for...of` for Import All
- [x] **anime.js**: Same rewrite for `renderKitsuResults()`
- [x] **dashboard.html**: Added CSS for `.imported-btn` and `.import-all-btn` styles
- [x] **animeRoutes.js**: Added two new Consumet streaming routes:
  - `GET /api/anime/kitsu/:kitsuId/episodes` — fetches episode list from Consumet using MalSync slug from `anime_mappings`
  - `GET /api/anime/stream/:episodeId` — fetches .m3u8 streaming sources from Consumet
- [x] **anime.js**: Replaced placeholder `alert()` edit with full Edit Anime Modal (Title, Description, Status dropdown, Premium checkbox). On submit: `PUT /admin/anime/:id`, shows green success toast, updates the specific table row in-place without page reload.

## Viral Threshold Premium Automation (Strategy 2)

- [x] **sql/migrations_v9_daily_views.sql**: Created migration to add `daily_views` column to the `anime` table
- [x] **controllers/animeController.js**: Updated `getById` to increment `daily_views` alongside `view_count`
- [x] **utils/premiumAutomation.js**: Rewrote from Top-10 model to Viral Threshold model (reset all → lock ≥50 daily views → reset daily views)
- [x] **server.js**: Already had `require('./utils/premiumAutomation')` — no changes needed
