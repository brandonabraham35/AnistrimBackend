# TODO: "Watch Anime" Button → Browse Redirect Fix

## Plan

### Root Cause

1. `details.js` fetches from `/api/anime/trending` (flat list, no episodes) instead of `/api/anime/:id` (includes episode array)
2. `details.js` hardcodes `ep=1` instead of using the actual first episode's DB `id`
3. `watch.js` has aggressive `location.href = 'browse.html'` fallback that silently redirects

### Fixes

- [x] **details.js**: Use `/api/anime/:id` endpoint to get real episode data
- [x] **details.js**: Pass actual first episode `episode_number` to watch page
- [x] **details.js**: Render real episode list with titles, durations, premium lock icons
- [x] **watch.js**: Replace Browse redirect with in-page error message
