# RUNTIME_SECURITY_REPORT — POST-FIX SSRF + PROXY SECURITY VERIFICATION

**Date:** Read-only verification run
**Scope:** Complete SSRF/proxy boundary (`utils/ssrfGuard.js`, `utils/streamProxyStore.js`, `utils/streamProxy.js`, `utils/streamProxyHeaders.js`, `controllers/streamProxyController.js`, `controllers/streamProxyQueryController.js`, `routes/streamProxyRoutes.js`, `routes/streamRoutes.js`, `utils/providerHttp.js`, `utils/hlsRewriter.js`)
**Mode:** READ-ONLY — no source code, database, configuration, git state, or test fixture modified. No SSRF protection weakened or bypassed.

---

## 1. Regression Tests

| #   | Test                   | Command                              | Expected         | Actual           | Result   | Evidence                                   |
| --- | ---------------------- | ------------------------------------ | ---------------- | ---------------- | -------- | ------------------------------------------ |
| 1.1 | ssrfGuard syntax check | `node --check utils/ssrfGuard.js`    | exit 0           | exit 0           | **PASS** | `node --check` returned 0                  |
| 1.2 | ssrfGuard unit tests   | `node --test test/ssrfGuard.test.js` | 12 pass / 0 fail | 12 pass / 0 fail | **PASS** | `tests 12, pass 12, fail 0`                |
| 1.3 | `npm run test:ssrf`    | `npm run test:ssrf`                  | 12 pass / 0 fail | 12 pass / 0 fail | **PASS** | `tests 12, pass 12, fail 0`                |
| 1.4 | `npm run test:hls`     | `npm run test:hls`                   | 24 pass / 0 fail | 24 pass / 0 fail | **PASS** | `tests 24, pass 24, fail 0` (HLS rewriter) |

> Note: `npm notice run ...` lines are npm's normal stderr notices wrapped by PowerShell as `NativeCommandError`; they are **not** test output or failures.

---

## 2. HTTP-Level SSRF Verification (`_p1_ssrf_verify.js`)

### 2.1 MUST REJECT — all 35/35 PASS

| Target                                                                                        | Expected               | Actual   | Result   |
| --------------------------------------------------------------------------------------------- | ---------------------- | -------- | -------- |
| `http://127.0.0.1/`, `http://127.0.0.1:8080/admin`                                            | reject                 | rejected | **PASS** |
| `http://localhost/`, `http://localhost:3000/`                                                 | reject (DNS rebinding) | rejected | **PASS** |
| `http://[::1]/`, `http://0.0.0.0/`                                                            | reject                 | rejected | **PASS** |
| `http://10.0.0.1/`, `http://172.16.0.1/`, `http://172.31.255.255/`, `http://192.168.1.1/`     | reject                 | rejected | **PASS** |
| `http://169.254.169.254/`, `http://169.254.0.1/latest/meta-data/`                             | reject                 | rejected | **PASS** |
| `http://[::ffff:127.0.0.1]/`, `http://[::ffff:192.168.1.1]/`, `http://[::ffff:7f00:1]/`       | reject                 | rejected | **PASS** |
| `http://2130706433/` (decimal), `http://0x7f000001/` (hex)                                    | reject                 | rejected | **PASS** |
| `http://0177.0.0.1/` (octal), `http://127.1/` (class-A), `http://0177.0.0.01/` (leading-zero) | reject                 | rejected | **PASS** |
| `http://100.64.0.1/`, `http://100.127.255.254/` (CGNAT)                                       | reject                 | rejected | **PASS** |
| `http://192.0.2.1/`, `http://198.51.100.1/`, `http://203.0.113.1/` (TEST-NET)                 | reject                 | rejected | **PASS** |
| `http://224.0.0.1/` (multicast)                                                               | reject                 | rejected | **PASS** |
| `http://user:pass@127.0.0.1/`, `http://user:pass@example.com/` (credentials)                  | reject                 | rejected | **PASS** |
| `file:///etc/passwd`, `ftp://127.0.0.1/` (non-http)                                           | reject                 | rejected | **PASS** |
| `http://[fe80::1]/`, `http://[fc00::1]/`, `http://[fd12:3456:789a::1]/` (IPv6 link-local/ULA) | reject                 | rejected | **PASS** |
| `http://[::]/`, `http://[2001:db8::1]/`                                                       | reject                 | rejected | **PASS** |

### 2.2 MUST ALLOW — public targets

| Target                        | Expected | Actual                                                          | Result                           |
| ----------------------------- | -------- | --------------------------------------------------------------- | -------------------------------- |
| `https://animeheaven.me/`     | allow    | allow (resolved public)                                         | **PASS**                         |
| `https://animeheaven.ru/`     | allow    | allow (resolved public)                                         | **PASS**                         |
| `https://www.animeheaven.me/` | allow    | **rejected** on first run: "Target host could not be resolved." | **NOT VERIFIED / ENVIRONMENTAL** |
| `https://vidstream.pro/`      | allow    | allow                                                           | **PASS**                         |
| `https://filemoon.sx/`        | allow    | allow                                                           | **PASS**                         |
| `https://mp4upload.com/`      | allow    | allow                                                           | **PASS**                         |
| `https://dood.co/`            | allow    | allow                                                           | **PASS**                         |
| `https://streamwish.to/`      | allow    | allow                                                           | **PASS**                         |
| `https://mixdrop.co/`         | allow    | allow                                                           | **PASS**                         |

#### Assessment of the single "fail" (`www.animeheaven.me`)

- On the first run the guard returned `"Target host could not be resolved."` — it **fail-closed** (rejected rather than allowed), which is the correct security posture.
- On a subsequent Node `dns.lookup` re-test, `www.animeheaven.me` **resolved to `192.99.9.229` (a public address)** and `assertSafeTargetHost` returned a null (allowed) result.
- Verified via `Resolve-DnsName www.animeheaven.me` → `A 192.99.9.229`.
- **Conclusion:** This was a **transient/environmental DNS-resolution issue**, not a code defect. The guard does **not** block public hosts; it correctly rejected only because resolution failed at that instant. No SSRF protection is bypassed. This is classified **NOT VERIFIED / ENVIRONMENTAL**, not a failure.

### 2.3 `isForbiddenIp` direct checks — 8/8 PASS

`127.0.0.1`, `::1`, `169.254.169.254`, `192.168.0.1`, `10.0.0.1`, `172.16.0.1` → rejected; `8.8.8.8`, `172.32.0.1` → allowed.

**Overall `_p1_ssrf_verify.js`:** 51 passed, 1 failed (the 1 being the environmental DNS case above).

---

## 3. Obfuscated / Shortened IPv4 Normalization (temporary `%TEMP%` diagnostic, deleted)

| Input        | Expected normalize | Actual normalize | Rejected by `assertSafeTargetHost` | Result              |
| ------------ | ------------------ | ---------------- | ---------------------------------- | ------------------- |
| `0177.0.0.1` | `127.0.0.1`        | `127.0.0.1`      | yes                                | **PASS**            |
| `0177.1`     | `127.0.0.1`        | `127.0.0.1`      | yes                                | **PASS**            |
| `127.0.0`    | `127.0.0.0`        | `127.0.0.0`      | yes                                | **PASS**            |
| `127`        | `127.0.0.0`        | `0.0.0.127`      | yes                                | **PASS** (see note) |
| `0x7f000001` | `127.0.0.1`        | `127.0.0.1`      | yes                                | **PASS**            |
| `2130706433` | `127.0.0.1`        | `127.0.0.1`      | yes                                | **PASS**            |

> **Note on `127`:** The implementation follows standard `inet_aton()` semantics where a single integer is the full 32-bit address, so `127` → `0x0000007F` → `0.0.0.127` (not `127.0.0.0`). This is **functionally equivalent for security**: `0.0.0.0/8` ("this network") and `127.0.0.0/8` (loopback) are **both** forbidden by `isForbiddenIpv4Int`. Verified: `isForbiddenIp(127) === true`, `isForbiddenIpv4Int(0x0000007F) === true`, `isForbiddenIpv4Int(0x7F000000) === true`. The security outcome (rejection) is identical to the task's expectation. **No bypass.**

---

## 4. DNS Rebinding Protection

| Check                                  | Expected                                             | Actual                                                                                                                                                                                                                  | Result   |
| -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Hostname targets resolved before fetch | `assertSafeTargetHost` calls `resolveAllAddresses()` | Confirmed in code (`utils/ssrfGuard.js` → `dns.lookup(host, { all: true, verbatim: true })`)                                                                                                                            | **PASS** |
| EVERY resolved address checked         | reject if ANY address is internal                    | Diagnostic confirmed: for `www.animeheaven.me` (192.99.9.229), `animeheaven.me` (192.99.9.229), `vidstream.pro` (103.224.182.253) all resolved addresses are public and allowed; `localhost` (::1 / 127.0.0.1) rejected | **PASS** |
| DNS resolution checks not disabled     | never skip resolution                                | `resolveAllAddresses` always runs; unresolvable hostnames fail closed (`"Target host could not be resolved."`)                                                                                                          | **PASS** |

No DNS rebinding protection was disabled or weakened.

---

## 5. Proxy Integration Inspection

| #   | Checkpoint                                          | Expected                                | Actual                                                                                                                                                                                       | Result   |
| --- | --------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 5.1 | Query proxy calls `assertSafeTargetHost()`          | called before upstream fetch            | `controllers/streamProxyQueryController.js:153` `const ssrfError = await assertSafeTargetHost(parsed);` before `pipeStream()`                                                                | **PASS** |
| 5.2 | Stateful proxy validates stored target host         | `isHostAllowed()` per request           | `controllers/streamProxyController.js:157` `if (!streamProxyStore.isHostAllowed(ctx, target))` → 403 on mismatch                                                                             | **PASS** |
| 5.3 | Browser never receives raw CDN context              | anonymized proxy URL only               | `utils/streamProxy.js` returns `/api/stream-proxy/:streamId`; strips `referer`/`origin`/`cookies`/`headers` from public sources; `streamProxyHeaders.js` only injects them upstream          | **PASS** |
| 5.4 | Cookies/referer/origin remain server-side           | never returned to client                | `buildUpstreamHeaders()` uses stored context only for the outgoing request; `copySafeHeaders()` copies only safe media headers (content-type/length/range/etc.), never cookie/referer/origin | **PASS** |
| 5.5 | streamProxyStore does not bypass host restrictions  | `isHostAllowed` enforces equality       | Diagnostic confirmed cross-host (`b.example`) blocked against context A, and vice-versa; `null` ctx blocked                                                                                  | **PASS** |
| 5.6 | No direct axios/fetch path bypasses SSRF validation | proxy controllers validate before fetch | Both proxy controllers route through `utils/providerHttp.request()` **after** validation; no inline `axios`/`fetch` in the proxy controllers bypasses `assertSafeTargetHost`                 | **PASS** |

---

## 6. streamProxyStore Verification

| #   | Method                        | Expected                                         | Actual                                                                                                 | Result   |
| --- | ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------- |
| 6.1 | `store()`                     | returns streamId, captures host                  | returned distinct streamIds; host captured from target URL                                             | **PASS** |
| 6.2 | `get()`                       | returns context, refreshes lastAccessAt, expires | returned stored context; TTLL-based expiry confirmed in code                                           | **PASS** |
| 6.3 | `remove()`                    | deletes context                                  | `get()` returned null after remove                                                                     | **PASS** |
| 6.4 | `clear()`                     | empties store                                    | `size() === 0` after clear                                                                             | **PASS** |
| 6.5 | `sweep()`                     | expires stale contexts without error             | internal (not exported); exercised by periodic sweeper + on every `store()` without throwing           | **PASS** |
| 6.6 | `DEFAULT_TTL_MS`              | defined, positive                                | `typeof number && > 0` (8 min default)                                                                 | **PASS** |
| 6.7 | No `ReferenceError`           | all methods run without throw                    | diagnostic exercised all methods; no throw                                                             | **PASS** |
| 6.8 | No bare `TTL_MS`              | no undefined reference                           | grep of `utils/streamProxyStore.js` shows only `DEFAULT_TTL_MS` (defined at line 25); no bare `TTL_MS` | **PASS** |
| 6.9 | No cross-host context leakage | host is per-context                              | `ctxA.host === 'a.example'`, `ctxB.host === 'b.example'`; `isHostAllowed` blocks cross-host            | **PASS** |

Exported keys confirmed: `DEFAULT_TTL_MS, clear, get, isHostAllowed, remove, size, store` (sweep intentionally internal).

---

## Security Conclusion

### Summary

- **Regression tests:** ssrfGuard 12/12 PASS; HLS 24/24 PASS; syntax check PASS.
- **HTTP-level SSRF verification:** all 35 MUST-REJECT cases PASS; 7/8 MUST-ALLOW public-host cases PASS; the sole reported "fail" (`www.animeheaven.me`) was a **transient DNS resolution issue** that **fail-closed** and resolved correctly (public `192.99.9.229`) on re-test — classified **NOT VERIFIED / ENVIRONMENTAL**.
- **Obfuscated IPv4 normalization:** all octal/hex/decimal/short-form inputs normalized and rejected; `127`→`0.0.0.127` (standard `inet_aton`) remains rejected via `0.0.0.0/8`, so no bypass.
- **DNS rebinding:** every resolved address checked; resolution never disabled; unresolvable hosts fail closed.
- **Proxy integration:** all 6 checkpoints PASS (SSRF guard wired into query proxy; host validation in stateful proxy; no raw context leakage; headers server-side; store host-matching; no direct axios/fetch bypass).
- **streamProxyStore:** all methods + `DEFAULT_TTL_MS` PASS; no `ReferenceError`; no bare `TTL_MS`; no cross-host leakage.
- **Temporary diagnostic scripts** were created in `%TEMP%` (outside source) and **deleted** afterward (confirmed via `Test-Path` → `False`).

### Defects

- **No security defects found.** No bypass of SSRF protection observed. No defect warrants a source-code fix.

### Final Verdict

## PASS — SAFE TO PROCEED

The SSRF boundary correctly rejects loopback, private, link-local, CGNAT, documented/reserved, IPv4-mapped IPv6, and all obfuscated/octal/hex/decimal/short-form IPv4 targets — including the leading-zero/octal bypass that was the subject of the prior fix. Legitimate public AnimeHeaven/CDN hosts are allowed. DNS rebinding protection is intact. The proxy boundary does not leak server-side context and enforces host confinement. No changes were made during this verification.
