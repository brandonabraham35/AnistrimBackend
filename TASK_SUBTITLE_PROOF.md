# Task: AnimeHeaven Subtitle Runtime Proof

## Objective

Verify at runtime (>=20 episodes) whether AnimeHeaven streams contain subtitles,
capturing per-episode:

- player HTML
- network requests
- video URL
- subtitle URL (if any)
- screenshots while playing
- whether subtitles are visible during playback

## Steps

- [x] 1. Analyze codebase (provider, frontend player, previous audits)
- [x] 2. Get user approval on approach
- [x] 3. Install puppeteer-core (uses installed Chrome)
- [x] 4. Create `_subtitle_runtime_proof.js` runtime harness
- [x] 5. Run harness against >=20 AnimeHeaven episodes (24 episodes inspected)
- [x] 6. Capture screenshots + network + subtitle evidence (24 screenshots in `subtitle-proof-screenshots/`)
- [x] 7. Generate `embedded-subtitle-proof.md`
- [x] 8. Present conclusion based on runtime evidence

## RESULT (2026-08-05)

**INCONCLUSIVE — critical CDN playback failure discovered.**

- 24/24 episodes **resolved** to direct `.mp4` video URLs (no HLS, no DASH, no
  external subtitle tracks returned by the provider).
- **0/24** videos actually **played** in the headless Chrome browser. Every CDN
  request (`ck.animeheaven.me`, `ci.animeheaven.me`, `ax.animeheaven.me`) returned
  **HTTP 403 / 400 / 404** (`MEDIA_ERR_SRC_NOT_SUPPORTED`, `readyState 0`,
  `currentTime 0`, no frames rendered).
- Because no video frame ever rendered, on-screen (burned-in) subtitle detection
  was **meaningless** — the strict harness correctly refused to label these
  "no subtitles".

### Why playback failed

The AnimeHeaven CDN video endpoints require a valid same-site referer/origin +
session cookie. The runtime harness (and by extension the provider's
server-side `extractStreams`) delivers a bare `.mp4` URL with a signed token, but
the CDN rejects it when requested directly from a fresh browser context without
the gate-page session cookie. The provider's default referer is `animeheaven.ru`
while the actual CDN is on `*.animeheaven.me` subdomains.

### What this means for the stream pipeline

- The provider's `subtitleMode: 'embedded'` is **NOT proven** by runtime
  evidence and must not be treated as fact.
- The resolved stream URLs may **also fail to play in a real end-user browser**
  unless the backend proxies the video (passing the gate cookie) or the CDN is
  hit with the correct referer/origin. This is a **production blocking concern**
  separate from the subtitle question.
- The earlier `subtitle-delivery-report.json` (classification E: burned into
  video / no separate subtitle delivery) remains the most defensible evidence
  for subtitle DELIVERY, since no external subtitle resource exists. But
  **visible burned-in subtitles remain unproven** until a real playback can be
  captured.

### Evidence artifacts

- `embedded-subtitle-proof.md` — per-episode report (all 24 inconclusive)
- `subtitle-proof-data.json` — raw structured evidence (network + runtime)
- `subtitle-proof-screenshots/*.png` — 24 evidence screenshots
