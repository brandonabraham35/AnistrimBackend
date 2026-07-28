// login.js — BACKEND defined in scrpt.js

// ── Email/Password Login ────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!email || !password) { showError('Please fill in all fields.'); return; }
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    const res  = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else {
      showError(data.message || 'Incorrect email or password.');
      btn.textContent = 'Sign In';
      btn.disabled = false;
    }
  } catch (e) {
    showError('Cannot reach server. Please check your connection.');
    btn.textContent = 'Sign In';
    btn.disabled = false;
  }
}
window.handleLogin = handleLogin;

// ── Google Identity Services (GIS) Popup Login ──────────────
// Uses Google's GSI client library loaded via:
//   <script src="https://accounts.google.com/gsi/client" async defer>
//
// Flow:
//   1. User clicks "Continue with Google" button
//   2. handleGoogleLogin() calls google.accounts.id.prompt()
//   3. GIS shows an overlay/prompt (One Tap) — OR we use the
//      credential callback approach with google.accounts.id.initialize()
//   4. GIS returns credential (ID token) in the callback
//   5. We send the ID token to POST /api/auth/google/verify
//   6. Backend verifies and returns our JWT
//   7. We store the token and redirect into the app
//
// For a dedicated "Sign In with Google" button (not One Tap),
// we use the following approach:
//   - Initialize GIS with a callback
//   - Call google.accounts.id.prompt() to show One Tap
//   - OR use google.accounts.id.renderButton() on a hidden div
//   - OR use the GIS credential response directly

// Track auth state to prevent double-submits
let isGoogleAuthInProgress = false;
let googleBtn = null;
let googleBtnText = null;
let googleBtnIcon = null;

// Initialize GIS on DOM ready — sets up the callback
function initGIS() {
  if (typeof google === 'undefined' || !google.accounts) {
    // GIS library not loaded yet — will retry
    console.log('[GIS] Library not ready, will retry in 1s...');
    setTimeout(initGIS, 1000);
    return;
  }

  googleBtn = document.getElementById('google-login-btn');
  googleBtnText = document.getElementById('google-btn-text');
  googleBtnIcon = document.getElementById('google-btn-icon');

  console.log('[GIS] Initializing Google Identity Services...');

  // Initialize the GIS client with our callback
  google.accounts.id.initialize({
    client_id: window.__API_BASE_URL ? null : null, // Will be set below
    // We need to get the GOOGLE_CLIENT_ID. It's stored on the backend.
    // For the frontend, we need to fetch it or have it available.
    // Let's try to get it from a meta tag or window variable.
    // If not available, we'll derive it from the backend health check.
    callback: handleGISCredentialResponse,
    cancel_on_tap_outside: false, // Don't cancel if user clicks elsewhere
    auto_select: false, // Don't auto-select — user must click button
    itp_support: true, // Support Intelligent Tracking Prevention
  });

  // If the client_id is null, we need to fetch it from the backend
  if (!google.accounts.id.getClientId()) {
    fetchClientId();
  }
}

// Fetch GOOGLE_CLIENT_ID from backend (or use a fallback)
async function fetchClientId() {
  try {
    // Try to get it from a known endpoint
    const res = await fetch(`${BACKEND}/api/auth/google/client-id`);
    if (res.ok) {
      const data = await res.json();
      if (data.clientId) {
        google.accounts.id.initialize({
          client_id: data.clientId,
          callback: handleGISCredentialResponse,
          cancel_on_tap_outside: false,
          auto_select: false,
          itp_support: true,
        });
        console.log('[GIS] Client ID configured from backend.');
        return;
      }
    }
  } catch (e) {
    console.warn('[GIS] Could not fetch client ID from backend:', e.message);
  }

  // Fallback: Try to use the GOOGLE_CLIENT_ID from the script tag or a meta tag
  const metaTag = document.querySelector('meta[name="google-signin-client_id"]');
  if (metaTag && metaTag.content) {
    google.accounts.id.initialize({
      client_id: metaTag.content,
      callback: handleGISCredentialResponse,
      cancel_on_tap_outside: false,
      auto_select: false,
      itp_support: true,
    });
    console.log('[GIS] Client ID configured from meta tag.');
    return;
  }

  // If we still don't have it, log a warning — the user may need to configure it
  console.warn('[GIS] No GOOGLE_CLIENT_ID configured for frontend. Google login will not work until a client ID is set.');
  console.warn('[GIS] Set GOOGLE_CLIENT_ID in your .env and ensure /api/auth/google/client-id returns it.');
}

// Handle the credential response from GIS
function handleGISCredentialResponse(response) {
  if (!response || !response.credential) {
    showError('Google sign-in failed. No credential received.');
    resetGoogleButton();
    return;
  }

  const idToken = response.credential;
  console.log('[GIS] Google ID token received, verifying with backend...');

  // Show loading state
  setGoogleLoading(true);

  // Send the ID token to our backend for verification
  sendIdTokenToBackend(idToken);
}

// Send the ID token to POST /api/auth/google/verify
async function sendIdTokenToBackend(idToken) {
  try {
    const res = await fetch(`${BACKEND}/api/auth/google/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });

    const data = await res.json();

    if (res.ok && data.token && data.user) {
      // Success — store session and redirect
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');

      setGoogleLoading(false);

      // Redirect based on role — same logic as email login
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else {
      // Backend returned an error
      resetGoogleButton();
      showError(data.message || 'Google sign-in failed. Please try again.');
    }
  } catch (e) {
    console.error('[GIS] Backend verification error:', e);
    resetGoogleButton();
    showError('Cannot reach server. Please check your connection.');
  }
}

// ── UI Helpers for Google Button ────────────────────────

function setGoogleLoading(loading) {
  if (!googleBtn) googleBtn = document.getElementById('google-login-btn');
  if (!googleBtnText) googleBtnText = document.getElementById('google-btn-text');
  if (!googleBtnIcon) googleBtnIcon = document.getElementById('google-btn-icon');

  if (loading) {
    if (googleBtn) googleBtn.disabled = true;
    if (googleBtnText) googleBtnText.textContent = 'Signing in...';
    if (googleBtnIcon) {
      googleBtnIcon.innerHTML = '<div style="width:20px;height:20px;border:2px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div>';
    }
    isGoogleAuthInProgress = true;
  }
}

function resetGoogleButton() {
  if (!googleBtn) googleBtn = document.getElementById('google-login-btn');
  if (!googleBtnText) googleBtnText = document.getElementById('google-btn-text');
  if (!googleBtnIcon) googleBtnIcon = document.getElementById('google-btn-icon');

  if (googleBtn) googleBtn.disabled = false;
  if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
  if (googleBtnIcon) {
    googleBtnIcon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>`;
  }
  isGoogleAuthInProgress = false;
}

// Main handler called by the "Continue with Google" button
function handleGoogleLogin() {
  // Prevent multiple clicks
  if (isGoogleAuthInProgress) {
    console.log('[GIS] Auth already in progress, ignoring click.');
    return;
  }

  // Check if GIS is loaded
  if (typeof google === 'undefined' || !google.accounts) {
    showError('Google sign-in is loading. Please try again in a moment.');
    return;
  }

  // Show loading state while popup opens
  setGoogleLoading(true);

  // Prompt the Google One Tap / Sign-In popup
  // google.accounts.id.prompt() shows the One Tap UI
  // For a dedicated sign-in button, we use prompt() which shows
  // the Google sign-in dialog (as a popup overlay)
  try {
    google.accounts.id.prompt((notification) => {
      // notification.isNotDisplayed() — prompt couldn't be displayed
      // notification.isSkippedMoment() — user dismissed/skipped
      // notification.isDismissedMoment() — user dismissed
      // notification.getNotDisplayedReason()
      // notification.getSkippedReason()
      // notification.getDismissedReason()

      if (notification.isNotDisplayed()) {
        console.log('[GIS] Prompt not displayed:', notification.getNotDisplayedReason());
        resetGoogleButton();
        // Fallback: try using the credential picker directly
        showGoogleCredentialPicker();
      } else if (notification.isSkippedMoment()) {
        console.log('[GIS] Prompt skipped:', notification.getSkippedReason());
        resetGoogleButton();
      } else if (notification.isDismissedMoment()) {
        console.log('[GIS] Prompt dismissed:', notification.getDismissedReason());
        resetGoogleButton();
        // If user closed the popup, show a friendly message
        if (notification.getDismissedReason() === 'credential_returned') {
          // Credential was returned but user dismissed — callback handles it
        } else {
          showError('Google sign-in cancelled. You can try again.');
        }
      }
    });
  } catch (e) {
    console.error('[GIS] Error showing prompt:', e);
    resetGoogleButton();
    showError('Could not open Google sign-in. Please try again.');
  }
}

// Fallback: Use the credential picker directly if One Tap fails
function showGoogleCredentialPicker() {
  try {
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed()) {
        console.log('[GIS] Pick a different account...');
        // If prompt still doesn't work, the client_id may be invalid
        showError('Google sign-in unavailable. Please use email/password or try again later.');
        resetGoogleButton();
      }
    });
  } catch (e) {
    console.error('[GIS] Fallback prompt error:', e);
    resetGoogleButton();
    showError('Google sign-in is not available right now.');
  }
}

// ── Error Display ─────────────────────────────────────────
function showError(msg) {
  if (!msg) return;
  let el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    document.querySelector('.auth-submit')?.before(el);
  }
  el.textContent = msg;
}

// ── Event Listeners ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });

  // Initialize Google Identity Services
  initGIS();
});

// Export globally
window.handleLogin = handleLogin;
window.handleGoogleLogin = handleGoogleLogin;
