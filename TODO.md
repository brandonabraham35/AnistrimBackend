# TODO: AniSkip Service + Ads Premium Enforcement

## Status: ✅ Complete

### ✅ Completed

- [x] Plan approved by user
- [x] **Step 1**: Updated `services/aniSkipService.js` — Added Anime-Skip fallback, 3s timeout on primary, graceful `{ found: false }` on dual failure
- [x] **Step 2**: Updated `controllers/adsController.js` — Premium users get all ads disabled (`bannerEnabled: false`, `interstitialEnabled: false`, `preRollEnabled: false`)
- [x] **Step 3**: Updated `routes/adsRoutes.js` — Added `auth.protect` to GET `/config` so `req.user` is populated

### Notes

- Frontend's `apiFetch()` in `scrpt.js` already passes Bearer token via `State.token` — no frontend changes needed for the ads route auth requirement
- Frontend's `scrpt.js` ad system already checks `State.isPremium || State.isAdmin` client-side before showing interstitials; the backend change adds server-side enforcement as a second layer
- Ensure `ANIMESKIP_API_KEY` is set in `.env` for the Anime-Skip fallback provider
- AniSkip timeout reduced from 8s to 3s as specified
