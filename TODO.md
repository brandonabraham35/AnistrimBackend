# Task: Refactor Streaming Engine to AnimeHeaven-Only

## Goal

Remove ALL multi-provider logic from the streaming engine and replace with a
single AnimeHeaven resolver. Preserve the existing frontend contract and keep
all other subsystems (Admin CMS, Catalogue, Consumet legacy code that other
subsystems still reference) completely untouched.

## Files Modified

- [x] `services/streamingService.js` — single AnimeHeaven execution path
- [x] `services/providerRegistry.js` — `getDefaultProviderOrder()` returns [animeheaven]
- [x] `controllers/streamController.js` — comment/docs only, contract unchanged
- [x] `routes/streamRoutes.js` — comment/docs only, endpoints unchanged

## Acceptance Criteria

- [x] A Play request can no longer execute any Consumet resolver.
- [x] `streamingService` has exactly one execution path: AnimeHeavenProvider.
- [x] `resolveStream()` cannot invoke Consumet, Hosted Consumet, Miruro, provider race, queue, or retries.
- [x] Admin Dashboard still loads (DB + admin verified on boot).
- [x] Admin Anime CRUD still works (untouched).
- [x] Episode CRUD still works (untouched).
- [x] Catalogue remains unchanged (untouched; registry exports intact).
- [x] No API response contracts changed.

## Verification

- [x] `node --check` passed on all 4 edited files.
- [x] Imports/exports verified — no circular deps, no broken requires.
- [x] `streamingService` public API surface intact (resolveStream, resolveAllProviders, filterSourcesByTier, getBestQualityLabel, getProviderHealthStatus, QUALITY_TIERS).
- [x] `providerRegistry` all 13 exports intact; `getDefaultProviderOrder()` → `["animeheaven"]`.
- [x] `streamRoutes` + `streamController` load with DB + admin verified.
- [x] `streamingService` contains zero Consumet/Miruro/race/queue/retry references.
- [x] Dashboard health endpoint still returns `provider_health` (getProviderHealthStatus preserved).
