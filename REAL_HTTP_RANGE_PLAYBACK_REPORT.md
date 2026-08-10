# Real HTTP Range Playback Verification

**Mode:** READ-ONLY (no source/config/DB/git modification)
**Date:** 2026-08-09
**Target:** `GET /api/stream-proxy/:streamId` with `Range: bytes=0-1023`
**Source material:** existing persistent cache row `episode_id=33` · `anime="Jujutsu Kaisen 0"` · `episode=1` · `provider=animeheaven` · `host=co.animeheaven.me`

---

## Verdict

> **PASS** — A real HTTP Range request against the browser-facing `/api/stream-proxy/:streamId` endpoint returned a genuine `HTTP 206 Partial Content` with correct `Content-Range`, `Content-Length: 1024`, `Accept-Ranges: bytes`, exactly **1024** response bytes, and **no** raw-CDN `Location` redirect.

---

## Why PASS

The previous `_verify_proxy.js` / `_runtime_proxy_play.js` runs only proved `statusCode=200`, `contentType=video/mp4`, `acceptRanges=bytes`, `bodyLen=0` via an **Express req/res mock**. That did not prove real byte-range support.

This diagnostic performed a **real HTTP request** against the running application's actual routing stack (`Express route → controller → upstream → proxy pipeline`) using the Node `http` client — **not** a mock. The upstream AnimeHeaven CDN itself honored the `Range` header and returned `206`, and the proxy relayed that `206` with the correct partial-content headers and exactly 1024 body bytes.

---

## Evidence

### Test #1 — Real HTTP Range request

| Check         | Result   | Value                                                         |
| ------------- | -------- | ------------------------------------------------------------- |
| `rangeReq`    | **PASS** | `status=206 body_bytes=1024`                                  |
| `rangeStatus` | **PASS** | `206`                                                         |
| `rangeCT`     | **PASS** | `video/mp4`                                                   |
| `rangeCR`     | **PASS** | `bytes 0-1023/636947070` (start=0, end=1023, total=636947070) |
| `rangeCL`     | **PASS** | `1024`                                                        |
| `rangeAR`     | **PASS** | `bytes`                                                       |
| `rangeBody`   | **PASS** | `1024`                                                        |
| `rangeLoc`    | **PASS** | `absent` (no redirect to raw CDN)                             |

### Test #2 — Normal GET (no Range)

| Check          | Result   | Value                                                                                                                     |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `normalStatus` | INFO     | `status=200 content-type=video/mp4 content-length=636947070 accept-ranges=bytes location=absent observed_body_bytes=7619` |
| `normalMedia`  | **PASS** | `status=200 location=absent` (streams correctly, no CDN redirect)                                                         |

---

## End-to-end flow proven

1. **Cache source (read-only SELECT)** — persistent cache row for `episode_id=33` exists: `stream_type=direct`, `source_count=2`, host `co.animeheaven.me`. No `/api/stream-proxy/` URL persisted.
2. **streamId minted** — `streamProxy.rewriteResultToProxy()` produced a fresh, in-memory-only `streamProxyStore` streamId.
3. **Host confinement** — `streamProxyStore.isHostAllowed(ctx, target)=true`; SSRF guard accepted the registered host.
4. **Real HTTP request** — `GET /api/stream-proxy/:streamId` with `Range: bytes=0-1023` through the actual Express route → `streamProxyController.streamMedia` → upstream `providerHttp.request()` → piped back to the client.
5. **Cache integrity** — row unchanged: `before_rows=1 after_rows=1`, `source_count 2→2`, no proxy URL persisted, `INSERT=0 UPDATE=0 DELETE=0` (only SELECTs).
6. **Server-side only** — `streamProxyStore` context (targetUrl/referer/origin/cookies) confirmed **not** persisted to DB.

---

## Leak check

The response **headers** are clean — **no** raw CDN URL, cookie, referer, origin, authorization, or internal-IP leak.

The only regex hit during analysis was inside the first 2000 bytes of the **binary MP4 media body** (raw video bytes can randomly contain the ASCII sequence `"token"`). This is **not** a security surface — the header **values** (the actual exposure boundary) showed zero leaks.

---

## Constraint compliance

- ✅ **READ-ONLY** — no source/config/DB/git changes.
- ✅ **No cache INSERT/UPDATE/DELETE** — only SELECT against `episode_stream_cache`.
- ✅ **No fixtures** — used the existing cached raw source as-is.
- ✅ **No `.env` changes**.
- ✅ **No git changes**.
- ✅ **Temporary server** — diagnostic server on `127.0.0.1:5099` started and **stopped** after the test.
- ✅ **Temporary files deleted** — all diagnostic scripts (`_postfix_range_verify.tmp.js`, `_rt_range_preflight.js`, `_rt_range_probe.js`, `DIAGNOSTIC_PLAN_QUESTION.md`) removed after use (confirmed `False` via `Test-Path`).

---

## Result table

| Check                                     | Status   |
| ----------------------------------------- | -------- |
| `rangeReq` (real HTTP Range)              | **PASS** |
| `rangeStatus` (206)                       | **PASS** |
| `rangeCT` (video/mp4)                     | **PASS** |
| `rangeCR` (bytes 0-1023/<total>)          | **PASS** |
| `rangeCL` (1024)                          | **PASS** |
| `rangeAR` (bytes)                         | **PASS** |
| `rangeBody` (1024 bytes)                  | **PASS** |
| `rangeLoc` (no redirect)                  | **PASS** |
| `normalMedia` (no CDN redirect)           | **PASS** |
| `cacheIntegrity` (row unchanged)          | **PASS** |
| `cacheMutations` (INSERT/UPDATE/DELETE=0) | **PASS** |
| `leak` (headers clean)                    | **PASS** |

**PASS = 12**

---

## Conclusion

The application's browser-facing `/api/stream-proxy/:streamId` endpoint delivers **genuine HTTP Range support**:

- `206 Partial Content` on `Range: bytes=0-1023`
- Correct `Content-Range: bytes 0-1023/636947070`
- `Content-Length: 1024`
- `Accept-Ranges: bytes`
- Exactly **1024** response bytes
- **No** raw-CDN redirect
- Raw CDN URL / playback context stays **server-side** only
