# Production Runtime & Readiness

This document describes the production runtime/lifecycle behavior of the
backend as it will run under systemd behind Nginx (single Node.js process).

## Process lifecycle

- **Graceful shutdown** (`config/shutdown.js`): on `SIGTERM`/`SIGINT` the process
  stops accepting new requests (`server.close`), drains in-flight connections for
  a bounded period (default 10 s), closes the MySQL pool, then exits. A hard
  timeout forces exit if draining hangs. Idle keep-alive connections are closed
  to speed draining.
- **Fatal errors** (`server.js`): an `uncaughtException` / `unhandledRejection`
  is logged safely (redacted) and the process **terminates** (exit 1) so systemd
  restarts it. The app does not keep serving after an unrecoverable process-level
  error.

## Liveness — `GET /api/health`

Lightweight liveness: returns `200` as long as the process is up. It does **not**
touch the database. Suitable for a process-level health check.

## Readiness — `GET /api/ready`

Verifies critical application readiness and returns `200` when ready, `503`
when not:
- MySQL connectivity (`SELECT 1`).
- Required schema state (the critical tables exist).

Optional external providers (e.g. AnimeHeaven) are **not** part of readiness — a
provider outage must not mark the whole backend unavailable. The response
includes `{ status, checks: { mysql, schema }, reason, release }`.

## Release identification — `GET /api/release`

Returns a safe, non-secret descriptor: `{ commit, version, deployVersion,
environment }`. `commit` is the short git SHA (or `GIT_SHA` env), `version` is
the `package.json` version, `deployVersion` is `DEPLOY_VERSION` env. No secrets
or internal environment details are exposed.

## Proxy assumptions (one-hop Nginx)

- `trust proxy` is explicit and configurable via `TRUST_PROXY`. Default:
  production trusts exactly **one** hop (`1`); all other environments trust none
  (`0`), so bypassing the proxy cannot spoof `X-Forwarded-*` headers.
- HTTPS enforcement uses `req.protocol` (which respects `trust proxy`) rather
  than a raw client header, and only runs in production when a trusted proxy is
  configured.
- **Bind:** the backend should bind to loopback/private (`BIND_HOST=127.0.0.1`)
  behind Nginx so it is not directly reachable; only Nginx is public. The
  default bind is `0.0.0.0` (needed on current hosting).
- Nginx terminates TLS and sets `X-Forwarded-Proto`/`X-Forwarded-For`; the app
  must not be exposed directly.

## Production configuration validation (`config/validateEnv.js`)

At startup the app validates the environment and refuses to start (exit 1) when
essential production configuration is missing:
- Core (always required in production): `NODE_ENV`, `JWT_SECRET`,
  `JWT_RESET_SECRET`, `STREAM_TOKEN_SECRET`, `DB_HOST`, `DB_USER`,
  `DB_PASSWORD`, `DB_NAME`.
- Optional features only require their credentials when enabled:
  - Google OAuth: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` together.
  - Postmark: `POSTMARK_SERVER_TOKEN` required in production unless
    `POSTMARK_TEST_MODE=true`.
  - Pesapal: consumer key + secret required only when payments are configured.
  - Flutterwave: key set required only when Flutterwave is configured.

## Single-process architecture (do not run multiple instances yet)

The first-production architecture is **one Node.js process**. Several background
jobs run in-process via `node-cron`/`setInterval`:
- premium release + subscription state scheduler,
- home-shelf section builder,
- persistent stream-cache expiry sweeper,
- AnimeHeaven catalogue daily refresh,
- stream source monitor,
- nightly recommendation rebuild,
- health_samples prune.

These are **not** distributed-locked. Running multiple instances concurrently
would cause duplicate scheduled work (double emails, double catalogue refreshes,
competing cache sweeps, double premium transitions). Until these jobs are moved
to a separate worker/queue with a distributed lock (e.g. a leader-election or a
queue), **only one instance may run**. systemd should run exactly one unit.
