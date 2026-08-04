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
