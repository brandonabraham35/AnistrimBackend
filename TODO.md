# Episode Mapping Fix - Implementation Steps

## Root Cause

`Frontend/details.js` navigates to `watch.html?animeId=X&epId=Y` where `epId` is a **database record ID** (e.g., 33), but `watch.js` reads params `id`/`ep`, and when `epId=33` falls through as the episode number, it requests "Episode 33" for a movie that has no such episode.

## Files to Modify

### 1. `Frontend/details.js` — Fix URL navigation format

- [x] Change `watch.html?animeId=${animeId}&epId=${firstUnlocked.id}` → `watch.html?id=${animeId}&ep=${firstUnlocked.episode_number}`
- [x] Change `watch.html?animeId=${animeId}&epId=${epId}` → `watch.html?id=${animeId}&ep=${episode_number}`
- [x] Store `episode_number` in data attributes instead of DB `ep.id`

### 2. `Frontend/watch.js` — Fix parameter reading and navigation

- [x] Fix `playNextEp()` to use `?ep=` with episode_number instead of `?epId=` with DB id
- [x] Fix `renderMoreEpisodes()` to use `?ep=` with episode_number instead of `?epId=` with DB id
- [x] Add warning log when legacy `epId` param is detected
- [x] Ensure `ep` param is always preferred over `epId` for episode number

### 3. `controllers/streamController.js` — Strengthen episode resolution

- [x] Add media_type MOVIE detection with direct DB query
- [x] Add deterministic mapping with clear error messages
- [x] Improve logging for each resolution step

### 4. `services/streamingService.js` — Add movie guard

- [x] Add movie detection check before provider resolution

### 5. Verify all navigation paths

- [ ] Home hero → Watch (scrpt.js: `watch.html?id=${a.id}&ep=1` — ALREADY CORRECT)
- [ ] Continue Watching → Watch (scrpt.js: `watch.html?id=${item.anime_id}&ep=${item.episode_number}` — ALREADY CORRECT)
- [ ] Browse → Details → Watch (details.js: FIXED)
- [ ] Search → Details → Watch (details.js: FIXED)
- [ ] Play Next Episode (watch.js: FIXED)
- [ ] More Episodes list (watch.js: FIXED)
