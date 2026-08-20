# Deployment Boundary: Independent Backend / Frontend Deployment

## 1. Goal

Prepare AniStrimBackend2 to be deployed **independently** from its frontend clients:

| Surface | Domain                          |
| ------- | ------------------------------- |
| Backend | `https://api.anistrim.com`      |
| Web     | `https://anistrim.com`          |
| Admin   | `https://admin.anistrim.com`    |
| Mobile  | Native / Capacitor client       |
| Desktop | Independent desktop application |

The backend is a **pure API / service**. `Frontend/` and `AdminDashboard/` are **kept in the repo** (they are not deleted) but static serving of them is **optional and env-configured**.

## 2. What static serving resources does `server.js` serve?

The backend's `server.js` mounted static assets for:

1. **`Frontend/`** — the Web SPA (served at `/`, with an SPA fallback to `index.html`).
2. **`AdminDashboard/`** — the admin SPA (served under `/admin`, with a fallback to `dashboard.html`).
3. **`uploads/`** — user/avatar/CMS media uploads (API-adjacent user content).

Previously all three were gated together by one flag (`SERVE_STATIC_FRONTEND`). This tightly coupled the API deployment to the presence of both frontend directories.

## 3. Configuration (new)

Added in `config/clientAgnostic.js` and used by `server.js`:

```
SERVE_STATIC_FRONTEND=false   # legacy all-or-nothing: disables both Web + Admin
SERVE_FRONTEND=false          # disables serving Frontend/ only
SERVE_ADMIN=false             # disables serving AdminDashboard/ only
```

- `SERVE_FRONTEND` and `SERVE_ADMIN` **default to `SERVE_STATIC_FRONTEND`**.
- If `SERVE_STATIC_FRONTEND` is unset, it defaults to `true` → **local development keeps serving both** exactly as before.
- `uploads/` is always served (it's API-adjacent user content, not a frontend client).

### Recommended production values

For the **pure API-only backend** at `api.anistrim.com`:

```
SERVE_STATIC_FRONTEND=false
# (or explicitly) SERVE_FRONTEND=false, SERVE_ADMIN=false
```

Web and Admin are served by their own deployments on their own domains; the API never depends on either directory.

## 4. How `server.js` now handles static serving

- `express.static(frontendDir)` is mounted **only if `SERVE_FRONTEND`**.
- `express.static(adminDir)` under `/admin` is mounted **only if `SERVE_ADMIN`**.
- `uploads/` is mounted always.
- The `/api` 404 guard is mounted **always** (unknown `/api/*` returns JSON regardless of static config).
- SPA fallback routes (`/admin/*` → `dashboard.html`, `/*` → `index.html`) are mounted **only when the corresponding component is served**.
- New startup log lines announce the effective mode (API-only vs which components are served).

## 5. Verification

A temporary API-only verification (with `SERVE_STATIC_FRONTEND=false`) confirmed:

- `config` exposes `SERVE_FRONTEND=false` and `SERVE_ADMIN=false`.
- `GET /api/health` → **200 `{ status: 'OK' }`** (no frontend assets required).
- `GET /api/v1/version` → **200** (API routes all still mounted).
- Unknown `GET /api/*` → **404 JSON** (proves the `/api` guard works and there is no SPA fallback swallowing it).
- No controller or service reads a `Frontend/`/`AdminDashboard/` file at runtime (the only `sendFile`/path references are the now-gated `server.js` static block and dev-only test assertions).

The verified script was removed after passing.

## 6. Development support (unchanged)

- Default config (no env vars) → `SERVE_FRONTEND=true`, `SERVE_ADMIN=true` → the monolith behavior: `http://localhost:5000` serves the Web SPA, `/admin` serves the dashboard, and the API.
- `npm start` and all existing dev flows work exactly as before.

## 7. Independent deployment model

```
api.anistrim.com    -> backend (SERVE_STATIC_FRONTEND=false)   <- pure API/service
anistrim.com        -> Web frontend (built from Frontend/)     <- hits https://api.anistrim.com
admin.anistrim.com  -> Admin frontend (built from AdminDashboard/) <- hits https://api.anistrim.com
Mobile/Desktop      -> native clients                          <- hit https://api.anistrim.com
```

Each client already resolves the backend URL independently (`Frontend/config.js`, `AdminDashboard/js/backend-url.js`) so pointing them at `https://api.anistrim.com` is a config change only.

## 8. What did NOT change

- `Frontend/` and `AdminDashboard/` are **not deleted** — they remain for local dev and as the source for the independent Web/Admin deployments.
- No API route, controller, or service logic was modified.
- Streaming logic (`/api/v1/stream*`, `/api/v1/stream-proxy*`) untouched.
- `GET /api/health` and all API routes still work in API-only mode.

## 9. Summary

- Static serving of Web + Admin is now **optional** via `SERVE_FRONTEND` / `SERVE_ADMIN` (defaulting to the legacy `SERVE_STATIC_FRONTEND`).
- Local development is unchanged (both served by default).
- The backend can run as a **pure API** with `SERVE_STATIC_FRONTEND=false` — verified `/api/health` works with no frontend assets and the `/api` 404 guard returns JSON.
- `uploads/` remains served as API-adjacent content.
