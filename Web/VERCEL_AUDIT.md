# Web Vercel pre-change audit

Date: 2026-08-21

## Scope inspected

`index.html`, all files in `css/` and `js/`, the local HLS bundle, routing,
API/auth/session handling, search/browse, playback, profile/avatar, payments,
Google authentication, and reset-password handling.

## Findings before changes

1. `index.html` used `<base href="/web/">`, coupling every relative asset to
   the Express `/web` mount.
2. It loaded `/shared/client-contract/*.js`, which only exists when the backend
   serves static files; a Vercel deployment would fail to load the session
   contract.
3. A localhost helper set the API base to an empty string, allowing relative
   `/api/*` calls rather than a standalone API origin.
4. The client is hash-routed. Registered routes include reset-password and the
   Google callback, but static root deployment must use `/#/…` URLs.
5. `js/api.js` is the sole request layer found. It applies `X-Client: web`,
   bearer authorization, and a single-flight, one-retry refresh flow. FormData
   leaves multipart content-type to the browser.
6. HLS is bundled locally; streaming is requested only through the AniStrim API.
7. Browse/search use targeted API calls and do not preload a full catalogue.
8. No secrets or private credentials were found in `Web/`.

## External prerequisites

The backend must allow the deployed Vercel origin and generate Web OAuth/reset
return URLs for it. Those are backend deployment settings, intentionally outside
this static-frontend-only change.
