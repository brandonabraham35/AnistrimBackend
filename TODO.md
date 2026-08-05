# Nightly Validation Suite — Subtitle Delivery Fix

Goal: Stop assuming `subtitle tracks == subtitles exist`. Distinguish EXTERNAL vs EMBEDDED subtitles using the normalized `subtitleMode` field throughout the pipeline.

## Steps

- [x] 1. Analyze suite (context, subtitles, readiness, metadata, providerProfile, animeHeaven provider)
- [x] 2. Plan approved
- [ ] 3. `validation/context.js` — extract reusable `deriveSubtitleMode()` helper (external/embedded/missing/unknown) and use it in harvest; export it
- [ ] 4. `validation/subtitles.js` — consume `subtitleMode` as the single source of truth; add delivery distribution + external-only coverage; only flag `missing` for external-expected providers
- [ ] 5. `validation/readiness.js` — Subtitles subsystem respects embedded rule; report overall + external coverage separately
- [ ] 6. `validation/metadata.js` — fix fallback to reuse `deriveSubtitleMode()`
- [ ] 7. Verify no remaining `subtitles.length > 0` re-derivations in the validation pipeline
- [ ] 8. Syntax-check the edited files
