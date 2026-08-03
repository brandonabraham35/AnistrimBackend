# TODO — Consumet Provider Registry Audit & Fix

## Context

- Installed `@consumet/extensions@1.8.8`
- Verified exported ANIME providers: Hianime, AnimePahe, AnimeKai, KickAssAnime, AnimeSaturn, AnimeUnity, AnimeSama
- Invalid assumptions: `Gogoanime` and `Zoro` classes do NOT exist in v1.8.8

## Steps

- [x] Update `services/providerRegistry.js`:
  - [x] Add `ANIME_UNITY: 'animeunity'` to `PROVIDER_IDS`
  - [x] Add `AnimeUnity` to `CONSUMET_SUB_PROVIDER_IDS`
  - [x] Add `[PROVIDER_IDS.ANIME_UNITY]: 'AnimeUnity'` to `CONSUMET_PROVIDER_CLASS_NAMES`
  - [x] Remove invalid `Gogoanime` and `Zoro` from `CONSUMET_PROVIDER_CLASS_NAMES`
  - [x] Add `[PROVIDER_IDS.ANIME_UNITY]: 'https://animeunity.it/'` to `PROVIDER_REFERERS`
  - [x] Update `getDefaultProviderOrder()` to include AnimeUnity
  - [x] Update `getConsumetPreferredOrder()` to include AnimeUnity
- [x] Update `services/consumetProvider.js` header comment
- [x] Verify load (registry + synthetic check)
- [x] Cleanup temp audit file `_audit_provider_usage.js`

## Verification Results

- `consumetProvider` registry now registers **7 providers**:
  KickAssAnime, AnimeKai, AnimePahe, Hianime, AnimeSaturn, AnimeSama, **AnimeUnity**
- `hasProvider('Gogoanime')` → `false`
- `hasProvider('Zoro')` → `false`
- `hasProvider('AnimeUnity')` → `true`
- All mapped class names verified to exist in installed `@consumet/extensions@1.8.8`
- Consumet microservice loads OK, picks KickAssAnime as preferred fallback
- eslint: only pre-existing quote warnings/errors remain (none introduced by this change)
