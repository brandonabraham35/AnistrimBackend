// controllers/googleAuthController.js
// Google OAuth redirect flow for Capacitor mobile app using deep-link handoff.
// Supports two intents (identical business rules to the web flows):
//   /google/start?intent=login   -> existing account only (never creates)
//   /google/start?intent=signup  -> new account only (never silently reuses/links)
//
// The login/signup business decision is made in the SHARED
// resolveGoogleIdentity(profile, intent) helper (services/googleIdentityService.js)
// so the web GIS and native Capacitor flows apply the IDENTICAL intent rule.
//
// Presentation decoupling:
//   • By default (no ?client param) the callback returns the legacy HTML bridge
//     page that deep-links back into the mobile app (unchanged).
//   • A client-agnostic client passes ?client=api to receive the SAME result
//     as structured JSON (status, short-lived login code, user DTO, intent, and
//     a suggested deep link) so the client decides how to render/handle it.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { resolveGoogleIdentity } = require('../services/googleIdentityService');
const sessionService = require('../services/sessionService');
const { buildUserDto } = require('../services/userDtoService');
const { sendSuccess } = require('../utils/response');
const clientAgnostic = require('../config/clientAgnostic');
const pool = require('../config/db');

const BACKEND_URL = process.env.BACKEND_URL || 'https://anistrimbackend.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || BACKEND_URL;
const APP_SCHEME = process.env.APP_SCHEME || 'anistrim';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.anistrim.render';
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

function getCallbackUri(client) {
  const base = String(client === 'web' ? FRONTEND_URL : BACKEND_URL).replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getCallbackUri('')
);

async function createLoginCode(token, refreshToken, user, intent) {
  const code = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_MS);
  await pool.query(
    'INSERT INTO oauth_login_codes (code, user_id, access_token, refresh_token, intent, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [code, user.id, token, refreshToken || null, intent, expiresAt]
  );
  return code;
}

async function consumeLoginCode(code) {
  const [rows] = await pool.query(
    'SELECT * FROM oauth_login_codes WHERE code = ? AND expires_at > NOW() LIMIT 1',
    [code]
  );
  if (!rows.length) return null;
  await pool.query('DELETE FROM oauth_login_codes WHERE code = ?', [code]).catch(() => {});
  return rows[0];
}

setInterval(() => {
  pool.query('DELETE FROM oauth_login_codes WHERE expires_at < NOW()').catch(() => {});
}, 5 * 60 * 1000).unref?.();

// ── Begin the OAuth redirect. intent is carried in OAuth `state` so it
//    survives the round-trip through Google. Defaults to 'login'.
exports.googleRedirect = (req, res) => {
  const intent = req.query.intent === 'signup' ? 'signup' : 'login';
  const requestedClient = typeof req.query.client === 'string' ? req.query.client : '';
  const returnClient = ['web', 'mobile', 'desktop', 'admin'].includes(requestedClient) ? requestedClient : '';

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    redirect_uri: getCallbackUri(returnClient),
    state: JSON.stringify({ intent, client: returnClient }),
  });
  res.redirect(url);
};

// Resolve a validated OAuth return target into an absolute URL the browser can
// follow. Absolute scheme URLs (https:, anistrim:, anistrim-desktop:) pass
// through unchanged. Relative paths are resolved against the public web origin
// for the web client (so the browser ends on anistrim.com, not Render) and
// against the backend origin otherwise (admin/mobile pages served by Render).
function resolveReturnUrl(clientId, returnTarget) {
  if (!returnTarget) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(returnTarget)) return returnTarget; // absolute scheme URL
  const base = clientId === 'web' ? FRONTEND_URL : BACKEND_URL;
  return clientAgnostic.buildClientUrl(returnTarget, base);
}

// Stage-labeled diagnostic wrapper. Identifies WHICH sequential OAuth stage
// failed in production logs so the exact failing operation can be confirmed on
// the next live attempt. Never logs the authorization code, tokens, or secrets.
async function tagged(stage, fn) {
  try {
    const result = await fn();
    console.log(`[googleCallback] stage ok: ${stage}`);
    return result;
  } catch (err) {
    console.error(`[googleCallback] stage FAILED: ${stage} | code=${(err && err.code) || ''} status=${(err && err.status) || ''} msg=${(err && err.message) || err}`);
    throw err;
  }
}

// ── Google redirect_uri — apply the SAME login/signup business rules.
//    Client-agnostic path: pass ?client=api to receive structured JSON instead
//    of the HTML bridge page. The existing mobile flow (no client param) is
//    unchanged.
exports.googleCallback = async (req, res) => {
  const { code, error, state } = req.query;
  const jsonMode = req.query.client === 'api';
  const fail = (message, codeVal = 'GOOGLE_AUTH_FAILED') => {
    if (jsonMode) {
      return res.status(400).json({ success: false, code: codeVal, message });
    }
    return res.send(errorPage(message));
  };

  let intent = 'login';
  let returnClient = '';
  try {
    if (state) {
      const parsedState = JSON.parse(state);
      intent = (parsedState.intent === 'signup') ? 'signup' : 'login';
      returnClient = ['web', 'mobile', 'desktop', 'admin'].includes(parsedState.client) ? parsedState.client : '';
    }
  } catch (e) { /* malformed state -> default login */ }

  // Non-sensitive entry log: intent/client and the presence of code/error only —
  // never the authorization code itself.
  console.log(`[googleCallback] enter intent=${intent} client=${returnClient || '(default)'} hasCode=${code ? 1 : 0} hasError=${error ? 1 : 0} jsonMode=${jsonMode ? 1 : 0}`);

  if (error || !code) {
    // Web/desktop clients with a validated return target should land back in
    // their own UI even when Google cancels or rejects consent. The message is
    // intentionally generic and no credentials are placed in the URL.
    if (!jsonMode && returnClient) {
      const redirectTarget = resolveReturnUrl(returnClient, clientAgnostic.getGoogleReturnTarget(returnClient));
      if (redirectTarget) {
        const separator = redirectTarget.includes('?') ? '&' : '?';
        return res.redirect(`${redirectTarget}${separator}error=${encodeURIComponent('Sign-in cancelled.')}`);
      }
    }
    return fail('Sign-in cancelled.', 'OAUTH_CANCELLED');
  }

  try {
    // Stage 1 — Token exchange.
    const { tokens } = await tagged('token-exchange', () =>
      client.getToken({ code, client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: getCallbackUri(returnClient) })
    );
    client.setCredentials(tokens);

    // Stage 2 — Retrieve the verified Google profile.
    const userInfoResponse = await tagged('google-profile', () =>
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    );
    if (!userInfoResponse.ok) {
      console.error(`[googleCallback] stage FAILED: google-profile | HTTP ${userInfoResponse.status}`);
      const text = await userInfoResponse.text();
      throw new Error(`Failed to fetch Google user info: ${text}`);
    }

    const profile = await userInfoResponse.json();
    if (!profile?.email) return fail('Could not get your email.', 'MISSING_EMAIL');
    if (profile.email_verified === false) return fail('Google email is not verified.', 'EMAIL_NOT_VERIFIED');

    // Stage 3 — Apply the IDENTICAL login/signup intent rule via the shared helper.
    const { user } = await tagged('identity-resolution', () => resolveGoogleIdentity(profile, intent));

    // Stage 4 — Create a session (access + refresh tokens) + login history.
    const { accessToken, refreshToken } = await tagged('session-creation', () => sessionService.createSession(user, req));
    await tagged('login-history', () => sessionService.logEvent(user.id, 'google_login', 'google', req));

    // Stage 5 — Build the canonical user DTO.
    const dto = await tagged('user-dto', () => buildUserDto(user));

    console.log('[googleCallback] stage start: login-code');
    const loginCode = await createLoginCode(accessToken, refreshToken, dto, intent);
    console.log('[googleCallback] stage ok: login-code code=present length=' + loginCode.length);

    console.log('[googleCallback] stage start: success-page');

    // Client-agnostic path: return structured result + suggested deep link.
    // B7 fix: per-client return target resolved from X-Client header with
    // strict allow-list validation — never reflect caller-supplied URLs.
    if (jsonMode) {
      const client = (req.headers && req.headers['x-client']) || 'mobile';
      const requestedTarget = req.query && typeof req.query.returnTarget === 'string' ? req.query.returnTarget : '';
      const deepLink = clientAgnostic.getGoogleReturnTarget(client, requestedTarget || undefined) ||
        `${APP_SCHEME}://auth?code=${encodeURIComponent(loginCode)}&intent=${intent}`;
      return sendSuccess(res, {
        code: loginCode,
        user: dto,
        intent,
        deepLink,
        token: accessToken,
      }, { message: 'Google authentication successful.' });
    }

    // A browser client requested an explicit callback route before leaving for
    // Google. Return only to the server-owned allow-listed target, carrying a
    // short-lived one-time code rather than an access token in the URL.
    if (returnClient) {
      const redirectTarget = resolveReturnUrl(returnClient, clientAgnostic.getGoogleReturnTarget(returnClient));
      if (redirectTarget) {
        const separator = redirectTarget.includes('?') ? '&' : '?';
        return res.redirect(`${redirectTarget}${separator}code=${encodeURIComponent(loginCode)}&intent=${encodeURIComponent(intent)}`);
      }
    }

    console.log('[googleCallback] sending successPage');
    res.send(successPage(loginCode));
    console.log('[googleCallback] success-page sent');
    return;
  } catch (err) {
    console.error(`[googleCallback] callback FAILED | code=${(err && err.code) || ''} status=${(err && err.status) || ''} msg=${(err && err.message) || err}`);
    if (err && err.stack) console.error(err.stack);
    if (err.code === 'GOOGLE_NO_ACCOUNT') {
      return fail('No AniStrim account is associated with this Google account. Please create an account first.', 'GOOGLE_NO_ACCOUNT');
    }
    if (err.code === 'GOOGLE_ACCOUNT_NOT_LINKED') {
      return fail('An AniStrim account already exists with this email. Please log in using your email and password.', 'GOOGLE_ACCOUNT_NOT_LINKED');
    }
    if (err.code === 'ACCOUNT_ALREADY_EXISTS') {
      return fail('An AniStrim account already exists. Please log in instead.', 'ACCOUNT_ALREADY_EXISTS');
    }
    // Account status-gate codes (thrown by resolveGoogleIdentity). These must
    // not be masked by the generic "sign-in failed" message.
    if (err.code === 'ACCOUNT_SUSPENDED') {
      return fail('This account has been suspended.', 'ACCOUNT_SUSPENDED');
    }
    if (err.code === 'ACCOUNT_DEACTIVATED') {
      return fail('This account has been deactivated.', 'ACCOUNT_DEACTIVATED');
    }
    if (err.code === 'ACCOUNT_DELETED') {
      return fail('This account has been deleted.', 'ACCOUNT_DELETED');
    }
    return fail('Sign-in failed. Please try again.');
  }
};

// ── Fallback page for S.browser_fallback_url ───────────────
// Served when the Android intent:// URL cannot be handled natively by the
// In-App Browser (Chrome Custom Tab). This minimal page gives the browser a
// valid URL to navigate to, which triggers it to close and allows the
// Capacitor app to receive the appUrlOpen event from the intent.
exports.callbackFallback = (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Returning to AniStrim...</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:sans-serif;padding:20px}.spinner{width:52px;height:52px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}p{color:#aaa;font-size:.9rem;text-align:center}.logo{font-size:1.3rem;font-weight:800;color:#fff}.logo span{color:#6c2bd9}</style>
</head><body><div class="logo">Ani<span>Strim</span></div><div class="spinner"></div><p>Returning to AniStrim...</p></body></html>`);
};

exports.exchangeLoginCode = async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ message: 'Missing login code.' });

  const record = await consumeLoginCode(code);
  if (!record) {
    return res.status(400).json({ message: 'Login code is invalid or expired. Please try Google sign-in again.' });
  }

  // Rebuild user DTO from the user_id stored in the code record
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [record.user_id]);
  if (!rows.length) {
    return res.status(404).json({ message: 'User not found.' });
  }
  const dto = await buildUserDto(rows[0]);

  return sendSuccess(res, {
    token: record.access_token,
    refreshToken: record.refresh_token,
    user: dto,
    intent: record.intent,
  });
};

function successPage(code) {
  console.log('[googleCallback] successPage generating bridge');
  const encodedCode = encodeURIComponent(code);
  const deepLink = `${APP_SCHEME}://auth?code=${encodedCode}`;
  // Browsers (including Chrome Custom Tabs used by Capacitor Browser) need
  // S.browser_fallback_url to know where to navigate when an intent:// URL
  // cannot be handled natively. Without it the browser stays on the success
  // page and the Capacitor app never receives the appUrlOpen event.
  const fallbackUrl = encodeURIComponent(`${BACKEND_URL}/api/auth/google/callback-fallback?code=${encodedCode}`);
  const androidIntent = `intent://auth?code=${encodedCode}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};S.browser_fallback_url=${fallbackUrl};end`;

  console.log('[googleCallback] successPage generated');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Returning to AniStrim...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0f;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:sans-serif;padding:20px;}
    .spinner{width:52px;height:52px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:spin 0.8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{color:#aaa;font-size:0.9rem;text-align:center;line-height:1.5;}
    .logo{font-size:1.3rem;font-weight:800;color:#fff;}.logo span{color:#6c2bd9;}
    .btn{margin-top:16px;background:#6c2bd9;color:white;border:none;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:1rem;font-weight:700;display:inline-block;}
  </style>
</head>
<body>
  <div class="logo">Ani<span>Strim</span></div>
  <div class="spinner" id="spin"></div>
  <p id="msg">Signed in successfully. Returning to AniStrim...</p>
  <a class="btn" id="btn" href="${androidIntent}">Open AniStrim →</a>
  <script>
    const androidIntent = ${JSON.stringify(androidIntent)};
    const deepLink = ${JSON.stringify(deepLink)};
    const fallbackUrl = '${BACKEND_URL}/api/auth/google/callback-fallback?code=${encodedCode}';

    function openApp() {
      // Try Android intent first (may trigger appUrlOpen)
      console.log('[GOOGLE-OAUTH-TRACE] Bridge page: attempting androidIntent');
      window.location.href = androidIntent;
      
      // After 500ms, if we're still here, explicitly navigate to HTTP fallback
      // This ensures the browser loads a real HTTP URL that can be detected
      setTimeout(function () {
        console.log('[GOOGLE-OAUTH-TRACE] Bridge page: intent did not close browser, navigating to fallback');
        window.location.href = fallbackUrl;
      }, 500);
    }

    setTimeout(openApp, 300);
    setTimeout(function () {
      document.getElementById('spin').style.display = 'none';
      document.getElementById('msg').textContent = 'Tap Open AniStrim if you are not returned automatically.';
    }, 2000);
  </script>
</body>
</html>`;
} // <-- closing brace for successPage function

function errorPage(message) {
  // Build HTML entities programmatically so they survive transport encoding.
  const amp = String.fromCharCode(38);
  const safeMessage = String(message).replace(/[<>&"]/g, ch => ({
    '<': amp + 'lt;',
    '>': amp + 'gt;',
    '&': amp + 'amp;',
    '"': amp + 'quot;',
  }[ch]));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif;}
    .box{background:#1a1a2e;border:1px solid #6c2bd9;border-radius:16px;padding:32px 24px;text-align:center;max-width:340px;width:100%;}
    h2{color:#ef4444;margin-bottom:10px;}p{color:#aaa;font-size:0.85rem;margin-bottom:24px;line-height:1.6;}
    a{display:block;width:100%;background:#6c2bd9;color:#fff;text-decoration:none;border:none;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:600;}
  </style>
</head>
<body>
  <div class="box">
    <div style="font-size:3rem;margin-bottom:16px">❌</div>
    <h2>Sign-in Failed</h2>
    <p>${safeMessage}</p>
    <a href="${APP_SCHEME}://auth-error">← Back to Login</a>
  </div>
</body>
</html>`;
}
