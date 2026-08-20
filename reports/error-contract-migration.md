# Error Contract Migration — AniStrimBackend2

**Date:** 2026-08-20  
**Status:** Infrastructure in place; migration in progress  
**Scope:** Centralized API error format for independent Web, Mobile, Desktop, and Admin clients

---

## OLD Error Format (before)

Controllers returned **inconsistent** shapes:

| Format                                         | Example                                        | Used By          |
| ---------------------------------------------- | ---------------------------------------------- | ---------------- |
| `{ message: "..." }`                           | `{ message: 'Anime not found.' }`              | Most controllers |
| `{ error: "..." }`                             | `{ error: 'Invalid ID' }`                      | Some endpoints   |
| `{ success:false, error: "..." }`              | Stream failures                                | streamController |
| `{ code: "...", message: "..." }`              | `{ code: 'PREMIUM_REQUIRED', message: '...' }` | Auth, session    |
| `{ code, requiredTier, availableAt, message }` | Premium gate                                   | episodeAccess    |

**Problems:**

- No machine-readable code on many endpoints
- No `requestId` anywhere
- No consistent `success:false` marker
- Some 500s leaked internal messages/stack traces

---

## NEW Error Format (after)

Every error now uses a single contract:

```json
{
  "success": false,
  "error": {
    "code": "EPISODE_NOT_FOUND",
    "message": "Episode not found.",
    "details": {},
    "requestId": "req_abc123"
  }
}
```

### HTTP Status Code Mapping

| Status | Default Code          |
| ------ | --------------------- |
| 400    | `BAD_REQUEST`         |
| 401    | `UNAUTHORIZED`        |
| 403    | `FORBIDDEN`           |
| 404    | `NOT_FOUND`           |
| 409    | `CONFLICT`            |
| 422    | `VALIDATION_ERROR`    |
| 429    | `RATE_LIMITED`        |
| 500    | `INTERNAL_ERROR`      |
| 502    | `BAD_GATEWAY`         |
| 503    | `SERVICE_UNAVAILABLE` |
| 504    | `GATEWAY_TIMEOUT`     |

### New Files

| File                         | Purpose                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `utils/apiError.js`          | `ApiError` class + factory helpers + `buildErrorBody()`               |
| `middleware/requestId.js`    | Assigns `req.requestId`, echoes `X-Request-Id` header                 |
| `middleware/errorHandler.js` | Catches thrown errors → centralized format; never leaks stack in prod |

### server.js Integration

- `requestId` mounted after CORS (every request gets a request ID).
- `errorHandler` mounted after all API routes, before SPA fallback.

---

## Routes MIGRATED

### 1. `/api/anime/genres` (GET) — `controllers/animeController.js`

- **Old:** `res.status(500).json({ message: 'Failed to fetch genres.' })`
- **New:** `next(internal('ANIME_GENRES_FETCH_FAILED', 'Failed to fetch genres.'))` → standardized 500 envelope with machine-readable code.

### 2. All protected routes via `protect` middleware — `middleware/auth.js`

Covers **every** auth-gated route (`/api/auth/me`, `/api/auth/logout`, `/api/watchlist/*`, `/api/watch/*`, `/api/stream/authorize`, `/api/admin/*`, etc.).

- **Old:** `res.status(401).json({ message: 'Not authenticated.' })` or `{ code, message }`
- **New:** `res.status(401).json({ success:false, error: { code, message, details, requestId } })`
- **Preserved codes:** `ACCOUNT_SUSPENDED`, `ACCOUNT_DEACTIVATED`, `ACCOUNT_DELETED`, `ACCOUNT_NOT_ACTIVE`, `TOKEN_VERSION_MISMATCH`, `SESSION_REVOKED`, `UNAUTHORIZED`.
- All auth failures now carry `requestId`.

---

## Routes INTENTIONALLY LEFT UNCHANGED

These routes keep their existing response shape (success/error) to avoid breaking current clients. They are documented as **future work** for the full migration.

| Route Group                                           | Reason Left Unchanged                                                                                                     | Future Action                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/api/anime/*` (except genres)                        | Existing success responses are raw arrays/objects; frontend relies on them. Error responses still `{ message }`.          | Migrate error paths to `ApiError` in a follow-up, keeping success shapes. |
| `/api/auth/*` (login, signup, refresh, etc.)          | Auth success contracts (`{ token, refreshToken, user }`) are core; error paths partially already use `{ code, message }`. | Migrate error handling to centralized format incrementally.               |
| `/api/stream/*`                                       | Streaming is security-sensitive; must NOT break playback. Errors still use `{ success:false, error }`.                    | Keep as-is unless required; do not risk playback.                         |
| `/api/stream-proxy/*`                                 | Media proxy is token-critical.                                                                                            | Keep as-is.                                                               |
| `/api/payments/*`                                     | Payment flow returns HTML for callbacks (separate task).                                                                  | Separate task.                                                            |
| `/api/admin/*`                                        | Admin dashboard depends on current shapes.                                                                                | Migrate error paths in a follow-up.                                       |
| `/api/payments/webhook`, `/api/payments/ipn-listener` | Webhooks need plain 200s; cannot break.                                                                                   | Keep as-is.                                                               |

---

## Compatibility Considerations

### BROKEN (intentional behavior change)

- **All auth failures** now return `{ success:false, error: {...} }` instead of `{ message }` / `{ code, message }` at the top level.
  - Frontend `Frontend/js/api.js` currently reads `data.message` on 401/403 for display. After this change, `data.message` is now `data.error.message`.
  - **ACTION REQUIRED:** Update `Frontend/js/api.js` (and any client) to read `data.error?.message` for auth errors.
  - The machine-readable `code` moved from `data.code` to `data.error.code`.

This is the intended contract stabilization, but it requires frontend adjustment.

### PRESERVED

- HTTP status codes (401/403/etc.) unchanged.
- Machine-readable auth codes (`ACCOUNT_*`, `TOKEN_VERSION_MISMATCH`, `SESSION_REVOKED`) preserved inside `error.code`.
- Stream, payment, admin success responses unchanged.

---

## Migration Strategy for Remaining Controllers

For each remaining controller, in priority order:

1. Replace `res.status(NNN).json({ message: '...' })` with `next(ApiError)` using the appropriate factory (`badRequest`, `notFound`, `internal`, etc.)
2. Keep success responses unchanged.
3. Update frontend to read `data.error?.message` for error handling.
4. Re-run regression tests.

Priority order:

1. `/api/anime/*` (browse/search/detail) — highest client usage
2. `/api/watch/*` — progress/resume
3. `/api/profile/*` — user profile/preferences
4. `/api/admin/*` — admin dashboard
5. `/api/payments/*` — payment (after separating HTML concern)

---

## Files New/Modified (This Task)

| File                             | Action                                               |
| -------------------------------- | ---------------------------------------------------- |
| `utils/apiError.js`              | NEW                                                  |
| `middleware/requestId.js`        | NEW                                                  |
| `middleware/errorHandler.js`     | NEW                                                  |
| `server.js`                      | MODIFIED (mount requestId + errorHandler)            |
| `middleware/auth.js`             | MODIFIED (protect now uses centralized error format) |
| `controllers/animeController.js` | MODIFIED (getGenres migrated)                        |
| `test/errorContract.test.js`     | NEW (10 tests)                                       |

---

## Testing

Run:

```
node --test test/errorContract.test.js    # 10 tests
node --test test/cors.test.js             # 17 tests
```

Full suite: existing tests plus the new ones. The only failures are pre-existing (migration-runner assertions + MySQL connection), unrelated to this change.
