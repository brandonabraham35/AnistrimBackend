# AniStrim Web Production Readiness Report

Audit date: 2026-08-21

Deployment audited:

- Web: `https://anistrim-one.vercel.app`
- API: `https://anistrimbackend.onrender.com`

## Verified production checks

- `GET /` on Vercel returned `200` and the deployed HTML contains the API meta value `https://anistrimbackend.onrender.com`.
- Deployed `css/styles.css`, `js/config.js`, `js/ui.js`, `js/vendor/hls.min.js`, and the scoped session module are available at Vercel-root-relative paths.
- The Vercel app uses hash routing. `#/anime/:id`, `#/search`, and other hash routes reload through `GET /`; a non-hash unknown path returns Vercel `404`, which is expected for this routing architecture.
- Render accepted an `OPTIONS` preflight from `https://anistrim-one.vercel.app` with `Authorization` and `X-Client`, returning the exact `Access-Control-Allow-Origin` value and the required methods/headers.
- A real cross-origin `GET /api/anime/trending?page=1&perPage=1` returned `200` with the exact Vercel origin in `Access-Control-Allow-Origin`.
- The deployed API client uses the Render API base and unconditionally sends `X-Client: web`.

## Critical blockers

No confirmed public-path or CORS blocker was found.

The application is **not certified production-ready** because authenticated and provider-mediated flows could not be exercised in this environment:

- login/refresh/logout;
- signup and OTP email delivery;
- password-reset email delivery and link handling;
- Google OAuth round trip;
- Pesapal checkout, IPN, return, and verified entitlement activation;
- authenticated stream authorization and playback.

## High-priority configuration gates

The following Render values cannot be read from a public endpoint and must be confirmed before release:

```env
API_ALLOWED_ORIGINS=https://anistrim-one.vercel.app,...existing origins
RESET_PATHS_JSON={"mobile":"/reset-password.html","web":"https://anistrim-one.vercel.app/#/reset-password","desktop":"/reset-password","admin":"/admin/reset-password"}
GOOGLE_RETURN_TARGETS_JSON={"mobile":"anistrim://auth","web":"https://anistrim-one.vercel.app/#/auth/google/callback","desktop":"anistrim-desktop://auth","admin":"/admin/google-callback.html"}
PAYMENT_RETURN_TARGETS_JSON={"mobile":"/payment-callback.html","web":"https://anistrim-one.vercel.app/#/payment-return","desktop":"anistrim-desktop://payment-return","admin":"/admin/"}
BACKEND_URL=https://anistrimbackend.onrender.com
```

`API_ALLOWED_ORIGINS` is confirmed effective in production. The three client URL maps still require dashboard confirmation because their values control reset, OAuth, and payment returns.

Google Cloud Console must keep this backend callback registered:

```text
https://anistrimbackend.onrender.com/api/auth/google/callback
```

## Medium-priority findings

1. The Vercel deployment has no `vercel.json`. This is correct for the current hash router, but direct non-hash URLs such as `/anime/123` return `404`; shared links must use `/#/anime/123`.

2. The root Vercel response has no explicit Content-Security-Policy header. The app has no exposed credentials in `Web/`, but a CSP should be evaluated and deployed after confirming required sources for Google Fonts, Google OAuth, Cloudinary/Bunny media, Render API, and HLS streams.

3. Payment verification polling is intentionally bounded to two minutes and stops once the user leaves `#/payment-return`. A slow provider/IPN must be verified manually to ensure the final manual-refresh message is acceptable.

## Low-priority findings

1. Google Fonts remains a remote first-load dependency.

2. The static Vercel responses include `Access-Control-Allow-Origin: *`. This does not grant API access or credentials; API CORS is separately exact-origin and verified. It can be tightened if cross-origin static embedding is not required.

3. The runtime API override `window.__ANISTRIM_API` intentionally supports controlled deployment injection. Production HTML does not define it, so Render is used. Do not inject an empty value in Vercel production because it would make requests same-origin.

## Security review

- No frontend JWT signing secret, database credential, provider secret, Mailgun key, or payment secret was found in `Web/` source outside bundled third-party code.
- Redirect handling is restricted to internal hash routes in Web; backend reset/OAuth/payment return targets are server-owned allow-listed configuration values.
- Authentication uses bearer tokens and the backend CORS configuration has `credentials: false`; the verified production preflight does not use wildcard API CORS.
- Access and Premium enforcement remain backend-authoritative.

## Performance and lifecycle review

- Browse uses bounded API pages and server-provided pagination metadata; search is debounced and stale results are discarded.
- Progress heartbeats are throttled to 15 seconds and cleanup runs on player teardown/navigation.
- Player teardown destroys the HLS instance before a new one is created.
- Hash-router exit from a watch route triggers player/progress cleanup.
- Payment polling is bounded and route-aware.

## Files involved

- `Web/index.html`
- `Web/js/config.js`
- `Web/js/api.js`
- `Web/js/router.js`
- `Web/js/auth.js`
- `Web/js/player.js`
- `Web/js/ui.js`
- `Web/js/app.js`
- `Web/css/styles.css`
- `config/cors.js`
- `config/clientAgnostic.js`
- `controllers/authController.js`
- `controllers/googleAuthController.js`
- `controllers/paymentController.js`

## Final deployment checklist

- [ ] Redeploy Render after setting/confirming the client URL maps above.
- [ ] Keep `API_ALLOWED_ORIGINS` with the exact Vercel origin and no trailing slash.
- [ ] Redeploy Vercel from `Web/` after reviewing the current commit.
- [ ] Test `https://anistrim-one.vercel.app/#/anime/<id>` by refresh and direct navigation.
- [ ] Test unauthenticated browse/search/details and confirm requests use Render.
- [ ] Test login, access-token refresh, logout, and protected-route redirect.
- [ ] Test signup, OTP verification, forgot-password email, and reset completion.
- [ ] Test Google login success and cancellation returns.
- [ ] Test Pesapal success, cancel, pending IPN, and verified Premium activation.
- [ ] Test a Premium episode immediately after payment without changing client state manually.
- [ ] Test avatar upload, watchlist mutation, progress/history resume, and preference restoration.
- [ ] Add a CSP only after validating every required production media/OAuth source.
