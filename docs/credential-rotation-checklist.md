# Credential Rotation Checklist

> **Purpose:** A secret/credential was committed to this repository in the past.
> Even though it has been removed from the current working tree, it may still
> exist in Git history and in any forks, clones, or CI caches.
>
> **Rule:** Any credential that appeared in Git history MUST be treated as
> compromised and rotated. This document lists **what** must be rotated and
> **how**, but intentionally contains **NO actual credential values**.

## Why rotation is required

History analysis confirms the following files existed in tracked Git history at
some point:

- `.env` (the real environment file) - exposes every production secret
- `Gmail Key.txt` - Gmail app password
- `MyKey` - a raw key file (binary)
- `Reticia` - a key/certificate file (binary)
- `client_secret_*.json` - a Google OAuth client secret
- `.env.example` - historically embedded a live Redis connection string

Because these are still reachable in earlier commits, every credential in them
must be considered public and rotated. Removing files from the working tree does
**not** remove them from history (see the cleanup commands section at the end).

---

## Severity / priority

| Priority | Asset | Where it was exposed |
| -------- | ----- | -------------------- |
| 1 (highest) | Redis connection string (`REDIS_URL`) | `.env` + `.env.example` in history |
| 1 | Google OAuth client secret | `client_secret_*.json` + `.env` |
| 1 | Gmail app password | `Gmail Key.txt` + `.env` |
| 1 | `MyKey` + `Reticia` key material | tracked files in history |
| 2 | JWT secrets | `.env` in history |
| 2 | Postmark API token | `.env` in history |
| 2 | Cloudinary API secret | `.env` in history |
| 2 | Flutterwave keys | `.env` in history |
| 2 | Pesapal consumer secret + IPN | `.env` in history |
| 3 | MySQL DB password | `.env` in history |
| 3 | Admin bootstrap password | `.env` / `DEFAULT_ADMIN_PASSWORD` |

---

## Manual rotation actions

### 1. Redis (highest priority)
- **Credential:** `REDIS_URL` password for the managed Redis instance.
- **How:** In the Redis provider dashboard, regenerate/invalidate the current
  password and create a new one. Update `REDIS_URL` in the deployment
  environment (and your local `.env`) with the new value.
- **Verify:** Existing long-lived client connections may need to reconnect after
  the password changes; restart any cache/rate-limit clients.

### 2. Google OAuth client secret
- **Credential:** OAuth client ID `472426259589-...` (desktop/installed app type).
- **How:** In Google Cloud Console -> **APIs & Services -> Credentials**, delete or
  reset the secret for the affected OAuth client and generate a new one. Update
  `GOOGLE_CLIENT_SECRET` and the `client_secret_*.json` file (which is now
  ignored by Git).
- **Verify:** Test the Google Sign-In flow end to end from mobile, web, and
  desktop.

### 3. Gmail app password
- **Credential:** The app-specific password that was stored in `Gmail Key.txt`.
- **How:** In your Google account Security settings, revoke the old app password
  and generate a new one. Update the mailer configuration.
- **Note:** AniStrim moved to Postmark for OTP; confirm the Gmail path is no
  longer used in production before decommissioning it.

### 4. `MyKey` and `Reticia` key material
- **Credential:** These are raw/binary key or certificate files whose exact role
  must be confirmed by the owner.
- **How:** Identify which service/certificate each key corresponds to, then
  revoke/reissue that key or certificate at its issuing authority. Do **not**
  reuse the same material.
- **Verify:** If either was a TLS client cert or signing key, rotate the
  corresponding secret on the consuming service too.

### 5. JWT secrets
- **Credential:** `JWT_SECRET`, `JWT_RESET_SECRET`, `STREAM_TOKEN_SECRET`,
  `PASSWORD_PEPPER`.
- **How:** Generate new long random values (e.g. `openssl rand -hex 32`) and set
  them in the deployment environment and local `.env`.
- **Note:** Rotating JWT secrets invalidates all existing sessions/tokens, which
  is intended. Coordinate a deployment window.

### 6. Postmark
- **Credential:** `POSTMARK_SERVER_TOKEN`.
- **How:** In the Postmark dashboard, create a new server token, deactivate the
  old one, and update the environment. `POSTMARK_FROM_EMAIL` / `_NAME` are not
  secret but the token is.

### 7. Cloudinary
- **Credential:** `CLOUDINARY_API_SECRET` (and re-key `CLOUDINARY_API_KEY`).
- **How:** In the Cloudinary dashboard, rotate the API secret / generate new API
  credentials, then update the environment.

### 8. Flutterwave
- **Credential:** `FLW_SECRET_KEY`, `FLW_ENCRYPTION_KEY`, `FLW_WEBHOOK_SECRET`.
- **How:** In the Flutterwave dashboard, regenerate the secret and encryption
  keys and the webhook secret. Update the environment and re-verify webhook
  signature validation end to end.

### 9. Pesapal
- **Credential:** `PESAPAL_CONSUMER_SECRET` and confirm the
  `PESAPAL_IPN_ID`/consumer key pair.
- **How:** Regenerate the consumer secret in the Pesapal developer portal,
  update the environment, and re-run the IPN lifecycle test.

### 10. MySQL database password
- **Credential:** `DB_PASSWORD` (`DB_USER`/`DB_HOST` are not secret but the
  password is).
- **How:** Change the database user password, update the environment, and verify
  connectivity.

### 11. Admin bootstrap password
- **Credential:** `DEFAULT_ADMIN_PASSWORD` / the initial `ADMIN_EMAIL`
  bootstrap/admin account password.
- **How:** Force a password change for any admin account created with the
  compromised bootstrap password, and rotate `DEFAULT_ADMIN_PASSWORD`.

---

## Post-rotation verification checklist

- [ ] `gitleaks` / secret scanner returns no findings on the default branch
      working tree.
- [ ] No tracked file contains a live `REDIS_URL` or other real credential.
- [ ] A fresh clone of a **cleaned re-worked history** (after the repo is
      rewritten with `git filter-repo` / BFG and force-pushed by you) triggers no
      secret-scan hits.
- [ ] All services using rotated credentials reconnect successfully after
      restart.
- [ ] Google Sign-In, payments, email/OTP, and stream token flows are re-tested.

> **Do not rewrite history or force-push until you have rotated the credentials
> above and confirmed there are no live dependents on the old values.**
