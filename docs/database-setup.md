# Database Setup & Migration Guide

This document describes the **only** supported ways to create and evolve the
AniStrim database. The application is designed so that **nothing modifies the
database automatically**.

- `node server.js` never runs migrations and never creates administrators.
- Importing `config/db.js` is side-effect free: it only builds a lazy connection
  pool.

All schema changes and account setup are explicit, opt-in commands.

---

## Commands

| Command | Purpose | Writes? |
| ------- | ------- | ------- |
| `npm run db:bootstrap` | Create a brand-new database (foundational schema + all migrations) | Yes |
| `npm run migrate` | Apply pending migrations to an existing database | Yes |
| `npm run migrate:status` | Show applied/pending migrations | **No (read-only)** |
| `npm run admin:create` | Create/promote an administrator (you supply credentials) | Yes |

---

## First-time install (brand-new empty database)

1. Configure `.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
   plus the app secrets).
2. Run the bootstrap:

   ```bash
   npm run db:bootstrap
   ```

   This:
   - creates the target database (`DB_NAME`) if it does not exist;
   - applies the foundational schema — `sql/schema.sql` and
     `sql/oauth_login_codes.sql`;
   - records a baseline marker (`0000_schema_baseline`) in `schema_migrations`;
   - applies every versioned migration (`sql/migrations_v*.sql`) on top;
   - verifies the critical tables/columns exist.

   It is idempotent and safe to re-run.

3. Create the administrator explicitly (the bootstrap never seeds one):

   ```bash
   npm run admin:create
   ```

   Supply `ADMIN_EMAIL` / `ADMIN_PASSWORD` (or answer the prompts). The command
   refuses weak/default passwords, refuses to run with a hardcoded value, and
   hashes with `PASSWORD_PEPPER` exactly like the login path.

4. Start the app:

   ```bash
   npm start
   ```

   `server.js` performs a **read-only** schema health check and refuses to start
   if critical tables are missing — it does not migrate.

---

## Upgrading an existing database

```bash
npm run migrate:status    # inspect first (read-only)
npm run migrate           # apply pending migrations
```

- Migrations are discovered from `sql/migrations_v*.sql` in numeric version
  order (both `migrations_v5.sql` and `migrations_v003_*.sql` are supported).
- Runs are **serialized** with a MySQL advisory lock (`GET_LOCK`) so two
  deployments can never migrate simultaneously. If the lock cannot be acquired
  within 30 seconds the run aborts.
- A migration is recorded in `schema_migrations` **only after every statement in
  it succeeds**. If a migration fails, the run stops, prints the failing file and
  statement, and exits non-zero — the deployment must stop. The failed migration
  is not recorded, so the next run retries it idempotently.
- DDL in MySQL is auto-committed, so a failed migration may leave partial
  changes; the runner's idempotent handling (skip "already exists") makes a retry
  safe.

---

## What `server.js` does and does not do

- **Does NOT** run migrations on startup.
- **Does NOT** create or promote administrators on startup.
- **Does** run a read-only `assertCriticalTables()` check (queries
  `information_schema` only) and refuses to start if critical tables/columns are
  missing.

## What importing `config/db.js` does and does not do

- **Does** build a lazy `mysql2` connection pool.
- **Does NOT** connect, create/promote administrators, run migrations, or write
  anything.

---

## Migration runner internals

- `scripts/migrate.js` — ordered, idempotent, recorded, serialized runner.
- `scripts/db-bootstrap.js` — fresh-database bootstrap (baseline + migrations).
- Baseline = `sql/schema.sql` (foundational tables + seed data) +
  `sql/oauth_login_codes.sql` (the OAuth login-codes table, which is not part of
  any versioned migration).
- Versioned migrations = `sql/migrations_v*.sql`.

### Legacy / non-versioned files

- `sql/updates.sql` — a legacy manual patch file; **not** run by the runner.
- `migrations/002_add_email_verification.sql` — a legacy orphan migration,
  superseded by `sql/migrations_v25_email_verification.sql`; **not** run by the

---

## Security notes (auth/authorization)

- **Password reset replay protection** — used reset tokens are persisted in the
  `password_reset_tokens` table (`sql/migrations_v56_password_reset_tokens.sql`)
  and consumed atomically (a single `UPDATE ... SET used_at = NOW() WHERE used_at
  IS NULL`), so a token is single-use, survives process restarts, and cannot be
  consumed twice by concurrent requests. Run `npm run migrate` to create the
  table.
- **Password policy is centralized** — every password path (signup, login,
  set/change/reset password, `admin:create`) uses `utils/password.js`
  (`pepperPassword`/`hashPassword`/`verifyPassword`). Do not duplicate pepper
  logic elsewhere.
- **Admin authorization is fail-closed** — `utils/hasRole.js` grants admin only
  from the `user_roles` table. A failed or empty role lookup never falls back to
  `users.is_admin`. Existing admins must hold a `user_roles` row (populated by
  `migrations_v27_user_roles.sql` and by `npm run admin:create`).

  runner.
- These are kept for history but are not part of the canonical bootstrap/migrate
  sequence.

---

## Administrator creation

`npm run admin:create` (`scripts/admin-create.js`):

- Reads `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` from the environment, or
  prompts interactively (password input is hidden).
- **Never** uses a hardcoded/default password.
- Refuses passwords shorter than 12 characters (16 in production), known weak
  values, and passwords containing the email local-part.
- Hashes with `PASSWORD_PEPPER` (HMAC-SHA256) then bcrypt, matching the login
  path in `controllers/authController.js`.
- Uses parameterized queries (no SQL injection).
- Is a one-time, explicit command — it never runs automatically.

---

## Testing

The database architecture tests live in `test/database.test.js`.

- Unit tests (no database) always run.
- Integration tests that need a real MySQL database are **guarded**: they only
  run when `DB_TEST_ISOLATED=1` and a dedicated admin connection is provided via
  `DB_TEST_ADMIN_USER` / `DB_TEST_ADMIN_PASSWORD`. They create an ephemeral
  `anistrim_test_*` database and drop it afterwards, so they can never touch
  production data.

```bash
# unit tests only
node --require ./test/setup.js --test test/database.test.js

# with an isolated disposable MySQL test server
$env:DB_TEST_ISOLATED='1'
$env:DB_TEST_ADMIN_HOST='localhost'; $env:DB_TEST_ADMIN_USER='root'; $env:DB_TEST_ADMIN_PASSWORD='...'
node --require ./test/setup.js --test test/database.test.js
```
