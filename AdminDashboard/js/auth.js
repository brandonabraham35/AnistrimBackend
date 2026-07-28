// File Path: AdminDashboard/js/auth.js

// ── Google Identity Services (GIS) Popup Login for Admin ────
// Uses Google's GSI client library
// Flow: Button click → GIS popup → ID token → POST /api/auth/google/verify
// → Backend verifies and returns JWT → Check isAdmin → Store token → Redirect

let isGoogleAuthInProgress = false;
let adminGoogleBtn = null;
let adminGoogleBtnText = null;

// Initialize GIS on DOM ready
function initAdminGIS() {
  if (typeof google === 'undefined' || !google.accounts) {
    console.log('[AdminGIS] Library not ready, will retry in 1s...');
    setTimeout(initAdminGIS, 1000);
    return;
  }

  adminGoogleBtn = document.getElementById('admin-google-btn');
  adminGoogleBtnText = document.getElementById('admin-google-btn-text');

  console.log('[AdminGIS] Initializing Google Identity Services...');

  // Determine backend URL for fetching client ID
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const baseUrl = isLocalhost ? 'http://localhost:5000' : 'https://anistrimbackend.onrender.com';

  google.accounts.id.initialize({
    client_id: null, // Will be fetched from backend
    callback: handleAdminGISCredentialResponse,
    cancel_on_tap_outside: false,
    auto_select: false,
    itp_support: true,
  });

  // Store baseUrl for later use
  window.__ADMIN_API_BASE = baseUrl;

  if (!google.accounts.id.getClientId()) {
    fetchAdminClientId(baseUrl);
  }
}

// Fetch GOOGLE_CLIENT_ID from backend
async function fetchAdminClientId(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/auth/google/client-id`);
    if (res.ok) {
      const data = await res.json();
      if (data.clientId) {
        google.accounts.id.initialize({
          client_id: data.clientId,
          callback: handleAdminGISCredentialResponse,
          cancel_on_tap_outside: false,
          auto_select: false,
          itp_support: true,
        });
        console.log('[AdminGIS] Client ID configured from backend.');
        return;
      }
    }
  } catch (e) {
    console.warn('[AdminGIS] Could not fetch client ID:', e.message);
  }

  console.warn('[AdminGIS] No GOOGLE_CLIENT_ID configured. Google login will not work.');
}

// Handle the credential response from GIS
function handleAdminGISCredentialResponse(response) {
  if (!response || !response.credential) {
    showAdminError('Google sign-in failed. No credential received.');
    resetAdminGoogleButton();
    return;
  }

  const idToken = response.credential;
  const baseUrl = window.__ADMIN_API_BASE || 'https://anistrimbackend.onrender.com';

  // Show loading state
  setAdminGoogleLoading(true);

  // Send the ID token to our backend for verification
  sendAdminIdTokenToBackend(idToken, baseUrl);
}

// Send the ID token to POST /api/auth/google/verify
async function sendAdminIdTokenToBackend(idToken, baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/auth/google/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });

    const data = await res.json();

    if (res.ok && data.token && data.user) {
      // Check if user is admin
      const isAdmin = data.user.isAdmin || data.user.is_admin;

      if (!isAdmin) {
        resetAdminGoogleButton();
        showAdminError('Access Denied. This Google account is not an administrator.');
        return;
      }

      // Store admin session
      localStorage.setItem('admin_token', data.token);
      localStorage.setItem('admin_user', JSON.stringify(data.user));

      setAdminGoogleLoading(false);

      // Redirect to dashboard
      window.location.replace('dashboard.html');
    } else {
      resetAdminGoogleButton();
      showAdminError(data.message || 'Google sign-in failed. Please try again.');
    }
  } catch (e) {
    console.error('[AdminGIS] Backend verification error:', e);
    resetAdminGoogleButton();
    showAdminError('Cannot reach server. Please check your connection.');
  }
}

// ── UI Helpers for Google Button ────────────────────────

function setAdminGoogleLoading(loading) {
  if (!adminGoogleBtn) adminGoogleBtn = document.getElementById('admin-google-btn');
  if (!adminGoogleBtnText) adminGoogleBtnText = document.getElementById('admin-google-btn-text');

  if (loading) {
    if (adminGoogleBtn) adminGoogleBtn.disabled = true;
    if (adminGoogleBtnText) adminGoogleBtnText.textContent = 'Verifying...';
    isGoogleAuthInProgress = true;
  }
}

function resetAdminGoogleButton() {
  if (!adminGoogleBtn) adminGoogleBtn = document.getElementById('admin-google-btn');
  if (!adminGoogleBtnText) adminGoogleBtnText = document.getElementById('admin-google-btn-text');

  if (adminGoogleBtn) adminGoogleBtn.disabled = false;
  if (adminGoogleBtnText) adminGoogleBtnText.textContent = 'Sign in with Google';
  isGoogleAuthInProgress = false;
}

// Main handler called by the "Sign in with Google" button
function googleLogin() {
  // Prevent multiple clicks
  if (isGoogleAuthInProgress) {
    console.log('[AdminGIS] Auth already in progress, ignoring click.');
    return;
  }

  // Check if GIS is loaded
  if (typeof google === 'undefined' || !google.accounts) {
    showAdminError('Google sign-in is loading. Please try again in a moment.');
    return;
  }

  // Show loading state while popup opens
  setAdminGoogleLoading(true);

  // Prompt the Google One Tap / Sign-In popup
  try {
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed()) {
        console.log('[AdminGIS] Prompt not displayed:', notification.getNotDisplayedReason());
        resetAdminGoogleButton();
      } else if (notification.isSkippedMoment()) {
        console.log('[AdminGIS] Prompt skipped:', notification.getSkippedReason());
        resetAdminGoogleButton();
      } else if (notification.isDismissedMoment()) {
        console.log('[AdminGIS] Prompt dismissed:', notification.getDismissedReason());
        resetAdminGoogleButton();
        if (notification.getDismissedReason() !== 'credential_returned') {
          showAdminError('Google sign-in cancelled. You can try again.');
        }
      }
    });
  } catch (e) {
    console.error('[AdminGIS] Error showing prompt:', e);
    resetAdminGoogleButton();
    showAdminError('Could not open Google sign-in. Please try again.');
  }
}

// ── Error Display ─────────────────────────────────────────
function showAdminError(msg) {
  const errorMsg = document.getElementById('error-message');
  if (errorMsg) {
    errorMsg.innerText = msg;
  }
}

// ── Email/Password Login ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-message');

    // Display any error messages passed from the URL (legacy)
    const urlParams = new URLSearchParams(window.location.search);
    const authError = urlParams.get('error');
    if (authError && errorMsg) {
        errorMsg.innerText = decodeURIComponent(authError);
    }

    const currentPath = window.location.pathname;
    const isLoginPage = currentPath.endsWith('index.html') || currentPath === '/' || currentPath.endsWith('/');

    if (localStorage.getItem('admin_token') && isLoginPage) {
        window.location.replace('dashboard.html');
        return;
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const loginBtn = document.getElementById('login-btn');

            loginBtn.disabled = true;
            loginBtn.innerText = 'Logging in...';
            if (errorMsg) errorMsg.innerText = '';

            try {
                // Pass a raw JavaScript object; the apiRequest helper will handle serialization.
                const data = await window.apiRequest('/api/auth/login', {
                    method: 'POST',
                    body: { email, password }
                });

                const u = data?.user;
                // Simplified, robust check for admin status, handles various formats (boolean, number, buffer)
                const isAdmin = u && (u.isAdmin || u.is_admin == 1 || (u.is_admin?.data?.[0] === 1));

                if (data?.token && isAdmin) {
                    localStorage.setItem('admin_token', data.token);
                    localStorage.setItem('admin_user', JSON.stringify(u));
                    window.location.replace('dashboard.html');
                } else if (data?.token) {
                    if (errorMsg) errorMsg.innerText = 'Access denied. Account is not configured as an administrator.';
                    localStorage.removeItem('admin_token');
                } else {
                    if (errorMsg) errorMsg.innerText = window._escapeHTML(data.message || 'Login failed.');
                }
            } catch (err) {
                localStorage.removeItem('admin_token');
                localStorage.removeItem('admin_user');
                if (errorMsg) errorMsg.innerText = err.message;
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerText = 'Login';
            }
        });
    }

    // Initialize GIS
    initAdminGIS();
});

function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
}

window.googleLogin = googleLogin;
window.logout = logout;
