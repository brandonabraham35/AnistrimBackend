// File Path: AdminDashboard/js/auth.js
//
// Admin Dashboard Google Authentication using the shared GIS module.
// The shared Google auth handler (google-auth-handler.js from Frontend)
// is included separately via AdminDashboard/index.html.
//
// Admin-specific behaviour after auth: check isAdmin, store admin_token,
// redirect to dashboard.html.

// ── Google Identity Services (GIS) Popup Login for Admin ────
// Uses the shared window.initGoogleAuth() module.
// Flow: Button click → GIS popup → ID token → POST /api/auth/google/verify
// → Backend verifies and returns JWT → Check isAdmin → Store token → Redirect

let isGoogleAuthInProgress = false;

// Main handler called by the "Sign in with Google" button
function googleLogin() {
  // Prevent multiple clicks
  if (isGoogleAuthInProgress) {
    console.log('[AdminGIS] Auth already in progress, ignoring click.');
    return;
  }

  isGoogleAuthInProgress = true;

  // Determine backend URL
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const baseUrl = isLocalhost ? 'http://localhost:5000' : 'https://anistrimbackend.onrender.com';

  // Use the shared Google auth module to get the credential
  // Note: Admin uses 'admin-google-btn' as button ID
  window.initGoogleAuth('admin-google-btn', {
    loadingText: 'Verifying...',
    defaultText: 'Sign in with Google',
    suppressErrors: false
  })
    .then(function (response) {
      if (!response || !response.credential) {
        showAdminError('Google sign-in failed. No credential received.');
        isGoogleAuthInProgress = false;
        return;
      }

      const idToken = response.credential;
      console.log('[AdminGIS] Google ID token received, verifying with backend...');

      // Send the ID token to our backend for verification
      sendAdminIdTokenToBackend(idToken, baseUrl);
    })
    .catch(function (err) {
      // Error already displayed by shared module
      console.error('[AdminGIS] Google auth error:', err.message);
      isGoogleAuthInProgress = false;
    });
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
        showAdminError('Access Denied. This Google account is not an administrator.');
        isGoogleAuthInProgress = false;
        return;
      }

      // Store admin session
      localStorage.setItem('admin_token', data.token);
      localStorage.setItem('admin_user', JSON.stringify(data.user));

      isGoogleAuthInProgress = false;

      // Redirect to dashboard
      window.location.replace('dashboard.html');
    } else {
      showAdminError(data.message || 'Google sign-in failed. Please try again.');
      isGoogleAuthInProgress = false;
    }
  } catch (e) {
    console.error('[AdminGIS] Backend verification error:', e);
    showAdminError('Cannot reach server. Please check your connection.');
    isGoogleAuthInProgress = false;
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
});

function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
}

window.googleLogin = googleLogin;
window.logout = logout;

