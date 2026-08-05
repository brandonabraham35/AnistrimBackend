# Subtitle Runtime Investigation — Task List

## Objective

Definitive runtime forensic evidence of how AnimeHeaven delivers subtitles, so we can decide whether subtitle extraction should remain in the validation suite or be removed.

## Scope Guardrails

- **Do NOT** modify any provider, controller, frontend, validation, or streaming code.
- **Only** file modified: `_subtitle_runtime_investigation.js`
- **Only** generated output: `subtitle-delivery-report.json`

## Steps

- [x] 1. Restructure `_subtitle_runtime_investigation.js` to avoid double-fetching the gate page (capture gate HTML once, then crawl nested iframes/manifests/scripts from it).
- [x] 2. Make MP4 range-header scanning robust (decode Buffer regardless of responseType, guard so it only runs when a playable MP4 source exists).
- [x] 3. Add a direct raw-HTTP probing path (Node http/https) for subtitle/manifest/MP4 probes that records true network status (the 404 evidence) independent of the provider's HTTP client.
- [x] 4. Strengthen evidence capture: cap/dedupe request log, record per-probe HTTP status, sample mirror/iframe hostnames.
- [x] 5. Compute a single definitive delivery-method verdict with confidence + clear recommendation on whether subtitle extraction should remain in validation.
- [ ] 6. Run `_subtitle_runtime_investigation.js` to generate a fresh `subtitle-delivery-report.json`.
- [ ] 7. Verify the report contents (delivery method, confidence, samples, conclusion).
