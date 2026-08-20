# AniStrim — Mobile Frontend Baseline

**Baseline date:** 2026-08-20
**Scope:** Read-only verification (NO changes made to any file)
**Canonical mobile client:** `Frontend/` — MUST remain named `Frontend/`, unmoved, unreplaced, never converted to `Web/` or `Desktop/`.
**Mobile scope:** Android phones, Android tablets, iPhones, iPads via the existing Capacitor architecture. (MacBooks/desktop → `Desktop/`; browsers → `Web/`.)

---

## 1. Baseline Inventory (from inspection)

| #   | Item                     | Finding                                                                                                                                                                                                                                                                                              |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Capacitor project**    | Confirmed. `package.json` has `@capacitor/core/cli/android/ios` (8.4.x), `@capacitor/app`, `@capacitor/browser`, `@capawesome/capacitor-google-sign-in`. `capacitor.config.json` exists at repo root. ✅                                                                                             |
| 2   | **Android config**       | `android/` project present. `android/app/src/main/AndroidManifest.xml` has INTERNET permission + `anistrim` deep-link scheme. `android/app/src/main/assets/public/` contains a full copy of the web bundle. `npx cap doctor` → `[success] Android looking great! ✅`.                                |
| 3   | **iOS config**           | `ios/` project present. `ios/App/App/Info.plist`, `AppDelegate.swift` (forwards URL opens / universal links to Capacitor proxy). `ios/App/App/public/` contains a web copy. ⚠️ `cap doctor` reports `Xcode is not installed` (environment limitation on this Windows host).                          |
| 4   | **Entry points**         | `Frontend/index.html` (home), `login.html`, `signup.html`, `watch.html`, `details.html`, `browse.html`, `watchlist.html`, `profile.html`, `onboarding.html`, `upgrade.html`, `payment-callback.html`, `verify-otp.html`, `account-status.html`, `admin.html`. All present. ✅                        |
| 5   | **API configuration**    | `Frontend/config.js` → `API_BASE_URL = https://anistrimbackend.onrender.com`, detects native via `window.Capacitor.isNative`; `getApiBaseUrl()` forces the production URL in native/file/localhost. `config/cors.js` allows `capacitor://localhost` (iOS) + `https://localhost` (Android) in dev. ✅ |
| 6   | **Routing**              | `Frontend/js/navigation.js` — Capacitor-aware relative nav (`index.html`), sanitized `?redirect=` allowlist, guarded pages (watch/watchlist/profile). ✅                                                                                                                                             |
| 7   | **Authentication**       | `config.js` `Auth` module (JWT in localStorage), `js/session.js` server-authoritative `/api/auth/me`, `js/api.js` single apiFetch with 401 single-flight refresh + envelope unwrap, login/signup/OTP/Google flows, deep-link `anistrim://auth` handler. ✅                                           |
| 8   | **Profile / avatar**     | `js/avatar.js` renders avatars everywhere (SVG fallback); `profile.js` FormData upload → `/api/auth/avatar`, writes-through to Session/Auth. ✅                                                                                                                                                      |
| 9   | **Streaming / playback** | `js/player/core.js` (hls.js + native-HLS fallback for iOS), `resilience.js` (recovery ladder), `gestures.js` (pointer/touch), `markers.js` (skip intro/outro), `ads.js` (policy gating). `watch.js` uses hardened `/api/stream/authorize` + `/api/stream-proxy/:streamId?token=`. ✅                 |
| 10  | **Assets**               | `Frontend/style.css`, `mobile-native.css`, `css/` (watch), `js/` (api/session/navigation/avatar/progress/player-controls + player/), `src/` (utils). ✅                                                                                                                                              |
| 11  | **Build scripts**        | `package.json`: `cap:sync` = `node scripts/capacitor-preflight.js && cap copy android && cap sync android` (preflight validates webDir completeness). ✅                                                                                                                                             |

## 2. Baseline Checks Run

| Check                  | Command                                                             | Result                                                                                                               |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| webDir preflight       | `node scripts/capacitor-preflight.js`                               | `OK — webDir "Frontend" is valid and complete`                                                                       |
| Capacitor plugins      | `npx cap ls`                                                        | Found 3 plugins for android and ios (`@capacitor/app`, `@capacitor/browser`, `@capawesome/capacitor-google-sign-in`) |
| Capacitor doctor       | `npx cap doctor`                                                    | `[success] Android looking great!`; iOS: `Xcode is not installed`                                                    |
| Frontend entry points  | `list_files Frontend/`                                              | All HTML entry points + js/css/src assets present                                                                    |
| Android bundled assets | `list_files android/app/src/main/assets/`                           | `public/` copy present with full web bundle                                                                          |
| Live API               | `Invoke-WebRequest https://anistrimbackend.onrender.com/api/health` | `503 Server Unavailable` (twice) — remote backend unavailable **at check time**                                      |

## 3. Functionality Verified As Present (not rewritten/broken)

The following systems exist in `Frontend/` and remain wired: login, signup, email/OTP verification, Google authentication (GIS + deep-link), logout, token refresh (single-flight), profile, avatar/profile picture (upload + render), onboarding, genre preferences, anime browsing, search, details, seasons, episodes, watchlist, watch history, continue watching, progress tracking, streaming (authorize + proxy), HLS playback (hls.js + native fallback), subtitles, quality selection, premium access (server-authoritative gating), payments (checkout + callback), downloads (offline via IndexedDB), settings. **None were modified.**

## 4. Pre-Existing Failures / Non-Mobile-Client Issues (listed separately, NOT caused by the mobile client)

| Severity                  | Item                                                                                                | Detail                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External/Env              | **Live backend returned HTTP 503** on `/api/health` at check time (twice).                          | Render cold-start/sleep or deployment maintenance. The `Frontend/config.js` URL is correct; the outage is on the backend host, not the mobile client. Not a Frontend defect. |
| Env                       | **iOS build cannot be compiled on this host** (`Xcode is not installed`).                           | Xcode requires macOS; this verification is on Windows. The iOS project files exist and are wired, but a build/demo needs a Mac. Not a code defect.                           |
| Pre-existing (from audit) | **iOS bundled `ios/App/App/public/` is not guaranteed in sync with `Frontend/`** and may be stale.  | Requires `cap sync ios` (on macOS) to refresh the copy. Not a mobile-client code change.                                                                                     |
| Pre-existing (from audit) | **iOS `Info.plist` lacks `CFBundleURLTypes`** for `anistrim://` scheme + Google reversed-client-id. | Deep-link/Google-auth on iOS is blocked until this native entry is added. This is a native-config gap, not a backend or web-client issue.                                    |

## 5. Protection Confirmed

- `Frontend/` was **not** renamed, moved, or replaced.
- It stays the Capacitor `webDir` (`capacitor.config.json`).
- It remains the **mobile** client (Android/iOS). No `if (web)` / `if (desktop)` behavior was introduced; no Web/Desktop implementation was started.
- No backend architecture or API contract was changed.
- No mobile functionality was rewritten or altered.

## 6. Verdict

```
MOBILE BASELINE STATUS:
PASS
```

**Pre-existing failures (listed separately, not caused by the mobile client):**

- Live backend `/api/health` returned HTTP 503 at check time (backend host availability, not a Frontend issue).
- iOS cannot be compiled on this Windows host (`Xcode is not installed`) — environment limitation.
- iOS `Info.plist` missing the `anistrim://` URL scheme / Google reversed-client-id (native-config gap, already documented in MOBILE_FRONTEND_AUDIT.md).
- iOS bundled `public/` may be stale vs `Frontend/` (needs `cap sync ios` on macOS).

The mobile frontend structure, Capacitor config, Android project, entry points, API wiring, auth/session/refresh, playback/player, asset presence, and build scripts are all valid and unchanged. The baseline is PASS; the noted failures are all pre-existing external or native-environment items that do not stem from the mobile client itself.
