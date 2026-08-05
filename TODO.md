# Task: AnimeHeaven embedded subtitle validation

## Goal

Improve the AnimeHeaven provider so subtitle validation understands embedded
subtitles. When no external VTT/SRT/ASS/SSA tracks are found but the stream is
healthy, the provider is AnimeHeaven, and the player is known to use embedded
subtitles, validation should return `subtitleMode: "embedded"` (instead of
`"missing"`) and count embedded subtitles as PASS instead of FAIL.

Do NOT fabricate subtitle tracks. Do NOT create fake VTT files.

## Steps

- [x] 1. Explore repo + read relevant files
- [x] 2. Create plan and get approval
- [ ] 3. `services/animeHeavenProvider.js`
     - `normalizeEmptyStream`: add `subtitleMode: 'missing'`, `externalTracks: false`
     - `extractStreams` success return: expose `subtitleMode` (`external` /
       `embedded` / `missing`) and `externalTracks`
- [ ] 4. `validation/context.js`
     - Import `subtitleDeliveryFor` / `SUBTITLE_DELIVERY` from `./providerProfile`
     - Derive `externalTracks` + `subtitleMode` and set `ok` = PASS when
       external tracks exist OR subtitleMode === `embedded`
     - Push `subtitleMode` / `externalTracks` into subtitle rows
- [ ] 5. `validation/subtitles.js`
     - Treat embedded rows as "with subtitles" (PASS)
     - Add `episodesWithEmbeddedSubtitles` to summary
     - Include `subtitleMode` in per-row output
- [ ] 6. Syntax-check the edited files (`node --check`)
- [ ] 7. Verify the Subtitles subsystem reflects embedded as PASS
