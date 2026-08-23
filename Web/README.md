# AniStrim Web deployment

This directory is a static, hash-routed web application intended for Vercel.

## Vercel

- Root Directory: `Web`
- Framework Preset: `Other`
- Build Command: leave empty
- Output Directory: leave empty
- Install Command: leave empty

Deploy the directory root as static files. Routes use hashes, for example
`/#/anime/123` and `/#/reset-password?token=...`; no SPA rewrite is required.

## Public configuration

The API base resolves in this order:

1. `window.__ANISTRIM_API`
2. `<meta name="anistrim-api">`
3. `''` (same-origin — Vercel rewrites `/api/*` to the Render backend)

The production Web frontend uses **same-origin** API requests. `vercel.json`
rewrites `/api/:path*` to `https://anistrimbackend.onrender.com/api/:path*`, so
the browser only ever sees `https://anistrim.com/api/...` and the Render URL is
never exposed to the client.

Never expose: JWT or stream-token secrets, database credentials, Google client
secret, SMTP credentials, or payment-provider secret keys.

## Backend deployment prerequisites

The backend must allow the exact deployed Vercel origin in CORS:

`API_ALLOWED_ORIGINS=https://anistrim.com,https://www.anistrim.com,...`

The backend must also be configured to generate Web password-reset and Google
OAuth return URLs for the Vercel domain. This static client uses `X-Client: web`
on every request.
