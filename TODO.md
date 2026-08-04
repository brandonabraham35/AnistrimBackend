# Hosted Consumet Fallback Architecture — Implementation Todo

## Goals

- [x] Inspect existing project & understand current architecture
- [x] Approve implementation plan

## Steps

- [x] Create `services/hostedConsumetProvider.js` (dedicated axios client, configurable endpoints, independent timeout)
- [x] Wire it into `services/streamingService.js` `buildConsumetHttpResolver()`
- [x] Document new env vars in `README.md` (`.env.example` is read-only/blocked)
- [x] Document fallback flow + env vars in `README.md`
- [x] Syntax-check changed files
- [x] Smoke test fallback activation

---

# Miruro Provider — Disable & Future Verified Adapter Roadmap

## Status

- [x] Complete Miruro compatibility audit → `MIRURO_COMPATIBILITY_REPORT.md`
- [x] Remove Miruro from active provider order (`providerRegistry.getDefaultProviderOrder()`)
- [x] Replace `buildMiruroResolver()` with an intentionally-disabled no-op stub
- [x] Document the disabled state in `streamingService.js`, `streamRoutes.js`, `_verify_proxy.js`
- [x] Keep `MIRURO_API_URL` reading optional (never activates provider by itself)

## Phase 1 — Capture real browser traffic (NOT yet done)

- [ ] Capture real browser traffic for:
  - `GET /api/search`
  - `GET /api/episodes`
  - `GET /api/sources`
- [ ] Record: JSON schemas, request headers, cookies, Cloudflare requirements, provider identifiers
- [ ] Document the exact playable URL + quality token shape for each native (non-embed) provider

## Phase 2 — Implement verified adapter

- [ ] Create `services/miruroProvider.js` implementing:
  - title → AniList lookup
  - episode resolution
  - source retrieval
  - subtitle retrieval
  - normalization into the existing internal stream model `{ provider, streamUrl, sources, subtitles }`
- [ ] Wire `services/miruroProvider.js` into `buildMiruroResolver()` (replacing the stub)

## Phase 3 — Enable Miruro only as final fallback

- [ ] Re-add `PROVIDER_IDS.MIRURO` to `getDefaultProviderOrder()` AFTER:
  - KickAssAnime
  - AnimePahe
  - AnimeSaturn
  - HiAnime
  - Hosted Consumet
- [ ] Validate in staging before production
