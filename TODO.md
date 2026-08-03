# Provider Registry Consolidation — Task Tracker

## Goal

Make `services/providerRegistry.js` the single source of truth for all provider
IDs, class mappings, referers, health keys, normalization, and consumet preferred
order. Remove all hardcoded provider strings from the codebase.

## Completed (foundation — already shipped)

- [x] 1. Fix `normalizeProviderName` in `services/providerRegistry.js` so `consumet-http`,
     `Consumet-Http`, `CONSUMET_HTTP`, `consumet_http` all resolve to `consumet-http`.
- [x] 2. `utils/providerHttp.js` — replace hardcoded `referers` map with `getReferer()`.
- [x] 3. `services/consumet/server.js` — replace hardcoded `preferredOrder` with `getConsumetPreferredOrder()`.
- [x] 4. `services/streamingService.js` — replace `'consumet-http'`/`'miruro'` literals with constants;
     remove special-case filter that existed only because normalization failed.
- [x] 5. `services/consumetProvider.js` — replace hardcoded `healthKey` with `toHealthKey()`.
- [x] 6. `controllers/adminImportController.js` — replace `'consumet'`/`'kitsu'` literals with constants.
- [x] 7. `scripts/seed-catalogue.js` — replace `'kitsu'` literal with constant.
- [x] 8. `services/kitsuProvider.js` — replace `'kitsu'` literal with constant.

## Remaining (this iteration — approved scope: consolidation + cleanup only)

- [x] 9. `services/streamingService.js` — remove dead `||` health-key fallbacks now that
     `normalizeProviderName('consumet-http')` resolves correctly:
     - `buildConsumetSubProviderResolver` (`toHealthKey(...) || \`${CONSUMET_TAG_PREFIX}...\``)
     - `resolveStream` (`toHealthKey(providerTag) || \`consumet-...\``)
     - `resolveAllProviders` (same pattern)
     - Drop now-unused `toProviderTag` import (verified unused via grep).
- [x] 10. `services/consumetProvider.js` — remove dead `||` health-key fallback in
      `resolveStreamUrl`; drop unused imports (`CONSUMET_PROVIDER_CLASS_NAMES`, `isKnownProvider`).
- [x] 11. `services/consumet/server.js` — replace hardcoded `'consumet-http'` literal with
      `PROVIDER_IDS.CONSUMET_HTTP`; replace hardcoded `'pahe'`/`'hianime'` blind-fallback
      exclusion with registry-derived class names (`PROVIDER_IDS.ANIME_PAHE`,
      `PROVIDER_IDS.HIANIME` via `toConsumetClassName`), preserving exact runtime behavior.
- [x] 12. Run `node --check` syntax checks on every modified file — all 9 pass.
- [x] 13. Run `npm run lint` (eslint) — only pre-existing template-literal `quotes`
      errors and pre-existing `no-unused-vars` warnings remain (none introduced by edits).
- [x] 14. Attempt regression tests (`node run-regression-tests.js`) — requires a live
      server + DB which is unavailable in this sandbox (pre-existing ECONNREFUSED);
      equivalent module-load + registry functional verification suite passed instead.
- [x] 15. Reported modified files, removed hardcoded strings, and confirmed no public
      behavior changed (see completion summary).
