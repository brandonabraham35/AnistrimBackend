# FORENSIC REPORT — Cold-Playback 404 Root Cause: AnimeHeaven Source Selection

**Date:** 2026-08-08
**Author:** Automated forensic analysis (read-only)
**Method:** Static code trace + live CDN playability probe (HEAD/GET with full server-side playback context). No source, DB, config, frontend, route, CMS, auth, payment, or git changes. No fixtures. No fixes.

---

## VERDICT

# ❌ ROOT CAUSE CONFIRMED — SOURCE SELECTION DEFECT

The cold playback 404 is **not** a proxy defect, **not** a context-injection defect, and **not** a CDN availability problem. It is a **source-selection defect** in `services/animeHeavenProvider.js`:

> The provider picks a **dead** AnimeHeaven CDN source as `streamUrl`/`sources[0]` because the quality-sort treats all gate sources as equal (`quality:"auto"` → rank 0) and falls back to **URL lexicographic ordering**, which places the **`&error2`/`&error` onerror-fallback URLs** (which 404) ahead of the **genuinely playable** source.

A live, playable AnimeHeaven source **exists** and was confirmed reachable with HTTP 200 (video/mp4, ~607 MB). It is simply never selected.

---

## 1. Evidence — Live CDN Playability Probe (direct, with playback context)

Resolution target: `Jujutsu Kaisen 0` ep 1 via `provider.resolveStream()`.

The provider returned **4 sources**, all with `quality:"auto"`:

| idx | host / URL suffix                         | sourceType | Direct CDN probe       | Byte length |
| --- | ----------------------------------------- | ---------- | ---------------------- | ----------- |
| 0   | `ck.animeheaven.me/video.mp4?...&error2`  | `video`    | **HTTP 404** (dead)    | —           |
| 1   | `ct.animeheaven.me/video.mp4?...&error`   | `video`    | **HTTP 404** (dead)    | —           |
| 2   | `rt.animeheaven.me/video.mp4?...&<token>` | `video`    | **HTTP 200** video/mp4 | 636,947,070 |
| 3   | `rt.animeheaven.me/video.mp4?...&d`       | `link`     | **HTTP 200** video/mp4 | 636,947,070 |

The `&error2` / `&error` suffixes are **onerror fallback placeholders** in the gate page's `<video>` markup. The browser's player is expected to call the next `<source>` when one fails. The clean `&<token>` source (idx 2) and the `&d` download source (idx 3) are the real, playable media.

**The provider's `streamUrl` was set to the DEAD source `[0]` (`ck...&error2`).** That URL is what the proxy registered and attempted to replay, producing `{"error":"Upstream error 404."}`.

## 2. Static Code Trace — Why the dead source is selected

### 2a. `sortSourcesByQuality()` (in `services/animeHeavenProvider.js`)

```js
function qualityRank(quality) {
  const q = String(quality || "").toLowerCase();
  if (q.includes("2160") || q.includes("4k")) return 6;
  if (q.includes("1440") || q.includes("2k")) return 5;
  if (q.includes("1080")) return 4;
  if (q.includes("720")) return 3;
  if (q.includes("480")) return 2;
  if (q.includes("360")) return 1;
  if (q.includes("auto")) return 0;
  return 0;
}

function sortSourcesByQuality(sources) {
  return [...sources].sort((a, b) => {
    const qa = qualityRank(a.quality); // all 4 sources → 0
    const qb = qualityRank(b.quality); // all 4 sources → 0
    if (qa !== qb) return qb - qa;
    return String(a.url).localeCompare(String(b.url)); // ← lexicographic tie-break
  });
}
```

All four AnimeHeaven gate sources carry `quality:"auto"` (the gate page HTML does not attach 720p/1080p labels to the `<source>` elements). Therefore `qualityRank()` returns `0` for each, and the sort falls through to **`String(a.url).localeCompare(b.url)`**.

Lexicographically:

- `https://ck.animeheaven.me/video.mp4?...&error2` — sorted **first**
- `https://ct.animeheaven.me/video.mp4?...&error` — second
- `https://rt.animeheaven.me/video.mp4?...&<token>` — third
- `https://rt.animeheaven.me/video.mp4?...&d` — fourth

So `sources[0]` becomes the **dead `ck...&error2`** URL.

### 2b. `extractStreams()` picks `sources[0]`

```js
const streamUrl = sources[0]?.url || null;
// ...
return {
  provider: PROVIDER_NAME,
  streamUrl,            // ← DEAD ck...&error2
  sources,              // ← dead source is first
  ...
};
```

### 2c. `streamingService.normalizeProviderResult()` preserves ordering

```js
const normalizedSources = sources.map(...);   // keeps sources[0] = dead
return {
  streamUrl: result.streamUrl || (normalizedSources[0] ? normalizedSources[0].url : null),
  sources: normalizedSources,
  ...
};
```

### 2d. `resolveStream()` picks the "best" = the dead source

```js
const best = filteredSources.reduce((a, b) =>
  parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
, filteredSources[0]);
const payload = { provider, streamUrl: best.url, sources: filteredSources, ... };
```

All four have `parseQualityNumber("auto") === 0`, so `best` stays `filteredSources[0]` = the **dead `ck...&error2`**.

### 2e. `rewriteResultToProxy()` registers the dead source as `streamUrl`

```js
const first = rewritten[0];          // dead source's proxy URL
return { ...result, streamUrl: first.url, sources: rewritten, ... };
```

### 2f. Proxy replay fails

`streamProxyController.streamMedia` → `pipeStream(target)` → upstream **HTTP 404** → `res.status(404).json({ error: "Upstream error 404." })`.

The proxy correct. The context injection correct. The **selected target is simply a dead onerror placeholder**.

## 3. Why the earlier "STOP" report correctly flagged it

The COLD_PLAYBACK_REPORT recorded the same underlying symptom (`Upstream error 404.`) and its recommended direction (source prioritization, mirror/alternate fallback) was directionally correct. This forensic report now isolates the **exact** mechanism and confirms via live probing that a playable source exists and is bypassed.

## 4. Confirmed NOT the cause (ruled out)

- **Proxy context injection** — HEAD/GET with the same `getPlaybackContext()` headers returned 200 for the playable source; the headers are correct.
- **SSRF / host allow-listing** — `rt.animeheaven.me` (playable) is a public CDN host; not blocked.
- **CDN unavailability** — the playable source returned 200 with a valid 636,947,070-byte `video/mp4`.
- **Token expiry** — the 200 response proves the token/context is valid for the playable source.
- **Persistent cache architecture** — cache correctly stores raw CDN target + context; not implicated in the selection defect.
- **Security** — no CDN URL/token/cookie/referer/origin leaked to the browser; proxy confined to registered host.

## 5. Defect location (single root cause)

`services/animeHeavenProvider.js` → `sortSourcesByQuality()` + `extractStreams()`:

- The gate page's `<source>` elements are all labeled `auto` (no explicit quality), so the quality sort degenerates to a **lexicographic URL tie-break**.
- The `&error2` / `&error` onerror placeholders sort **first** and are **not playable** (404).
- The provider therefore selects a dead source as `streamUrl` and `sources[0]`, which the proxy faithfully replays → 404.

There is **no filtering of the `&error2`/`&error`/`&d` onerror/download variants** before ranking, and no ability to skip a dead source at selection time.

## 6. Blocked / Not Verified (read-only)

- **No code fix was implemented** (read-only task). Fixes are out of scope.
- **Full media bytes to a browser** not verified this run (the selection defect blocks the playable source from being served).
- **HLS manifest rewriting** not verified (the confirmed playable source is a direct MP4).

## 7. Defect resolution candidates (for a future, explicitly-requested fix — NOT applied)

1. **Filter dead onerror/download variants before ranking** — drop URLs whose query carries `&error2`/`&error`/`&d` (or a configurable suffix set) from the candidate list, and prefer clean `video.mp4?<key>&<token>` sources.
2. **Prefer genuine video sources over `link`/"Download" sources** when selecting `streamUrl`/`bestQuality`.
3. **Proxy-side alternate-source fallback** — on an authoritative upstream 403/404, transparently retry the next registered source before surfacing `Upstream error`.
4. **Selection-time liveness sanity check** — fail-open HEAD the chosen best source before committing it as `streamUrl`; if it is an explicit 403/404, pick the next candidate.

None of these were implemented. This document only records the confirmed root cause.
