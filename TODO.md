# TODO: Feature Implementations

## Next Episode Resolver

- [x] Create plan & get approval
- [x] **Step 1**: Add `resolveNextEpisode` controller to `controllers/watchController.js`
- [x] **Step 2**: Add public route `GET /next/:animeId/:currentEpisodeNumber` to `routes/watchRoutes.js`
- [x] **Step 3**: Verify implementation & test

## AniSkip Integration (Skip Intro/Outro Timestamps)

- [x] **Step 1**: Create `services/aniSkipService.js` with `fetchSkipTimes(malId, episodeNumber)`
- [x] **Step 2**: Add `getEpisodeSkipTimes` controller to `controllers/watchController.js`
- [x] **Step 3**: Add public route `GET /skip-times/:malId/:episodeNumber` to `routes/watchRoutes.js`
- [x] **Step 4**: Verify implementation
