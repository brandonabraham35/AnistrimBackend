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
3. `https://anistrimbackend.onrender.com`

The default meta value is production-safe. A static Vercel deployment cannot
read server environment variables in browser JavaScript at runtime. To override
it, inject `window.__ANISTRIM_API` during a build/deployment step, or update the
public meta tag. Never put private credentials in this directory.

Required public value: `ANISTRIM_API_URL=https://anistrimbackend.onrender.com`
(only when a deployment process injects it into the public config).

Never expose: JWT or stream-token secrets, database credentials, Google client
secret, SMTP credentials, or payment-provider secret keys.

## Backend deployment prerequisites

Allow the exact deployed Vercel origin in the backend:

`API_ALLOWED_ORIGINS=https://YOUR-VERCEL-DOMAIN`

The backend must also be configured to generate Web password-reset and Google
OAuth return URLs for that Vercel domain. This static client uses `X-Client: web`
on every request; it does not use CORS workarounds or API proxy rewrites.
