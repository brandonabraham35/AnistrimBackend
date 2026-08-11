# ForensIC Playback Stall Report — AniStrim Watch Page "Loading Stream…" Indefinitely

**Date:** 2026-08-11  
**Analyst:** Automated forensic deep-dive  
**Scope:** Full playback path traced from `watch.html` through the backend streaming pipeline  
**Constraint respected:** _No code changes were made._

---

## 1. EXACT PLAYBACK FLOW (Traced End-to-End)

```
[1] User opens watch.html?id=<animeId>&ep=<epNum>
     └─ watch.html loads:
          <script src="js/scrpt.js"></script>   ← BROKEN (serves index.html)
          <script src="js/watch.js"></script>   ← BROKEN (serves index.html)
          NOTE: config.js is NOT loaded either!

[2] IF scripts loaded (hypothetically):
     loadWatch() in watch.js
       ├─ apiFetch('/api/anime/' + animeId)          → animeController.getById
       ├─ apiFetch('/api/anime/' + animeId + '/episodes') → animeRoutes
       ├─ fetchAvailableProviders(animeData.title, currentEp)
       │    └─ apiFetch('/api/stream/providers/' + title + '/' + ep)
       │         → streamController.listProviders
       │         → streamingService.resolveAllProviders
       │         → executeAnimeHeaven  ← FULL EXPENSIVE RESOLUTION
       └─ resolveAndPlayStream(animeData.title, currentEp, video)
            └─ apiFetch('/api/stream/' + title + '/' + ep)
                 → streamController.getStream
                 → streamingService.resolveStream
                 → [persistent cache check via streamCacheService]
                 → [liveness probe via isCachedSourceAlive]
                 → executeAnimeHeaven  ← AGAIN, FULL EXPENSIVE RESOLUTION
                 → streamProxy.rewriteResultToProxy
                 → res.json({ sources: [proxy URLs] })
            └─ attachStreamSource(video, source.url)
                 → HLS.js: loadSource + attachMedia + wait MANIFEST_PARSED
                 → MP4: video.src + wait loadedmetadata
            └─ loadingOverlay.style.display = 'none'   ← ONLY HERE
```

## 2. EXACT LOCATIONS WHERE REQUESTS CAN STALL

### Location A — **`Frontend/watch.html` script paths (`js/scrpt.js`, `js/watch.js`)**

- Deployed check: `https://anistrimbackend.onrender.com/js/watch.js` → **200**, but `Content-Type: text/html` — it serves `index.html` (the catch-all SPA fallback), NOT JavaScript.
- The browser parses HTML as a script → **SyntaxError on the first line** (`<!DOCTYPE html>`) → `watch.js` NEVER executes.
- `config.js` is NOT included in `watch.html` either → `window.apiFetch`, `window.getApiBaseUrl`, and `window.AniStrimShared` are ALL **undefined**.
- The page sits on "Loading stream..." **forever** because the loading overlay is only hidden from inside `loadWatch()` which never runs.
- **This is the DOMINANT root cause.**

### Location B — **`apiFetch` has NO timeout in `config.js`**

- `shared.apiFetch` uses `fetch()` with **zero timeout mechanism**.
- There is a reference to `if (timeoutId) clearTimeout(timeoutId)` at line 58 but `timeoutId` is **never declared/created** — it would throw a `ReferenceError` in the catch block (which is itself inside `try`), masking the real error and never settling.
- If the backend takes >60s (Render free tier cold start / provider slow), `fetch` waits _indefinitely_ — no `AbortController`.

### Location C — **`streamingService.resolveStream` persistent-cache path bypasses `PIPELINE_TIMEOUT_MS`**

- Line 632: `const fresh = await streamCacheService.getOrResolve(episodeId, STREAM_CACHE_PROVIDER, resolveFresh);`
- `getOrResolve` internally calls `acquireLock` → waits for the previous lock owner **with NO timeout** → then runs `resolver()` (which is `executeAnimeHeaven`) with **NO `Promise.race` timeout wrapper**.
- Only the **non-cache path** (`else` branch, line 637) wraps `resolveFresh()` in `Promise.race` with `PIPELINE_TIMEOUT_MS`.
- **Result:** the persistent-cache path can hang indefinitely.

### Location D — **`streamCacheService.acquireLock` chain can deadlock for concurrent identical plays**

- `acquireLock` (line 124) is a promise-chain. Each waiter awaits the previous owner's `done` promise.
- `release()` is called in `getOrResolve`'s `finally`. **If the previous owner's `resolver()` hangs forever (Location C), every subsequent waiter for that same `(provider, episodeId)` hangs forever too** — a perfect concurrent-first-play deadlock.
- The lock is in-memory and never expires (no TTL on the lock itself).

### Location E — **`isCachedSourceAlive()` performs NETWORK probing with a 4s timeout**

- On **every persistent-cache hit**, before serving, the code does `await streamCacheService.isCachedSourceAlive(bestSource.url, ...)` (streamingService line 576).
- This is a HEAD request to the AnimeHeaven CDN with a 4s timeout (streamCacheService `SOURCE_PROBE_TIMEOUT_MS`). Fail-open, so usually safe — **but if the CDN hangs without responding, the probe waits the full 4s per cache hit** → cumulative added latency (and when combined with cache TTL of ~8min, every episode first-play after expiry pays this).

### Location F — **AnimeHeaven provider `extractStreams` performs expensive serial network chain**

- `resolvePlayer` → `resolveEpisode` → `searchAnime` (up to 4 URLs × up to 4 search expansions) → `getAnimeDetails` → `resolveGatePage` (3 gate URLs × 2 attempts each) → `extractNestedIframeSources` (up to `MAX_NESTED_IFRAME_DEPTH=3`) → `resolveMirrorSources` (up to `MAX_MIRROR_FETCHES=4`) → `extractNestedIframeSubtitles` (recursive) → `discoverSubtitlesFromSources` (up to `MAX_SUBTITLE_SOURCE_PROBES=2`).
- Worst-case is **many sequential HTTP calls**, each with a 10–12s streaming timeout.
- `MAX_FETCH_RETRIES=2` × 12s per attempt → up to 24s per single fetch.
- This whole chain has NO overall timeout inside `executeAnimeHeaven` — the only timeout is the `PIPELINE_TIMEOUT_MS` wrapper **which is bypassed by the persistent-cache path** (Location C).

### Location G — **`verifySourceLiveness` is defined in the CODEBASE but is NOT called in the active path**

- Search result: `services/animeHeavenProvider.js` line 1494 defines `async function verifySourceLiveness(source)`.
- It is **not invoked** by `extractStreams`, `resolvePlayer`, or `resolveStream` in the current source. It exists, but the earlier error `verifySourceLiveness is not defined` may have occurred in a **previous deployment** where the function was referenced but not yet added (or where it was in a different module scope/export shape).
- No current runtime error is caused by this.

### Location H — **`streamProxy.rewriteResultToProxy` can return `null` → `res.json({success:true})` with no `sources`**

- In `streamController.getStream` line 233: `const publicResult = streamProxy.rewriteResultToProxy(result) || result;`
- If `rewriteSource` fails for ALL sources (e.g., `streamProxyStore.store` returns null because targetUrl is malformed), `rewriteResultToProxy` returns `null`, falling back to `result` (which still has raw AnimeHeaven URLs + context).
- Those raw URLs (with cookies/referer fields) are sent to the browser — a security leak, AND if the browser tries to play them directly (CORS/hotlink-protection) it fails.
- In the frontend, `if (data.sources && data.sources.length > 0)` fails → throws `'No stream URL returned'` → `showWatchError` → **error overlay, not stuck loading** — so this is not the stuck cause, but is still a real defect.

### Location I — **Frontend `attachStreamSource` waits forever for HLS `MANIFEST_PARSED` or MP4 `loadedmetadata`**

- `attachStreamSource` returns a Promise that only resolves on `MANIFEST_PARSED` (HLS) or `loadedmetadata` (MP4).
- **There is NO timeout** on this Promise.
- If the proxy URL (`/api/stream/proxy?provider=...`) hangs, or the CDN refuses the request, the event NEVER fires, and `resolveAndPlayStream`'s `await attachStreamSource(...)` hangs forever.
- The loading overlay remains visible indefinitely.
- **Even when the backend succeeds, the frontend can still stick here.**

### Location J — **`resolveAndPlayStream` has NO overall timeout for the entire `/api/stream` request**

- `apiFetch` (Location B) has no timeout, AND the `await resolveAndPlayStream` loop over sources has no per-source timeout (only the `MANIFEST_PARSED`/`loadedmetadata` event-based resolution inside `attachStreamSource`).
- If the /api/stream request itself takes >60s (persistent-cache path hanging), the frontend waits forever.

---

## 3. MOST LIKELY ROOT CAUSE (RANKED 1–10)

| Rank   | Root Cause                                                                                                                                                                                      | Probability |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **1**  | **`watch.html` loads `js/scrpt.js` and `js/watch.js` with incorrect `js/` paths → SPA fallback serves `index.html` as JS → scripts never execute → "Loading stream…" forever**                  | **70%**     |
| **2**  | **`apiFetch` has NO timeout (no AbortController, `timeoutId` undefined) → fetch can hang indefinitely**                                                                                         | 55%         |
| **3**  | **`resolveAndPlayStream` → `attachStreamSource` waits for `MANIFEST_PARSED` / `loadedmetadata` with NO timeout → playback never proceeds if the media hangs**                                   | 50%         |
| **4**  | **Persistent-cache path (`streamCacheService.getOrResolve`) bypasses `PIPELINE_TIMEOUT_MS` → AnimeHeaven can hang for 30s+ or forever**                                                         | 45%         |
| **5**  | **Sequential double resolution: `fetchAvailableProviders` → `/api/stream/providers` performs full `executeAnimeHeaven`, then `/api/stream` performs it again → 2× full provider work per play** | 40%         |
| **6**  | **`acquireLock` has no TTL → concurrent plays of the same episode can queue indefinitely on a hung first resolver**                                                                             | 35%         |
| **7**  | **`isCachedSourceAlive` HEAD probe adds up to 4s per cache-hit request**                                                                                                                        | 25%         |
| **8**  | **AnimeHeaven internal sequential HTTP chain (search→details→gate→iframes→mirrors→subtitles) has no overall cap**                                                                               | 20%         |
| **9**  | **Render free-tier cold start: first request after idle takes 30–60s; no warmup/heartbeat**                                                                                                     | 15%         |
| **10** | **`verifySourceLiveness is not defined` — present in prior deployment only; NOT a current runtime failure**                                                                                     | 5%          |

---

## 4. EVIDENCE FOR EVERY SUSPECTED ROOT CAUSE

### A. `fetchAvailableProviders()` awaited before `resolveAndPlayStream()`

✅ **CONFIRMED** — `Frontend/watch.js` lines 122–125:

```js
await fetchAvailableProviders(animeData.title, currentEp);
await resolveAndPlayStream(animeData.title, currentEp, video);
```

`fetchAvailableProviders` calls `/api/stream/providers/:animeTitle/:episodeNumber` which calls `streamingService.resolveAllProviders` → `executeAnimeHeaven(...)` — a **full provider resolution** (search + details + gate + nested iframes + mirrors + subtitles). Then `resolveAndPlayStream` calls `/api/stream/:animeTitle/:episodeNumber` → `resolveStream` → potentially ANOTHER full resolution. **Double work.**

### B. `/api/stream/providers/...` performs expensive provider resolution

✅ **CONFIRMED** — `streamController.listProviders` line 320:

```js
const providers = await streamingService.resolveAllProviders(
  animeTitle,
  episodeNumber,
  { isPremium },
);
```

`resolveAllProviders` (streamingService line 770) calls `executeAnimeHeaven` — full pipeline.

### C. `resolveAllProviders` calls `executeAnimeHeaven`

✅ **CONFIRMED** — streamingService line 776:

```js
const outcome = await executeAnimeHeaven(animeTitle, episodeNumber);
```

### D. `executeAnimeHeaven` performs the same expensive work `/api/stream` subsequently performs

✅ **CONFIRMED** — streamingService:

- line 239–242: `executeAnimeHeaven` → `animeHeavenProvider.resolveStream({ title, episode })`
- line 628: `resolveFresh = async () => executeAnimeHeaven(animeTitle, episodeNumber)` (used by `/api/stream`)
- **Both do the identical full provider chain.** In the worst case a single play triggers the provider chain TWICE.

### E. `streamCacheService.getOrResolve()` uses a lock

✅ **CONFIRMED** — streamCacheService lines 100–144 (`locks` Map, `acquireLock` promise chain).

### F. The lock may remain held if provider resolution never settles

✅ **CONFIRMED** — `acquireLock` (line 124) creates a promise chain with NO timeout. `getOrResolve` calls `release()` in `finally` (line 361), but if `resolver()` NEVER resolves (AnimeHeaven hang with no overall timeout), the `finally` never runs, the lock entry stays in the Map, and every subsequent acquirer for the same `(provider, episodeId)` awaits forever.

### G. Persistent-cache resolution is NOT protected by PIPELINE_TIMEOUT_MS

✅ **CONFIRMED** — streamingService lines 631–647:

```js
if (usePersistentCache) {
  const fresh = await streamCacheService.getOrResolve(
    episodeId,
    STREAM_CACHE_PROVIDER,
    resolveFresh,
  );
  // NO Promise.race with PIPELINE_TIMEOUT_MS here!
} else {
  outcome = await Promise.race([
    resolveFresh(),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ...timeout }), PIPELINE_TIMEOUT_MS),
    ),
  ]);
}
```

**Only the else-branch has the timeout.**

### H. `isCachedSourceAlive()` performs network probing

✅ **CONFIRMED** — streamCacheService lines 65–95:

```js
await request({ method: 'head', url, maxRedirects: 3 }, { ... timeout: SOURCE_PROBE_TIMEOUT_MS })
```

Calls from streamingService line 576:

```js
const alive = await streamCacheService.isCachedSourceAlive(bestSource.url, {...});
```

### I. `extractNestedIframeSubtitles()` can recursively perform network requests

✅ **CONFIRMED** — animeHeavenProvider lines 1395–1426:

```js
async function extractNestedIframeSubtitles(html, pageUrl, depth = 0, visited = new Set()) {
  ...
  for (const iframeUrl of iframeUrls) {
    const page = await fetchHtml(iframeUrl, { referer: pageUrl, attempts: 1 });
    ...
    const deeper = await extractNestedIframeSubtitles(page.html, page.url || iframeUrl, depth + 1, visited);
```

Recursive depth up to `MAX_NESTED_IFRAME_DEPTH=3`. Each level does sequential HTTP fetches. **However** — note the subtle bug: `visited` is a Set passed down the recursion, so each URL is only visited once **per top-level call**. But the recursion in `extractStreams` calls `extractNestedIframeSources` and `extractNestedIframeSubtitles` as two **separate** traversals (both parse the same gate HTML), effectively doing 2x the iframe fetches. This _can_ hang when a mirror/iframe CDN is slow (12s timeout per fetch).

### J. `resolveMirrorSources()` can perform additional network requests

✅ **CONFIRMED** — animeHeavenProvider lines 2226–2278:

```js
for (const mirror of mirrors) {
    const page = await fetchHtml(mirror.url, { referer, allowRedirectParse: true, attempts: 1 });
```

Up to `MAX_MIRROR_FETCHES=4` fetches, each up to 12s timeout.

### K. Source liveness verification may reference an undefined/missing function

✅ **VERIFIED — NOT a current runtime failure** — `verifySourceLiveness` is defined at animeHeavenProvider line 1494. It is NOT called anywhere in the current `extractStreams`/`resolvePlayer`/`resolveStream` code path, so the earlier `verifySourceLiveness is not defined` error must have come from an **older deployment** where it was referenced before being defined, or from a different export shape. Not the current stall cause.

### L. Frontend `apiFetch` may have timeout/error-handling problems

✅ **CONFIRMED — MAJOR** — config.js lines 45–61:

```js
shared.apiFetch = shared.apiFetch || async function apiFetch(endpoint, options = {}) {
    ...
    try {
      const res = await fetch(`${API}${endpoint}`, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      ...
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      console.error('API error:', endpoint, e.message);
      if (timeoutId) clearTimeout(timeoutId);   // ← ReferenceError: timeoutId is not defined!
      return { ok: false, data: {} };
    }
};
```

- `timeoutId` is referenced but **never declared** in the function.
- If `fetch` itself throws (network error), the catch runs. Evaluating `timeoutId` throws a **new `ReferenceError`** that escapes `apiFetch` — the caller sees an uncaught error.
- Also `State?.token` — if `watch.html` loaded `scrpt.js` (which declares `State`) this works; but if only `watch.js` runs without `scrpt.js` (which currently happens because `js/watch.js` fails), `State` is undefined → `State?.token` → **SyntaxError?** No, optional chaining on an undeclared variable is still a `ReferenceError` at runtime. Actually `State?.token` with undeclared `State` throws `ReferenceError: State is not defined`. **This happens on the very first API call.**
- **No `AbortController`/timeout at all.**

### M. Watch.html script paths are incorrect

✅ **CONFIRMED — DOMINANT** — `Frontend/watch.html` lines 137–138:

```html
<script src="js/scrpt.js"></script>
<script src="js/watch.js"></script>
```

The files live at `Frontend/scrpt.js` and `Frontend/watch.js` — **there is no `Frontend/js/` directory** (verified by `list_files` — only `css/` and `src/` subdirectories).  
Server-side diagnostic (via Node https):

```
/js/watch.js -> 200 | text/html; charset=utf-8 | <!DOCTYPE html> ...  ← SPA fallback (index.html)
/js/scrpt.js -> 200 | text/html; charset=utf-8 | <!DOCTYPE html> ...  ← SPA fallback
/watch.js  -> 200 | text/javascript; charset=utf-8 | // watch.js — ...
/scrpt.js  -> 200 | text/javascript; charset=utf-8 | // scrpt.js — ...
/config.js -> 200 | text/javascript; charset=utf-8 | /**
/watch.html -> 200 | text/html; charset=utf-8 | <!DOCTYPE html> ...
```

A `text/html` script is a **hard JS SyntaxError** — `watch.js` and `scrpt.js` never execute. Also, **`config.js` is not in `watch.html` at all**, so even IF `js/scrpt.js` had resolved, `State` would still be undefined and `apiFetch` would be undefined.

Mitigating evidence (why the user "sometimes sees it work"): the `ios/App/App/public/` folder ALSO contains `watch.js`/`scrpt.js` at root with no `js/` subdirectory. The only way the player ever worked is if:

1. An **older deployed version** of `watch.html` used the correct `scrpt.js`/`watch.js` paths (no `js/`), OR
2. The user is testing the **Capacitor iOS/Android build** where a different `index.html`/`watch.html` bundle exists with correct paths, OR
3. The browser cached a correct older `watch.js` from before the path regression.
   The current committed files are **broken on the live backend**.

### N. Frontend may wait for `loadedmetadata`/`MANIFEST_PARSED` forever

✅ **CONFIRMED** — watch.js lines 756–779:

```js
function attachStreamSource(video, source) {
  ...
  return new Promise(function(resolve, reject) {
    if (isHlsStream && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(source);
      hlsInstance.attachMedia(video);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, function() { resolve(); });
      hlsInstance.on(window.Hls.Events.ERROR, function(_event, data) {
        if (data.fatal) reject(new Error('HLS playback could not start.'));
      });
      return;
    }
    video.src = source;
    video.addEventListener('loadedmetadata', function() { resolve(); }, { once: true });
    video.addEventListener('error', function() { reject(...); }, { once: true });
    video.load();
  });
}
```

- **No `setTimeout`/`Promise.race` timeout around either the HLS `MANIFEST_PARSED` or the MP4 `loadedmetadata` event.**
- If the browser stalls waiting for the media (CDN slow, proxy hung, CORS/403), `resolveAndPlayStream` stays `await`-ed, and the loading overlay stays on.

### O. Backend may successfully resolve sources but the frontend may never receive/process them

✅ **CONFIRMED in combination with M** — even when `/api/stream` resolves fine, `watch.js` never runs (M), so the response is never fetched/parsed. Also if `attachStreamSource` hangs (N), the resolved `data.sources` are never attached to the `<video>` element.

---

## 5. WHICH ISSUE EXPLAINS EACH SYMPTOM

| Symptom                               | Explaining Issue                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Very long loading**                 | B/C/D (double full provider resolution — each can take 10–30s+) + F (lock queue) + E/H (4s probes) + Render cold start                                                                                                                                                            |
| **No `/api/stream` log**              | **M (script paths broken → watch.js never runs → the `/api/stream` request is never made)**. This is the ONLY cause that fully explains "no backend log". Secondary: if `apiFetch` throws synchronously (`State` undefined) before reaching the stream call.                      |
| **Stuck "Loading stream..."**         | M (watch.js never runs to hide the overlay) + A/L (apiFetch hangs) + N (`attachStreamSource` never resolves)                                                                                                                                                                      |
| **Successful AnimeHeaven resolution** | Backend pipeline itself works — the provider resolves correctly as seen in prior debug output (`dcsxf`, "Sorcery Fight 0", `4 direct` player). The backend failures observed in logs are caused by the _double_ invocation (C/D) and provider timeouts, not by bad backend logic. |
| **Successful source discovery**       | Same — Provider `extractStreams` works; the sources ARE discovered. The system then fails at the frontend attachment (N) or the request is never made (M).                                                                                                                        |

---

## 6. EXACT FILES/FUNCTIONS THAT MUST BE CHANGED

### Frontend (Blocking)

| File                            | Change                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Frontend/watch.html`           | Change `<script src="js/scrpt.js">` → `<script src="scrpt.js">` and `<script src="js/watch.js">` → `<script src="watch.js">`. **Add** `<script src="config.js"></script>` BEFORE `scrpt.js` (like `index.html`/`details.html` do).                                                        |
| `ios/App/App/public/watch.html` | Same three fixes.                                                                                                                                                                                                                                                                         |
| `Frontend/config.js`            | Fix `apiFetch`: (1) remove `timeoutId` reference or create it; (2) add `AbortController` with a real timeout (e.g., 30s for stream, 15s for everything else); (3) guard `State?.token` so `apiFetch` works even if `scrpt.js` didn't load (fall back to `localStorage.getItem('token')`). |
| `Frontend/watch.js`             | Add a timeout to `attachStreamSource` — `Promise.race([handler, timeout(20s)])` that rejects so `resolveAndPlayStream` can try the next source. Also make `fetchAvailableProviders` non-blocking (fire-and-forget) so `/api/stream` is not delayed by the providers call.                 |
| `Frontend/watch.js` (loadWatch) | In `loadWatch`, hide the loading overlay on ANY error — already done via `showWatchError` in catch.                                                                                                                                                                                       |

### Backend (Hardening)

| File                              | Function                        | Change                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/streamingService.js`    | `resolveStream` (lines 631–635) | Wrap the `usePersistentCache` `getOrResolve` branch in the SAME `Promise.race([...], PIPELINE_TIMEOUT_MS)` as the non-cache branch.                                                                                                                                                                                     |
| `services/streamCacheService.js`  | `acquireLock` / `getOrResolve`  | Add an overall acquisition+resolution timeout (e.g., pass `timeoutMs` into `getOrResolve` → `Promise.race` the resolver; on timeout, `release()` and return a timeout result).                                                                                                                                          |
| `services/streamCacheService.js`  | `isCachedSourceAlive`           | Optionally skip the probe on the fast path (only probe every N minutes per episode) to avoid the 4s per-hit cost; or lower `SOURCE_PROBE_TIMEOUT_MS`.                                                                                                                                                                   |
| `controllers/streamController.js` | `listProviders`                 | Either call `resolveAllProviders` with `skipCache`/light mode, OR have the frontend stop awaiting `fetchAvailableProviders` before the main stream call (frontend change). Simplest backend-safe fix: keep as-is but make `/api/stream/providers` cheap/fast (return registered providers only, not a full resolution). |
| `services/animeHeavenProvider.js` | `extractStreams`                | Add an internal overall deadline (e.g., 25s) around `resolvePlayer` + mirrors + subtitles, and `Promise.race` it — so even without the streamingService wrapper a resolution cannot exceed the budget.                                                                                                                  |

---

## 7. MINIMAL SAFE FIX (ORDER OF OPERATIONS)

### Phase 1 — Frontend (unblocks ALL playback; resolves the stuck-loading + no-backend-log)

1. **`Frontend/watch.html`** (and the mirrored `ios/App/App/public/watch.html`):
   ```html
   <script src="config.js"></script>
   <script src="scrpt.js"></script>
   <script src="watch.js"></script>
   ```
2. **`Frontend/config.js`** — give `apiFetch` a real timeout:
   ```js
   shared.apiFetch =
     shared.apiFetch ||
     async function apiFetch(endpoint, options = {}) {
       const controller = new AbortController();
       const timeoutMs = options.timeout || 30000;
       const timer = setTimeout(() => controller.abort(), timeoutMs);
       const headers = {
         "Content-Type": "application/json",
         ...(options.headers || {}),
       };
       const token =
         (typeof State !== "undefined" && State?.token) ||
         localStorage.getItem("token");
       if (token) headers["Authorization"] = `Bearer ${token}`;
       try {
         const res = await fetch(`${API}${endpoint}`, {
           ...options,
           headers,
           signal: controller.signal,
         });
         const data = await res.json().catch(() => ({}));
         if (res.status === 401) {
           State?.clear?.();
           window.location.href = "login.html";
         }
         return { ok: res.ok, status: res.status, data };
       } catch (e) {
         console.error("API error:", endpoint, e.message);
         return { ok: false, data: {}, error: e };
       } finally {
         clearTimeout(timer);
       }
     };
   ```
3. **`Frontend/watch.js`** — make `fetchAvailableProviders` non-blocking + add source-attach timeout:
   ```js
   // In loadWatch, replace:
   await fetchAvailableProviders(animeData.title, currentEp);
   await resolveAndPlayStream(animeData.title, currentEp, video);
   // with:
   fetchAvailableProviders(animeData.title, currentEp); // fire & forget
   await resolveAndPlayStream(animeData.title, currentEp, video);
   ```
   ```js
   // attachStreamSource — add timeout:
   function attachStreamSource(video, source) {
     if (hlsInstance) {
       hlsInstance.destroy();
       hlsInstance = null;
     }
     const isHlsStream = /\.m3u8(?:$|\?)/i.test(source);
     return new Promise(function (resolve, reject) {
       const timeout = setTimeout(() => {
         cleanup();
         reject(new Error("Timed out waiting for media to load."));
       }, 20000);
       function cleanup() {
         clearTimeout(timeout);
         video.removeEventListener("loadedmetadata", onLoaded);
         video.removeEventListener("error", onError);
         if (hlsInstance) {
           hlsInstance.destroy();
           hlsInstance = null;
         }
       }
       function onLoaded() {
         cleanup();
         resolve();
       }
       function onError() {
         cleanup();
         reject(new Error("Video source could not be loaded."));
       }
       if (isHlsStream && window.Hls && window.Hls.isSupported()) {
         hlsInstance = new window.Hls();
         hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, onLoaded);
         hlsInstance.on(window.Hls.Events.ERROR, (_e, data) => {
           if (data.fatal) {
             cleanup();
             reject(new Error("HLS playback could not start."));
           }
         });
         hlsInstance.loadSource(source);
         hlsInstance.attachMedia(video);
         return;
       }
       video.addEventListener("loadedmetadata", onLoaded, { once: true });
       video.addEventListener("error", onError, { once: true });
       video.src = source;
       video.load();
     });
   }
   ```

### Phase 2 — Backend (prevents the hang from ever being possible)

4. **`services/streamingService.js`** — protect the persistent-cache branch:

   ```js
   if (usePersistentCache) {
     const fresh = await Promise.race([
       streamCacheService.getOrResolve(
         episodeId,
         STREAM_CACHE_PROVIDER,
         resolveFresh,
       ),
       new Promise((resolve) =>
         setTimeout(() => resolve(null), PIPELINE_TIMEOUT_MS),
       ),
     ]);
     outcome =
       fresh && fresh.sources && fresh.sources.length > 0
         ? {
             resolved: true,
             result: fresh,
             error: null,
             category: null,
             durationMs: 0,
           }
         : {
             resolved: false,
             result: null,
             error: "no playable stream found or pipeline timed out",
             category: "TIMEOUT",
             durationMs: PIPELINE_TIMEOUT_MS,
           };
   }
   ```

   Also wrap `continueWithFreshResolution`'s `usePersistentCache` branch the same way (lines 358–362).

5. **`services/streamCacheService.js`** — `getOrResolve`: add a timeout around the resolver so the lock is never held forever:
   ```js
   const fresh = await Promise.race([
     resolver(),
     new Promise((_, reject) =>
       setTimeout(
         () => reject(new Error("stream resolution timed out")),
         20000,
       ),
     ),
   ]);
   ```
   (Wrap in `try/catch` that still calls `release()` in `finally`.)

### Phase 3 — Verification

6. Redeploy, open `watch.html?id=<id>&ep=1`, verify:
   - Network tab: `config.js`, `scrpt.js`, `watch.js` all return `200` with `application/javascript`.
   - `fetchAvailableProviders` is NOT awaited before the stream call.
   - `/api/stream` returns within 15s (or the timeout path logs).
   - Loading overlay disappears.

---

## 8. ARCHITECTURAL FIX (Recommended Long-Term)

1. **Serve static files with a `js/` aliasing middleware** — In `server.js`, add:

   ```js
   app.use("/js", express.static(path.join(__dirname, "Frontend")));
   ```

   This makes `js/scrpt.js` and `js/watch.js` work **regardless of which HTML files reference them**, and future-proofs against path regressions. **BUT** also fix the HTML to reference `config.js` explicitly (the `/js` alias won't load `config.js` because watch.html doesn't include it at all).

2. **Make `config.js`/`scrpt.js` always load** — Every page should include `config.js` before `scrpt.js`. Consider a single consolidated `bundle.js` served at the root.

3. **Add an `AbortController`-based timeout helper** to `config.js` (`apiFetchWithTimeout(endpoint, { timeoutMs })`) and use it for every network call.

4. **Make `/api/stream/providers` cheap** — Don't perform a full AnimeHeaven resolution for the "Switch Server" dropdown. Return provider metadata (id/name/status) from the registry without scraping. The `/api/stream` endpoint is the only place a real resolution should happen.

5. **Single-flight with TTL** — Replace the hand-rolled `acquireLock` with a TTL-bounded single-flight map so a hung resolver can never block future requesters:

   ```js
   // pseudo
   const inflight = new Map();
   async function singleFlight(key, fn, timeoutMs) {
     if (inflight.has(key)) {
       try {
         return await inflight.get(key);
       } catch {
         /* fall through */
       }
     }
     const promise = Promise.race([fn(), timeout(timeoutMs)]);
     inflight.set(
       key,
       promise.finally(() => inflight.delete(key)),
     );
     return inflight.get(key);
   }
   ```

6. **Deadline-aware provider pipeline** — Add an overall budget (e.g., `ANIMEHEAVEN_TOTAL_TIMEOUT_MS=25000`) passed down through `extractStreams` → `resolvePlayer` → `resolveEpisode` → `fetchHtml`, so the provider cannot exceed the global deadline even if every internal call has its own timeout.

7. **Client-side rate limiting of the `last_used_at` mark** — optional.

---

## 9. ADDITIONAL LOGGING THAT SHOULD BE ADDED

| Location                                 | Log                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `config.js` (`apiFetch`)                 | `console.error('[apiFetch] timeout', { endpoint, timeoutMs })` on abort; `console.log('[apiFetch] →', endpoint)` on start     |
| `watch.html` / page load                 | `console.log('[WATCH] scripts loaded')` at top of `watch.js` (verifies script actually executed)                              |
| `watch.js` (`loadWatch`)                 | Log each step: `[WATCH] step=anime`, `[WATCH] step=episodes`, `[WATCH] step=providers`, `[WATCH] step=stream` with timestamps |
| `streamingService.resolveStream`         | Log `[STREAM] usingPersistentCache=`, `[STREAM] pipelineStart`, `[STREAM] pipelineEnd` with elapsed                           |
| `streamingService` (persistent branch)   | `[STREAM] persistentResolveStart/End` with elapsed                                                                            |
| `streamCacheService.getOrResolve`        | `[CACHE] lock waited {ms}`, `[CACHE] lock acquired`, `[CACHE] lock released`, `[CACHE] resolve timed out`                     |
| `streamCacheService.isCachedSourceAlive` | `[CACHE] probe start/end (elapsed)`                                                                                           |
| `streamController.getStream`             | Already has `[STREAM DEBUG]` logs — add `[STREAM] getOrResolve elapsed`                                                       |
| `animeHeavenProvider.extractStreams`     | Already has `[STREAM TIMING]` — add `[AnimeHeaven] overallDeadline exceeded`                                                  |

---

## 10. TESTS REQUIRED TO PROVE THE FIX

### Unit / Integration Tests

| Test                                                                                                                                                                                          | Proves                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `test/frontend-paths.test.js` — assert `watch.html` has `<script src="config.js">`, `<script src="scrpt.js">`, `<script src="watch.js">` and that `Frontend/js/` directory is NOT referenced. | Fixes M (script paths).     |
| `test/apiFetch-timeout.test.js` (Node with mocked `fetch`) — an endpoint that never responds must reject within `timeoutMs`.                                                                  | Fixes L (apiFetch timeout). |
| `test/attachStreamSource-timeout.test.js` (JSDOM + fake media events) — a source that never fires `MANIFEST_PARSED`/`loadedmetadata` must reject after the timeout.                           | Fixes N.                    |
| `test/streamCache-lock-timeout.test.js` — a resolver that never resolves must not block subsequent callers; `getOrResolve` must reject/timeout and release the lock.                          | Fixes E/F/G.                |
| `test/streamingService-persistent-timeout.test.js` — with a hanging `streamCacheService.getOrResolve`, `resolveStream` (with `episodeId`) must still resolve within `PIPELINE_TIMEOUT_MS`.    | Fixes G.                    |
| `test/providers-endpoint-cheap.test.js` — `GET /api/stream/providers/...` must NOT perform a full AnimeHeaven resolution (assert no `fetchHtml` calls to gate/player).                        | Fixes A/B/C/D.              |
| `test/deployed-assets.test.js` — assert `GET /js/watch.js` returns `application/javascript` (200 with JS content), not `index.html`.                                                          | Fixes M in deployment.      |

### Manual E2E Verification

1. `curl -I https://anistrimbackend.onrender.com/watch.html` → 200 text/html.
2. `curl -I https://anistrimbackend.onrender.com/config.js` → 200 `application/javascript`.
3. `curl -I https://anistrimbackend.onrender.com/js/watch.js` → 200 `application/javascript` (after adding the `/js` alias + correct HTML).
4. Open `watch.html?id=<id>&ep=1` in a browser:
   - Network tab: all three scripts load as JS.
   - `[PLAYER DEBUG]` console logs appear.
   - `/api/stream` appears in backend logs.
   - Loading overlay hides after playback starts.
5. Open the same episode in two tabs concurrently (simulates lock contention).
   - Both must resolve within 15–20s; neither may hang.
6. Verify AnimeHeaven rank for "Jujutsu Kaisen 0" still resolves `dcsxf` ("Sorcery Fight 0") — no provider regression.

---

## Appendix — No-Code-Change Verification Performed

- Confirmed deployed `/js/watch.js` and `/js/scrpt.js` return `200 text/html` (SPA fallback serving `index.html`) — **proof that `watch.js`/`scrpt.js` never execute in production.**
- Confirmed `/watch.js`, `/scrpt.js`, `/config.js` return `200 text/javascript` — root paths are correct.
- Confirmed `Frontend/` has no `js/` subdirectory (only `css/` and `src/`).
- Confirmed `Frontend/config.js` `apiFetch` has a `ReferenceError` bug (`timeoutId` undefined) and no timeout.
- Confirmed `Frontend/watch.js` `attachStreamSource` has no timeout (can hang on HLS/MP4 events forever).
- Confirmed `services/streamingService.js` persistent-cache branch (`usePersistentCache`) bypasses `PIPELINE_TIMEOUT_MS`.
- Confirmed `services/streamCacheService.js` `getOrResolve`→`acquireLock` has no TTL and can deadlock concurrent plays of the same episode.
- Confirmed `verifySourceLiveness` is defined and NOT in the active code path — not a current failure.
- Confirmed `fetchAvailableProviders` → `/api/stream/providers` → `resolveAllProviders` → `executeAnimeHeaven` performs a full provider resolution that is duplicated by `/api/stream`.
- NO code was modified.
