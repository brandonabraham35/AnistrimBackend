# COLD PLAYBACK REPORT — Live Stream Resolution Verification

**Date:** 2026-08-08
**Method:** Live cold-path runtime exercise (real AnimeHeaven resolution)
**Scope:** `Client → streamController → streamingService → AnimeHeaven provider → gate/token → raw CDN source → episode_stream_cache → streamProxyStore → /api/stream-proxy/:streamId → browser-safe response`
**Mode:** Read-only verification. No source/DB/config/frontend/route/CMS/auth/payment/git modifications, no fixtures, no fixes. The only writes were the normal runtime side effects of the pipeline itself (persistent-cache population on a genuine cold cache miss) and this report.

---

## VERDICT

# ❌ STOP — PLAYBACK DEFECT

**The cold stream resolution succeeds and is security-clean, but the proxy CANNOT replay the freshly-resolved AnimeHeaven CDN source. The upstream CDN returns HTTP 404 when the proxy fetches the resolved `video.mp4` with the server-side context.**

This directly contradicts the architecture requirement "the proxy route can play that freshly resolved source" and is classified as **STOP — FIX REQUIRED** per the acceptance criteria.

---

## 1. Environment

| Item                      | Value                                              |
| ------------------------- | -------------------------------------------------- |
| Node                      | v24.18.0                                           |
| npm                       | 12.0.1                                             |
| node_modules              | Present                                            |
| server.js                 | Present                                            |
| .env                      | Present (loaded; secrets never printed)            |
| MySQL config              | `config/db.js` (mysql2 pool, `connectionLimit: 3`) |
| Server process            | Started (PID 6340), health `/api/health` → **OK**  |
| Server stopped after test | ✅ Yes                                             |

Note: The first launch attempt hit an intermittent `MySQL connection failed: connect ETIMEDOUT` (server startup pool probe). A clean re-run succeeded (`✅ MySQL connected`), so this was a transient connectivity issue, not a persistent failure.

## 2. Candidate Test Data (used for the cold test)

- **Anime:** "Jujutsu Kaisen 0" (anime_id=41, media_type=TV)
- **Episode:** 1 (episode_id=33)
- **Premium:** No (free episode — valid for a free-tier test)

## 3. Cold Resolution — `/api/stream/Jujutsu%20Kaisen%200/1`

- **HTTP status:** `200`
- **Response shape:** `{ success, provider, streamUrl, sources, subtitles, bestQuality, tier, episodeNumber, resolvedFrom }`
- **Provider:** `animeheaven`
- **Stream URL:** `/api/stream-proxy/7fd25b4847437115f69cb23347e9f6affd4e` (browser-safe same-origin proxy)
- **Sources (4):** all returned as `/api/stream-proxy/<streamId>` with `proxied: true`
- **Subtitles:** none returned
- **Best quality:** `Download Episode 1` (a link-type source ranked highest; no explicit 720p/1080p quality label was attached to the video sources)

### 3a. Security Audit — ✅ PASS

- **No raw CDN URLs** in the browser-facing response (`rawCdnUrlsInResponse: false`)
- **No leaking tokens/keys:** no `token=`, `access=`, `expires=`, `account_id=`, `signature=`, `auth_key=`, `hash=`, `key=` value pairs
- **No cookies, `Referer`, `Origin`, or `Authorization` headers/fields** exposed
- **No `Content-Range`/upstream media injected** into the JSON body
- **Security issues found:** `0`

## 4. Persistent Cache Inspection (read-only) — ✅ PASS

A single `episode_stream_cache` row was created by the normal cold-resolution flow (expected side effect of a cold cache miss):

| Field                                                                  | Value                                    |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `provider`                                                             | `animeheaven`                            |
| `stream_type`                                                          | `direct`                                 |
| `resolved_at`                                                          | 2026-08-08T21:59:57Z                     |
| `expires_at`                                                           | 2026-08-08T22:07:57Z                     |
| **Cache TTL**                                                          | **8 min** (≤ `COOKIE_TTL_MS` = 8 min ✅) |
| `references_proxy` (stores `/api/stream/proxy` or `/api/stream-proxy`) | **false** ✅                             |
| `has_context` (referer/origin/cookies present server-side)             | **true** ✅                              |

**Stored source URLs (raw CDN targets, NOT proxy URLs):**

- `https://ck.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&fad15a5a10ce1e1fe12f747d7a3c1c8e&error2`
- `https://ct.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&fad15a5a10ce1e1fe12f747d7a3c1c8e&error`
- `https://rt.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&d`
- `https://rt.animeheaven.me/video.mp4?d4dfb40b72870f4f7377c89479af784b&fad15a5a10ce1e1fe12f747d7a3c1c8e`

**Conclusion:** The persistent cache correctly stores the **raw CDN target + server-side context** and never persists an ephemeral `/api/stream/proxy` URL. Cache architecture is verified as correct.

## 5. Proxy Replay — `GET /api/stream-proxy/7fd25b4847437115f69cb23347e9f6affd4e` — ❌ FAIL

- **HTTP status:** `404`
- **Content-Type:** `application/json; charset=utf-8`
- **Body:** `{"error":"Upstream error 404."}`
- **Redirect to raw CDN:** No (good — no CDN leak)
- **Range test:** Not performed (response was a JSON error, not media)

### Root cause (from `controllers/streamProxyController.js`)

`pipeStream()` fetches the stored raw CDN `video.mp4?<token>` via `utils/providerHttp.request()` with `streaming: true` and `maxRedirects: 5`. The AnimeHeaven CDN returned **HTTP 404** for the freshly-resolved source. The controller translates that into `{"error":"Upstream error 404."}`.

**Why this matters:** The cold-resolution stage produced a _valid-looking_ source URL (token resolving to the CDN), but when the proxy actually fetched that URL with the server-side playback context, the CDN rejected it with **404**. A 404 is an explicit, authoritative rejection — not a transient network error. This means the freshly-resolved source is **not playable**, regardless of the proxy's correct context injection.

Notably, the proxy does **not** implement a mirror/alternate-source fallback at replay time. It fetches only the single registered target. Because the first (best-quality) source died with 404, no fallback to the other three cached CDN variants was attempted by the proxy.

## 6. Frontend Contract Check (vs `Frontend/watch.js`) — ⚠️ PARTIAL

`watch.js` consumes: `streamUrl`, `bestQuality`, `provider`, `sources`, `subtitles`, (and uses `cached` optionally).

| Field         | Present?         | Notes                                                     |
| ------------- | ---------------- | --------------------------------------------------------- |
| `streamUrl`   | ✅               | `/api/stream-proxy/...`                                   |
| `bestQuality` | ✅               | `"Download Episode 1"` (link source, not a video quality) |
| `provider`    | ✅               | `animeheaven`                                             |
| `sources`     | ✅               | 4 proxied sources                                         |
| `subtitles`   | ✅ (empty array) |                                                           |
| `cached`      | ⚠️ absent        | Cold path — acceptable; `watch.js` does not require it    |

The contract is structurally compatible, but the returned `streamUrl` leads to a 404 at playback time, so the **functional** contract (an episode that actually plays) is **not met**.

---

## Blocked / Not Verified

- **Actual media bytes transported to a browser:** NOT VERIFIED — the proxy returned a 404 error, so no media/byte-range test could be performed.
- **Range / HTTP 206 support:** NOT VERIFIED — no media response was obtained to test against.
- **HLS manifest rewriting path:** NOT VERIFIED — the resolved source was a direct MP4 (`stream_type: direct`), not HLS.
- **Raw-CDN direct access:** Not tested (and not required — the architecture intentionally proxies everything).

---

## Root-Cause Summary

1. **Cold resolution** (AnimeHeaven → token → raw CDN source) works.
2. **Security** (no CDN/token/cookie/referer/origin leakage; browser gets only `/api/stream-proxy/:streamId`) works.
3. **Persistent cache** stores the raw CDN target + context correctly with a valid ≤8-min TTL.
4. **Proxy replay** fails: the chosen best source returns **upstream HTTP 404**, and the proxy has **no fallback to the other cached CDN sources** at replay time.

## Recommended Direction of Fix (NOT implemented — read-only verification)

When a fix is requested, the likely candidates (to be validated separately) are:

- **Mirror/alternate-source fallback in the proxy** — on an authoritative upstream 403/404, transparently retry the _next_ cached CDN source before surfacing an error.
- **Source prioritization** — prefer a genuine video-quality source (`720p`/`1080p`) over a link-type `"Download Episode 1"` source when selecting `streamUrl`/`bestQuality`.
- **Cache invalidation + re-resolution** — when the replay 404s, invalidate the dead cache row and re-resolve AnimeHeaven fresh (gate.php → new token), mirroring the existing `isCachedSourceAlive` fail-open probe.

No code was changed to implement any of these — this report only documents the defect.
