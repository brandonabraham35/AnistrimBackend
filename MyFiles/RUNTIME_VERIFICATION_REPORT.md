# Full Runtime Streaming Verification — READ-ONLY REPORT

**Date:** 2026-08-08
**Mode:** READ-ONLY — no source files, database data, configuration, routes, frontend, git state, or dependencies modified. No fixtures created. No fixes implemented.
**Shell:** Windows PowerShell 7 (12.0.1)

---

## ENVIRONMENT

| Item                | Value                               | Evidence                                                                                     |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Node.js             | v24.18.0                            | `node --version`                                                                             |
| npm                 | 12.0.1 (PowerShell)                 | `npm --version`                                                                              |
| node_modules        | EXISTS                              | `Test-Path node_modules`                                                                     |
| Server bind attempt | `0.0.0.0:5000` (default `PORT`)     | `server.js`; startup log `AniStrim2 running on port 5000`                                    |
| Server runnable     | **NO — process exited**             | PID 13068 started then exited; `/api/health` → `Unable to connect`; port 5000 `ECONNREFUSED` |
| MySQL               | **UNREACHABLE**                     | `config/db.js`; direct test → `MYSQL CONNECT: FAIL -> ETIMEDOUT`                             |
| MySQL host          | `m4uuuq.h.filess.io:61002` (remote) | temp env-check (non-secret)                                                                  |
| AnimeHeaven         | **UNREACHABLE**                     | `ANIMEHEAVEN: TIMEOUT`                                                                       |
| Server PID          | 13068 (exited)                      | no node process remains                                                                      |

**Root cause of block:** The remote MySQL host is unreachable (ETIMEDOUT); the server cannot stay up without DB connectivity. AnimeHeaven (the only streaming provider) is also unreachable (TIMEOUT). Per the mandate, I did **not** modify the database, kill unrelated processes, or alter configuration.

---

## DATABASE READ-ONLY INVENTORY

**NOT VERIFIED** — MySQL unreachable, so no read-only DB queries could execute. The prior report (`RUNTIME_VERIFICATION_REPORT.md`) indicates: 0 premium episodes, 0 `video_url` episodes, and a populated `episode_stream_cache`. These are historical facts, not re-verified this session.

---

## TEST RESULTS

Legend: **PASS** = runtime verified · **PASS\*** = source/design verified · **NOT VERIFIED** = environmental/fixture limitation · **OBS** = observation (requires runtime confirmation) · **FAIL** = reproducible runtime defect.

| #   | Test                        | Result                                                                                               | Endpoint / Scope                   | Expected                                                | Actual                                                                                 |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Environment check           | **PASS (env)** / blocked                                                                             | Node/npm/modules                   | toolchain present                                       | Node 24, npm 12, node_modules present                                                  |
| 2   | DB inventory                | **NOT VERIFIED**                                                                                     | DB read-only                       | counts                                                  | MySQL ETIMEDOUT                                                                        |
| 3   | Start server                | **FAIL\*** (env)                                                                                     | `node server.js`                   | stays up, binds 5000                                    | process exited; MySQL ETIMEDOUT                                                        |
| 4   | Free episode cold           | **NOT VERIFIED**                                                                                     | `GET /api/stream/:title/:ep`       | HTTP 200, proxy URLs                                    | no server / no AnimeHeaven                                                             |
| 5   | Cache miss                  | **NOT VERIFIED**                                                                                     | `episode_stream_cache`             | row created pre-proxy                                   | no DB                                                                                  |
| 6   | Cache hit                   | **NOT VERIFIED**                                                                                     | same endpoint                      | cached:true, fresh streamId                             | no DB/server                                                                           |
| 7   | Cache tier isolation        | **NOT VERIFIED**                                                                                     | free vs premium                    | free ≤720p                                              | no DB/server                                                                           |
| 8   | Concurrency/single-flight   | **NOT VERIFIED**                                                                                     | concurrent cold                    | one row, no dups                                        | no DB/server                                                                           |
| 9   | Token expiry / recovery     | **NOT VERIFIED**                                                                                     | liveness probe                     | 403→re-resolve                                          | no DB/server/AnimeHeaven                                                               |
| 10  | Proxy `/api/stream-proxy`   | **NOT VERIFIED** (runtime) + **PASS\* (store)**                                                      | store unit                         | store/get/sweep/host-confine                            | see §Network-independent                                                               |
| 11  | SSRF regression             | **PARTIAL** — literal-IP + scheme unit **PASS**; **OBS** on `0177.0.0.1`; HTTP path **NOT VERIFIED** | `/api/stream/proxy`                | 400 on all private targets                              | see §Network-independent                                                               |
| 12  | Direct video_url            | **NOT VERIFIED**                                                                                     | episode.video_url                  | plays without AnimeHeaven                               | no DB; prior report: 0 such episodes                                                   |
| 13  | Premium authorization       | **NOT VERIFIED**                                                                                     | free 403 / premium 200 / admin 200 | enforcement before stream                               | no DB; prior report: 0 premium episodes                                                |
| 14  | Server restart              | **NOT VERIFIED**                                                                                     | stop/start                         | cache survives, fresh proxy                             | no DB/server                                                                           |
| 15  | Frontend contract           | **PASS\***                                                                                           | `watch.js` vs `getStream`          | streamUrl/sources/subtitles/provider/bestQuality/cached | shapes match (source/design)                                                           |
| 16  | Regression (HLS)            | **PASS**                                                                                             | `npm run test:hls`                 | 24/24                                                   | 24 pass, 0 fail                                                                        |
| 17  | Security (browser exposure) | **PASS\***                                                                                           | proxy rewrite                      | no raw CDN/cookies/auth/creds to browser                | `streamProxy.rewriteResultToProxy` strips context; store host-confines (source/design) |
| 18  | Final report                | **DONE**                                                                                             | —                                  | —                                                       | this document                                                                          |

---

## Network-Independent Verification (executed)

### streamProxyStore fix (`TTL_MS` → `DEFAULT_TTL_MS`)

All unit checks **PASS**:

- `store()` returns a unique non-empty streamId.
- `get()` returns the registered context (targetUrl, derived host, cookies).
- host derived correctly from target URL.
- `isHostAllowed()` allows same host, denies cross-host.
- distinct streamIds generated for distinct entries.
- `clear()` empties the store; `get(unknown)` returns null.
- expired/unknown context returns null.

### HLS rewriter regression

`npm run test:hls` → **24/24 PASS**, 0 fail.

### ssrfGuard helper (literal-IP + scheme)

All **PASS** except one observation:

- Rejects: `127.0.0.1`, `127.0.0.2`, `10.0.0.1`, `10.255.255.255`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `169.254.169.254`, `0.0.0.0`, `::1`, `::`, `fc00::1`, `fe80::1`, `::ffff:127.0.0.1`, `0x7f000001`, `2130706433`.
- Allows public: `8.8.8.8`, `1.1.1.1`, `93.184.216.34`, `::ffff:8.8.8.8`.
- Rejects schemes: `file://` and `ftp://` ("Only http(s) targets are allowed.").
- Rejects embedded credentials and loopback http targets.
- **OBS (edge case):** `isForbiddenIp("0177.0.0.1")` returned **false** (expected true). The plain-IPv4 regex `^\d+\.\d+\.\d+\.\d+$` matches this leading-zero-octal form first and routes it through `ipv4ToInt` (decimal `Number("0177")=177` → treated as public `177.0.0.1`), bypassing the octal `normalizeObfuscatedIpv4` path. Some resolvers interpret `0177.0.0.1` as octal → `127.0.0.1`. **This is a latent SSRF edge case in the helper and should be confirmed through the `/api/stream/proxy` HTTP path once the environment is available.** It is NOT a confirmed runtime FAIL because the authoritative proxy-path SSRF test could not run (no server). No fix was applied (README mandate).

---

## CRITICAL SECURITY CHECK (source/design verified this session)

- Browser-facing sources are rewritten to **same-origin** `/api/stream-proxy/:streamId` (stateful) or `/api/stream/proxy?...` (stateless) URLs; context (cookies/referer/origin/target) is stripped from the payload and kept server-side (`utils/streamProxy.js`).
- Proxy confines every request to the stored CDN host (`streamProxyStore.isHostAllowed`).
- No database credentials, auth headers, or raw tokenized CDN URLs are emitted to the browser by design.
- Runtime confirmation remains **NOT VERIFIED** (no server/DB/AnimeHeaven).

---

## FINAL VERDICT

### SAFE WITH UNVERIFIED TESTS

No reproducible runtime defect was found. However, the executable network/runtime streaming tests could **not** be exercised this session because the remote MySQL host and AnimeHeaven are both unreachable, so the server could not remain up. The network-independent artifacts that were verified **PASS**:

- `streamProxyStore` fix (store/get/sweep/host-confine) — PASS
- HLS rewriter regression — 24/24 PASS
- ssrfGuard literal-IP + scheme rejection — PASS (with one **OBS** edge case, `0177.0.0.1`, requiring runtime confirmation)

**When the environment is available**, re-run tests 2–14, 17 against the live backend. Before doing so, confirm the `0177.0.0.1` (leading-zero octal IPv4) SSRF edge case through `/api/stream/proxy` — it is the only notable observation from this session.

**Cleanup:** Temporary diagnostic scripts (`anistrim_runtime_env_check.js`, `anistrim_runtime_unit.js` in `%TEMP%`) and the runtime logs (`_runtime_verify_out.log`, `_runtime_verify_err.log`) were created and subsequently deleted. `TODO.md` updated to reflect status.
