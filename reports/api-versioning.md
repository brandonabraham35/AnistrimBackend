# API Versioning & Migration Strategy

## 1. Overview

AniStrimBackend2 now exposes a **stable, versioned API** at `/api/v1/*` as the contractual surface that all clients (Web, Mobile, Desktop, Admin) should target going forward. The existing, unversioned `/api/*` surface remains **fully functional** and is treated as the **legacy contract** during the migration window.

This document describes: what belongs to v1 (stable), what remains legacy, the migration strategy, the deprecation policy, and the expected lifetime of legacy `/api/*`.

## 2. Design: version adapter (no duplication)

The v1 surface is implemented as a **centralized version router**: `routes/v1/index.js`. It **re-mounts the exact same router/controller objects** that the legacy `/api/*` surface already uses. There is **no controller duplication** and **no business-logic change**. Because every child route file declares **relative** paths (e.g. `/login` inside `routes/authRoutes.js`), mounting the same router at both `/api/auth` and `/api/v1/auth` yields identical behavior at both URLs.

The legacy `/api/*` mounts in `server.js` are **untouched**. Only a single line was added: `app.use('/api/v1', require('./routes/v1'));`

## 2.1 Mounting map

| v1 surface             | Legacy counterpart  | Router modules reused           |
| ---------------------- | ------------------- | ------------------------------- |
| `/api/v1/auth`         | `/api/auth`         | `authRoutes`, `avatarRoutes`    |
| `/api/v1/profile`      | `/api/profile`      | `profileRoutes`                 |
| `/api/v1/anime`        | `/api/anime`        | `animeRoutes`                   |
| `/api/v1/watchlist`    | `/api/watchlist`    | `watchlistRoutes`               |
| `/api/v1/payments`     | `/api/payments`     | `paymentRoutes`                 |
| `/api/v1/watch`        | `/api/watch`        | `watchRoutes`                   |
| `/api/v1/download`     | `/api/download`     | `downloadRoutes`                |
| `/api/v1/stream`       | `/api/stream`       | `streamRoutes`                  |
| `/api/v1/stream-proxy` | `/api/stream-proxy` | `streamProxyRoutes`             |
| `/api/v1/admin`        | `/api/admin`        | `adminRoutes`                   |
| `/api/v1/admin/upload` | `/api/admin/upload` | `uploadRoutes`                  |
| `/api/v1/ads`          | `/api/ads`          | `adsRoutes`                     |
| `/api/v1/reports`      | `/api/reports`      | `reportRoutes`                  |
| `/api/v1/home`         | `/api/home`         | `homeShelfRoutes`               |
| `/api/v1/version`      | (new)               | version probe (stable contract) |

The mapping duplicates **zero** controller logic: `GET /api/v1/anime/:id` and `GET /api/anime/:id` invoke the _same_ `animeController.getById` function.

## 3. What belongs to v1

- **Auth & accounts** – `/api/v1/auth/*` (login, signup, OTP, sessions, password reset, Google flows, avatar).
- **Profiles** – `/api/v1/profile/*`.
- **Catalogue & anime** – `/api/v1/anime/*` (details, episodes, browse, search).
- **Watchlist** – `/api/v1/watchlist/*`.
- **Payments / subscriptions** – `/api/v1/payments/*`.
- **Watch history / progress** – `/api/v1/watch/*`.
- **Offline downloads** – `/api/v1/download/*`.
- **Streaming (secure)** – `/api/v1/stream/*` and `/api/v1/stream-proxy/*`.
- **Admin & CMS** – `/api/v1/admin/*` and `/api/v1/admin/upload/*`.
- **Ads** – `/api/v1/ads/*`.
- **Reports** – `/api/v1/reports/*`.
- **Home shelf (discovery)** – `/api/v1/home/*`.

A stable version probe is available: `GET /api/v1/version` returns `{ api: 'anistrim', version: 'v1', status: 'stable' }`.

## 4. What remains legacy

The following are **NOT** part of v1 and remain legacy/internal:

- `/consumet-api/*` – internal Consumet microservice proxy (not a public contract).
- `/api/health` and `/health/provider` – infrastructure/liveness endpoints.
- `/api/payments/webhook` – legacy Pesapal IPN webhook (kept for contract continuity).
- Internal helper routes not part of the stable resource surface (upload is exposed in v1 for CMS completeness but remains gated by `protect + adminOnly`).
- Static frontend / admin dashboard serving.

## 5. Migration strategy

1. **Introduce the v1 boundary first (this change).** A single `routes/v1/index.js` re-exposes the existing handlers at `/api/v1/*`. The legacy `/api/*` surface is left running untouched. No business logic, streaming-provider logic, or controller code is modified.
2. **Update clients to target `/api/v1/*`.** Each client (Web, Mobile, Desktop, Admin) changes its API base URL from `/api` to `/api/v1`. Because v1 uses identical handlers, responses are byte-for-byte identical to the legacy routes they replace — no client-side parsing changes are required during this step.
3. **Add versioned-contract tests.** `test/apiVersioning.test.js` proves parity between `/api/*` and `/api/v1/*` for auth, stream, stream-proxy, and anime routes.
4. **Freeze legacy `/api/*`.** New feature work targets `/api/v1/*` only. Legacy routes receive bug fixes only, never new fields or breaking changes.
5. **Retire legacy once all clients are migrated** (see §7).

## 6. Deprecation policy

- **v1 (stable)** – The current contractual surface. Breaking changes to v1 require a new major version (e.g. `/api/v2/*`) and follow a deprecation window.
- **Legacy `/api/*`** – Receives the deprecated designation immediately. It must continue to function identically, not gain new features, and log a deprecation notice only for observability (no user-facing change during migration).
- **Breaking change rule** – Any change that alters request/response shape, status codes, or auth semantics is breaking and must be introduced as a new version, never in-place on v1 or legacy.

## 7. Expected lifetime of legacy `/api/*`

| Phase           | Lifetime                             | Condition                                                                                                                                       |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Migration**   | Active (now)                         | Clients still on `/api/*`. Both surfaces serve identical behavior.                                                                              |
| **Coexistence** | ~3–6 months after clients move to v1 | Legacy remains read-only (bug fixes only).                                                                                                      |
| **Removal**     | After the coexistence window         | Legacy is removed only after all active clients (Web, Mobile, Desktop, Admin) have migrated to `/api/v1/*` for at least one full release cycle. |

The legacy surface will **not** be removed until traffic on `/api/*` drops to near-zero for a sustained period and removal is scheduled as a deliberate, communicated breaking change.

## 8. Streaming compatibility

The secure streaming system is unchanged and operates identically under both surfaces:

- `/api/v1/stream/authorize` → same handler, same 120s HMAC token, same `protect` enforcement as `/api/stream/authorize`.
- `/api/v1/stream/:animeTitle/:episodeNumber` → same resolution logic as legacy.
- `/api/v1/stream/providers/:animeTitle/:episodeNumber` → same provider listing.
- `/api/v1/stream/offline-download` → same premium-gated download authorization.
- `/api/v1/stream-proxy/:streamId` (+ suffix) → same token-gated, server-side-injected-context proxy. The browser still only sees anonymized proxy URLs; cookies/referers/origins/target URLs stay server-side in `streamProxyStore`. SSRF guard, HLS rewriting, and rate limiting are all preserved.

## 9. Tests

Automated parity tests are in `test/apiVersioning.test.js`:

```
node --test test/apiVersioning.test.js
```

It verifies:

1. The v1 version probe returns the stable contract.
2. `/api/auth/google/client-id` and `/api/v1/auth/google/client-id` behave identically.
3. `/api/stream/authorize` and `/api/v1/stream/authorize` both enforce auth (401 without token).
4. `/api/stream-proxy/:id` and `/api/v1/stream-proxy/:id` both enforce the secure proxy (401 without token).
5. `/api/anime/:id` and `/api/v1/anime/:id` behave identically.

Note: tests 3–5 don't require a reachable DB for the chosen assertions (auth/proxy enforcement + route-parity status); some legacy handlers may attempt a DB query on non-short-circuit paths, but the parity assertion still holds because both surfaces route through the same handler.

## 10. Summary

- `/api/v1/*` is the **stable contract**.
- `/api/*` is the **legacy contract**, preserved during migration.
- The version adapter (`routes/v1/index.js`) reuses existing handlers — **no duplication**, **no logic changes**, **no streaming-provider changes**.
- A documented **deprecation policy** and **lifecycle** governs the eventual removal of legacy `/api/*`.
- Parity is **automatically tested**.
