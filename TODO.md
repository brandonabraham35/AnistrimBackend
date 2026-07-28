# Implementation Plan — Proxy + Movie Metadata Fix

## Steps

- [x] Task Analysis & Code Review Complete
- [x] Step 1: Create SQL migration (v16) — add `media_type` column + ensure cloudinary columns exist
- [x] Step 2: Update `services/streamingService.js` — inject Thordata proxy agent into all provider resolvers
- [x] Step 3: Update `controllers/streamController.js` — add movie detection logic to fix episode number
- [x] Step 4: Update `services/consumetProvider.js` — enhance movie handling + add Thordata proxy fallback
- [x] Step 5: Update `services/kitsuProvider.js` — extract `media_type` (subtype) from Kitsu API responses
- [x] Step 6: Update `controllers/adminImportController.js` — persist `media_type` during Consumet/Kitsu imports
- [x] Step 7: Update `services/catalogueService.js` — persist `media_type` during Kitsu imports
- [x] Step 8: Update `sql/schema.sql` — add media_type column reference

## Testing

- [ ] Run migration on database: `mysql -u root -p anistrim2 < sql/migrations_v16_media_type.sql`
- [ ] Verify proxy routing works with Thordata (check server logs for `✅ Thordata proxy configured`)
- [ ] Verify movie resolution (e.g. "Jujutsu Kaisen 0") resolves episode 1 correctly
- [ ] Re-import any movies via admin dashboard to set their `media_type = 'MOVIE'`
