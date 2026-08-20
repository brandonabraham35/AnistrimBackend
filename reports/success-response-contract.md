# Success Response Contract — AniStrimBackend2

**Date:** 2026-08-20  
**Status:** Standardized across Web / Mobile / Desktop / Admin clients  
**Scope:** Consistent success envelope for every API endpoint so independent clients can consume it predictably.

---

## Standard Envelope

Every successful API response uses the same wrapper:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

- `data` — the resource(s) (single object, array, or primitive).
- `meta` — optional non-pagination metadata (e.g. `{ message, emailSent }`).

For **list endpoints** the `meta` contains a `pagination` block:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "pagination": {
      "page": 1,
      "perPage": 20,
      "totalItems": 408,
      "totalPages": 21,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

## Reusable Helpers — `utils/response.js`

Controllers **must** use these instead of hand-building `res.json()` bodies:

- `sendSuccess(res, data, meta?, status?)` — single resource / action confirmation.
- `sendAuth(res, { token, refreshToken, sessionId, user }, meta?, status?)` — authentication responses.
- `sendPaginated(res, dataArray, { page, perPage, totalItems }, meta?)` — paginated lists.
- `buildPaginationMeta(page, perPage, totalItems)` — build the pagination block.

Errors use the independent contract from `utils/apiError.js`:
`{ success:false, error: { code, message, details, requestId } }`.

---

## Examples by Domain

### 1. Auth — `POST /api/auth/login`

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "a3f2...",
    "sessionId": "sid_abc123",
    "user": {
      "id": 42,
      "name": "Ada",
      "email": "ada@example.com",
      "isAdmin": false,
      "isPremium": true,
      "entitlement": { "isPremium": true }
    }
  }
}
```

### 2. Anime — `GET /api/anime/trending`

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Attack on Anime",
      "cover_image": "https://.../cover.jpg",
      "rating": 8.7,
      "year": 2024,
      "genres": ["Action", "Drama"]
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "perPage": 10,
      "totalItems": 408,
      "totalPages": 41,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 3. Episode — `GET /api/anime/:animeId/episodes`

```json
{
  "success": true,
  "data": [
    {
      "id": 101,
      "number": 1,
      "title": "Pilot",
      "thumbnail_url": "https://.../thumb.jpg",
      "duration_sec": 1440,
      "locked": false,
      "effectiveTier": "free",
      "accessState": "available"
    }
  ]
}
```

### 4. Watch Progress — `GET /api/watch/progress/:episodeId`

```json
{
  "success": true,
  "data": {
    "positionSec": 720,
    "durationSec": 1440,
    "percent": 50,
    "completed": false,
    "updatedAt": "2026-08-20T12:00:00.000Z"
  }
}
```

### 5. Watchlist — `GET /api/watchlist`

```json
{
  "success": true,
  "data": [
    {
      "id": 9,
      "animeId": 3,
      "title": "Code Geass",
      "poster": "https://.../cg.jpg",
      "status": "WATCHING",
      "episodesWatched": 12,
      "totalEpisodes": 25
    }
  ]
}
```

### 6. Stream Authorization — `POST /api/stream/authorize`

The stream proxy contract is **preserved**: `token` / `streamId` / `streams` are returned at the top level of `data`, and `streams[].url` carries the signed `/api/stream-proxy/:streamId?token=...` URL.

```json
{
  "success": true,
  "data": {
    "token": "hmac120s...",
    "streamId": "ep-101-192-168-1-10-0",
    "streams": [
      {
        "streamId": "ep-101-192-168-1-10-0",
        "token": "hmac120s...",
        "url": "https://api.example.com/api/stream-proxy/ep-101-192-168-1-10-0/index.m3u8?token=hmac120s...",
        "expiresIn": 120
      }
    ],
    "expiresIn": 120
  }
}
```

> **Do NOT break the stream proxy contract.** `/api/stream-proxy/:streamId` remains the binary/media proxy. JSON stream API responses (`getStream`, `authorizeStream`, provider list, and download authorization) are enveloped, with legacy fields preserved under `data`.

### 7. Admin — `GET /api/admin/anime` (paginated)

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Naruto",
      "genres": ["Action", "Adventure"],
      "is_premium": false,
      "episode_count": 220
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "perPage": 15,
      "totalItems": 120,
      "totalPages": 8,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 8. Pagination — Generic example (`GET /api/watch/history`)

```json
{
  "success": true,
  "data": [
    {
      "episodeId": 101,
      "animeId": 3,
      "animeTitle": "Code Geass",
      "positionSec": 720,
      "durationSec": 1440,
      "completed": false,
      "updatedAt": "2026-08-20T12:00:00.000Z"
    }
  ],
  "meta": {
    "pagination": {
      "page": 2,
      "perPage": 20,
      "totalItems": 45,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": true
    }
  }
}
```

---

## Client Compatibility

### Frontend (`Frontend/js/api.js`)

The canonical `apiFetch` already unwraps the envelope via `unwrapEnvelope` so existing pages reading `result.data.<field>` keep working:

- `{ success, data:{...} }` → `result.data` = inner object, with `meta` merged in.
- `{ success, data:[...], meta.pagination }` → exposes `result.data.items` / `result.data.rows` / `result.data.pagination`.

### Admin Dashboard (`AdminDashboard/js/api.js`)

A matching `unwrapAdminEnvelope` shim unwraps the body before it is returned to admin pages, so `response.data`, `response.pagination`, `response.overview`, etc. keep working unchanged.

### Auth flows (login.js, signup.js, google-auth-handler.js, AdminDashboard/js/auth.js)

Auth responses return `{ token, refreshToken, sessionId, user }` **under `data`**; all clients unwrap it so `data.token` / `data.user` still resolve.

### Stream proxy

`/api/stream/authorize` and `getStream` now return the standard success envelope, while preserving their legacy fields under `data`. `/api/stream-proxy/:streamId` remains the media proxy and is not wrapped.

---

## Endpoints Migrated

| Priority | Routes                  | Status                                                         |
| -------- | ----------------------- | -------------------------------------------------------------- |
| 1        | `/api/auth/*`           | ✅ enveloped (sendAuth/sendSuccess)                            |
| 2        | `/api/profile/*`        | ✅ enveloped (sendSuccess)                                     |
| 3        | `/api/anime/*`          | ✅ enveloped (sendSuccess/sendPaginated)                       |
| 4        | `/api/watch/*`          | ✅ enveloped (sendSuccess/sendPaginated)                       |
| 5        | `/api/watchlist/*`      | ✅ enveloped + legacy aliases unwrap                           |
| 6        | `/api/stream/*`         | ✅ enveloped; **stream proxy contract preserved**              |
| 7        | `/api/payments/*` (API) | ✅ enveloped; callback HTML left as-is                         |
| 8        | `/api/home/*`           | ✅ enveloped (sendSuccess)                                     |
| 9        | `/api/reports/*`        | ✅ enveloped (sendSuccess)                                     |
| 10       | `/api/download/*`       | unchanged (binary file proxy)                                  |
| 11       | `/api/admin/*`          | ✅ enveloped (sendSuccess/sendPaginated) + admin shim          |

---

## Testing

```
node --test test/successContract.test.js   # envelope + pagination + shim tests
node --test test/successRouteContract.test.js # migrated-route success guard
node --test test/errorContract.test.js     # error contract
node --test                                # full suite
```
