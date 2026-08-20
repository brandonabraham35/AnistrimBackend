# Presentation-Decoupling Report

**Task:** Decouple AniStrimBackend2 from presentation-specific frontend logic so the API is client-agnostic and works for Web, Android, iOS, Desktop, and Admin.

**Date:** 2026-08-20

---

## 1. Summary

The API no longer generates application UI pages or hardcodes frontend page names for the audited flows. It now returns structured, machine-readable results and lets the consuming client decide what to display and how to navigate. Static frontend serving remains available for local development but is now configurable so the API and frontend(s) can be deployed independently.

## 2. Problems Addressed (from the API boundary report)

| #   | Problem                                                          | Status                    |
| --- | ---------------------------------------------------------------- | ------------------------- |
| 1   | `paymentController.js` returns HTML                              | ✅ Decoupled              |
| 2   | `googleAuthController.js` returns HTML                           | ✅ Decoupled (optionally) |
| 3   | `watchController.js` returns `resumeUrl` containing `watch.html` | ✅ Decoupled              |
| 4   | `authController.js` constructs `reset-password.html?token=...`   | ✅ Decoupled              |
| 5   | `server.js` serves `Frontend/`                                   | ✅ Configurable           |
| 6   | `server.js` serves `AdminDashboard/`                             | ✅ Configurable           |

## 3. Implementation Details

### 3.1 Payment callback (`controllers/paymentController.js`)

- `GET /api/payments/callback` now returns a **structured JSON payload** that lets the client decide what to display:
  ```json
  {
    "success": true,
    "status": "completed",
    "state": "active",
    "txRef": "ANISTRIM-...",
    "message": "Payment completed successfully."
  }
  ```
- **No payment secrets are exposed** — only status/state/txRef and a human-friendly message.
- The legacy HTML bridge page is still served **only when the client explicitly opts in** via `?render=html` (used by the existing `/payment-callback.html` bridge). Calling without that query returns JSON.
- Status is normalized to stable lowercase machine-readable values (`completed|pending|failed|refunded|cancelled|unknown`).

### 3.2 Google OAuth (`controllers/googleAuthController.js`)

- Added a **client-independent OAuth result/deep-link strategy**:
  - Calling the callback with `?client=api` returns a structured JSON result:
    ```json
    {
      "code": "<short-lived login code>",
      "user": { ...canonical DTO... },
      "intent": "login",
      "deepLink": "anistrim://auth?code=...&intent=login",
      "token": "..."
    }
    ```
  - The suggested deep link is configurable via `GOOGLE_AUTH_DEEP_LINK`.
- **Existing mobile OAuth flow is NOT broken:** calling the callback without `?client=api` still returns the legacy HTML deep-link bridge page (unchanged).
- Error responses are also machine-readable in `?client=api` mode (stable `code` values), otherwise the legacy HTML error page is returned.

### 3.3 Watch resume data (`controllers/watchController.js`)

- Removed `resumeUrl: "watch.html?id=..."` from the `/api/watch/continue-watching` response.
- The response now returns **machine-readable identifiers** only, e.g.:
  ```json
  {
    "animeId": 123,
    "episodeId": 456,
    "seasonNumber": 1,
    "episodeNumber": 3,
    "positionSec": 340,
    "durationSec": 1420,
    "percent": 24,
    "state": "resume"
  }
  ```
- The **client decides how to navigate** (the web frontend already builds its own `watch.html?id=...&ep=...` URL from these identifiers).

### 3.4 Password reset (`controllers/authController.js`)

- Removed the hardcoded `reset-password.html` page name.
- The reset destination is now **configurable**:
  - Env: `PASSWORD_RESET_PATH` (e.g. `reset-password.html`).
  - Per-request: `?resetPath=` on `/forgot-password`.
- The backend returns a **machine-readable reset token/result**:
  - `resetToken` / `token` — the JWT the client uses to call `/reset-password`.
  - `resetUrl` — built ONLY when a `PASSWORD_RESET_PATH`/`resetPath` is configured (optional).
  - `resetPathRequired: true` — signals the client must build its own URL when no path is configured.
- The client decides which screen/page handles the reset.

### 3.5 Static frontend serving (`server.js`)

- Static serving of `Frontend/` and `AdminDashboard/` is now gated behind `SERVE_STATIC_FRONTEND` (default `true` to preserve local dev).
- When `SERVE_STATIC_FRONTEND=false`, the API runs in **API-only mode**: no static assets, no SPA fallbacks; unmatched `/api/*` still returns JSON 404. This lets the API and frontend(s) be deployed independently.
- The directories are configurable via `FRONTEND_DIR` and `ADMIN_DIR` for dev convenience.
- Local development behavior is unchanged by default.

## 4. New Configuration (`.env.example`)

```env
# Presentation-decoupling (client-agnostic API):
PASSWORD_RESET_PATH=
GOOGLE_AUTH_DEEP_LINK=
SERVE_STATIC_FRONTEND=true
FRONTEND_DIR=Frontend
ADMIN_DIR=AdminDashboard
```

New config module: `config/clientAgnostic.js`.

## 5. Non-Regression Checks

- **Streaming behavior:** unmodified — stream proxy URLs, streaming service, and playback paths untouched.
- **Authentication security:** unmodified — auth middleware, session creation, token rotation, OTP flows untouched.
- **Payment callbacks:** IPN listener, refund/cancel, verify-subscription unchanged; callback now JSON-first with opt-in HTML bridge.
- **Google authentication:** identity service and intent rules unchanged; legacy HTML flow preserved.

## 6. Tests

- **Syntax:** all modified files pass `node --check`.
- **`test/phase3.test.js`:** 16/17 pass. The updated FIX 5 test confirms resume data is now machine-readable (no `watch.html` URL in controller). The single failing test (FIX 9, schema.sql ranking in `migrate.js`) is **pre-existing and unrelated** to this change.
- **`test/integration.test.js`:** could not run because the configured DB user is rejected ("Access denied for user 'anistrim_requirebut'"). This is a pre-existing local environment/DB-credential issue, not caused by these changes.

## 7. Migration Mechanism (API + Frontend independent deployment)

1. Keep `SERVE_STATIC_FRONTEND=true` during transition so the current monolith behavior is preserved.
2. Move the web frontend out of the repo (e.g. to a CDN / separate host) and point `FRONTEND_URL` at it.
3. Configure `PASSWORD_RESET_PATH` to the hosted reset page, or let clients build their own URL from `resetToken`.
4. Set `GOOGLE_AUTH_DEEP_LINK` to the client's preferred deep link.
5. Set `SERVE_STATIC_FRONTEND=false` in the API deployment to enable API-only mode.
