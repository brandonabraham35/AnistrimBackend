# AnimeHeaven Subtitle Runtime Proof — Fix & Re-run

Goal: The prior runtime proof was INCONCLUSIVE because every video failed to play
(HTTP 403/404 — the harness sent no Referer/Origin header, which the AnimeHeaven CDN
requires). Fix the harness so videos actually render, classify broken playback as
`inconclusive` (never mislabel as "no subtitles"), re-run >=20 episodes, and
regenerate an accurate proof report.

## Steps

- [x] 1. Analyze codebase (provider, providerHttp referer, frontend player, prior proof)
- [x] 2. Get user approval on approach
- [ ] 3. `_subtitle_runtime_proof.js` — send Referer/Origin headers in the browser
- [ ] 4. `_subtitle_runtime_proof.js` — classify non-playing episodes as `inconclusive`
- [ ] 5. Re-run harness against >=20 AnimeHeaven episodes
- [ ] 6. Inspect subtitle-proof-data.json + screenshots (did video actually play?)
- [ ] 7. Regenerate embedded-subtitle-proof.md with accurate conclusion
- [ ] 8. Present conclusion based on runtime evidence
