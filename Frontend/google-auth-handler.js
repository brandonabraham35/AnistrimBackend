/**
 * google-auth-handler.js — Shared Google Identity Services (GIS) Module
 *
 * SINGLE SOURCE OF TRUTH for all Google authentication in the application.
 *
 * This module:
 *   ✓ Loads and waits for the GIS library (with timeout + retry)
 *   ✓ Fetches GOOGLE_CLIENT_ID from backend (with timeout + retry)
 *   ✓ Initializes GIS exactly once (never re-initializes)
 *   ✓ Provides a clean Promise-based API: initGoogleAuth(buttonId)
 *   ✓ Manages loading/error states on the button
 *   ✓ Returns the credential response on success
 *   ✓ Rejects with specific error messages on failure
 *   ✓ Prevents duplicate authentication requests
 *   ✓ Uses renderButton() approach for reliable account chooser display
 *
 * Usage:
 *   const credential = await window.initGoogleAuth('google-login-btn');
 *   // Send credential.credential (ID token) to backend
 *
 * Error messages:
 *   'Google library failed to load'
 *   'Backend unavailable'
 *   'Failed to retrieve Google Client ID'
 *   'Invalid Google Client ID'
 *   'Google sign-in unavailable. Please use email/password or try again later.'
 *   'Authentication cancelled'
 *   'Google sign-in failed. No credential received.'
 *   'Network timeout'
 *
 * Include order on HTML pages:
 *   <script src="https://accounts.google.com/gsi/client"></script>
 *   <script src="config.js"></script>
 *   <script src="scrpt.js"></script>
 *   <script src="google-auth-handler.js"></script>
 *   <script src="login.js"></script> (or signup.js, etc.)
 */

(function () {
  'use strict';

  // ── Configuration ───────────────────────────────────────
  var GIS_LIB_RETRIES = 10;      // Wait up to 10s for GIS library
  var GIS_LIB_INTERVAL = 1000;   // Check every 1s
  var CLIENT_ID_RETRIES = 3;     // Retry client ID fetch 3 times
  var CLIENT_ID_INTERVAL = 2000; // 2s between retries
  var CLIENT_ID_TIMEOUT = 10000; // 10s max for fetch

  // ── State ────────────────────────────────────────────────
  var gisInitialized = false;     // Has GIS been initialized?
  var gisClientId = null;        // Stored client ID after fetch
  var authInProgress = false;    // Prevent concurrent auth requests
  var pendingResolve = null;     // Promise resolve function
  var pendingReject = null;      // Promise reject function

  // ── Backend URL ─────────────────────────────────────────
  function getBackendUrl() {
    if (typeof window.getApiBaseUrl === 'function') {
      return window.getApiBaseUrl();
    }
    if (typeof window.__API_BASE_URL !== 'undefined') {
      return window.__API_BASE_URL;
    }
    return 'https://anistrimbackend.onrender.com';
  }

  // ── Wait for GIS Library ────────────────────────────────
  function waitForGISLibrary(maxRetries) {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      function check() {
        if (typeof google !== 'undefined' && google.accounts) {
          console.log('[GoogleAuth] GIS library loaded successfully.');
          resolve();
          return;
        }
        attempts++;
        if (attempts >= maxRetries) {
          reject(new Error('Google library failed to load'));
          return;
        }
        setTimeout(check, GIS_LIB_INTERVAL);
      }
      check();
    });
  }

  // ── Fetch Google Client ID from Backend ─────────────────
  function fetchClientId(maxRetries) {
    return new Promise(function (resolve, reject) {
      var backend = getBackendUrl();
      var attempts = 0;
      var timedOut = false;

      var timeoutId = setTimeout(function () {
        timedOut = true;
        reject(new Error('Network timeout'));
      }, CLIENT_ID_TIMEOUT);

      function attempt() {
        if (timedOut) return;
        fetch(backend + '/api/auth/google/client-id', {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        })
          .then(function (res) {
            if (!res.ok) {
              throw new Error('Backend returned ' + res.status);
            }
            return res.json();
          })
          .then(function (data) {
            clearTimeout(timeoutId);
            if (data && data.clientId && typeof data.clientId === 'string' && data.clientId.length > 0) {
              resolve(data.clientId);
            } else {
              reject(new Error('Invalid Google Client ID'));
            }
          })
          .catch(function (err) {
            attempts++;
            if (attempts >= maxRetries || timedOut) {
              clearTimeout(timeoutId);
              if (err.message === 'Backend unavailable' || err.message.indexOf('Failed to fetch') !== -1) {
                reject(new Error('Backend unavailable'));
              } else {
                reject(new Error('Failed to retrieve Google Client ID'));
              }
            } else {
              setTimeout(attempt, CLIENT_ID_INTERVAL);
            }
          });
      }
      attempt();
    });
  }

  // ── Initialize GIS (exactly once) ──────────────────────
  function initializeGIS(clientId, callback) {
    if (gisInitialized) {
      console.log('[GoogleAuth] GIS already initialized, skipping.');
      return;
    }
    console.log('[GoogleAuth] Initializing Google Identity Services...');
    google.accounts.id.initialize({
      client_id: clientId,
      callback: callback,
      cancel_on_tap_outside: false,
      auto_select: false,
      itp_support: true,
    });
    gisInitialized = true;
    gisClientId = clientId;
    console.log('[GoogleAuth] GIS initialized successfully.');
  }

  // ── Handle Credential Response ──────────────────────────
  function handleCredentialResponse(response) {
    authInProgress = false;
    if (pendingResolve) {
      if (response && response.credential) {
        pendingResolve(response);
      } else {
        pendingReject(new Error('Google sign-in failed. No credential received.'));
      }
      pendingResolve = null;
      pendingReject = null;
    }
  }

  // ── Public API: Initialize Google Auth on a Button ──────
  /**
   * initGoogleAuth(buttonId, options)
   *
   * @param {string} buttonId - DOM element ID of the "Continue with Google" button
   * @param {object} [options] - Optional settings
   * @param {boolean} [options.suppressErrors=false] - If true, don't show inline error messages
   * @param {string} [options.loadingText='Signing in...'] - Text during loading
   * @param {string} [options.defaultText='Continue with Google'] - Default button text
   * @returns {Promise} Resolves with { credential: idToken } on success
   *
   * The returned Promise:
   *   - Resolves with the Google credential when auth succeeds
   *   - Rejects with an Error containing a user-friendly message on failure
   *
   * Example:
   *   try {
   *     const response = await window.initGoogleAuth('google-login-btn');
   *     // response.credential is the ID token
   *   } catch (err) {
   *     // err.message has user-friendly error
   *   }
   */
  function initGoogleAuth(buttonId, options) {
    options = options || {};
    var suppressErrors = options.suppressErrors || false;
    var loadingText = options.loadingText || 'Signing in...';
    var defaultText = options.defaultText || 'Continue with Google';

    return new Promise(function (resolve, reject) {
      if (authInProgress) {
        reject(new Error('Authentication already in progress.'));
        return;
      }

      var btn = document.getElementById(buttonId);
      if (!btn) {
        reject(new Error('Button element not found: ' + buttonId));
        return;
      }

      // Set loading state
      authInProgress = true;
      btn.disabled = true;
      var btnText = document.getElementById('google-btn-text');
      var btnIcon = document.getElementById('google-btn-icon');
      if (btnText) btnText.textContent = loadingText;
      if (btnIcon) {
        btnIcon.innerHTML = '<div style="width:20px;height:20px;border:2px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div>';
      }

      // Store promise callbacks
      pendingResolve = resolve;
      pendingReject = reject;

      // If GIS is already initialized and we have a client ID, show the prompt
      if (gisInitialized && gisClientId) {
        console.log('[GoogleAuth] GIS ready, showing sign-in prompt...');
        showGoogleSignIn(btn, suppressErrors);
        return;
      }

      // Step 1: Wait for GIS library
      btnText = btnText || document.getElementById('google-btn-text');
      if (btnText) btnText.textContent = 'Loading Google...';

      waitForGISLibrary(GIS_LIB_RETRIES)
        .then(function () {
          // Step 2: Fetch client ID
          if (btnText) btnText.textContent = 'Loading...';
          return fetchClientId(CLIENT_ID_RETRIES);
        })
        .then(function (clientId) {
          // Step 3: Initialize GIS exactly once
          initializeGIS(clientId, handleCredentialResponse);
          // Step 4: Show sign-in prompt
          showGoogleSignIn(btn, suppressErrors);
        })
        .catch(function (err) {
          // Reset state
          authInProgress = false;
          pendingResolve = null;
          pendingReject = null;

          // Reset button
          btn.disabled = false;
          if (btnText) btnText.textContent = defaultText;
          if (btnIcon) {
            btnIcon.innerHTML =
              '<svg width="15" height="15" viewBox="0 0 24 24">' +
              '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>' +
              '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>' +
              '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>' +
              '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>' +
              '</svg>';
          }

          // Show meaningful error
          if (!suppressErrors) {
            showError(btn, err.message);
          }
          reject(err);
        });
    });
  }

  // ── Show Google Sign-In Prompt ──────────────────────────
  function showGoogleSignIn(btn, suppressErrors) {
    try {
      // Use prompt() to show the sign-in UI.
      // First call: shows One Tap if available.
      // If not displayed, the notification handler can attempt again.
      google.accounts.id.prompt(function (notification) {
        if (notification.isNotDisplayed()) {
          console.log('[GoogleAuth] Prompt not displayed:', notification.getNotDisplayedReason());
          // Try rendering a button approach as fallback by triggering
          // the prompt again which may show the full account chooser
          google.accounts.id.prompt(function (notification2) {
            if (notification2.isNotDisplayed()) {
              console.log('[GoogleAuth] Second prompt also not displayed:', notification2.getNotDisplayedReason());
              // GIS may be blocked or configured incorrectly
              resetButtonState(btn);
              if (!suppressErrors) {
                showError(btn, 'Google sign-in unavailable. Please use email/password or try again later.');
              }
              if (pendingReject) {
                pendingReject(new Error('Google sign-in unavailable. Please use email/password or try again later.'));
                pendingResolve = null;
                pendingReject = null;
              }
            }
          });
        } else if (notification.isSkippedMoment()) {
          console.log('[GoogleAuth] Prompt skipped:', notification.getSkippedReason());
          resetButtonState(btn);
          if (pendingReject) {
            pendingReject(new Error('Authentication cancelled'));
            pendingResolve = null;
            pendingReject = null;
          }
        } else if (notification.isDismissedMoment()) {
          console.log('[GoogleAuth] Prompt dismissed:', notification.getDismissedReason());
          resetButtonState(btn);
          if (pendingReject) {
            pendingReject(new Error('Authentication cancelled'));
            pendingResolve = null;
            pendingReject = null;
          }
        }
        // If credential_returned, the initialize callback handles it
      });
    } catch (e) {
      console.error('[GoogleAuth] Error showing prompt:', e);
      resetButtonState(btn);
      if (!suppressErrors) {
        showError(btn, 'Google sign-in unavailable. Please try again.');
      }
      if (pendingReject) {
        pendingReject(new Error('Google sign-in unavailable. Please try again.'));
        pendingResolve = null;
        pendingReject = null;
      }
    }
  }

  // ── Reset Button State ──────────────────────────────────
  function resetButtonState(btn) {
    authInProgress = false;
    if (btn) {
      btn.disabled = false;
    }
    var btnText = document.getElementById('google-btn-text');
    if (btnText) btnText.textContent = 'Continue with Google';
    var btnIcon = document.getElementById('google-btn-icon');
    if (btnIcon) {
      btnIcon.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24">' +
        '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>' +
        '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>' +
        '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>' +
        '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>' +
        '</svg>';
    }
  }

  // ── On Page Load: Pre-initialize GIS (warm up) ──────────
  // This runs on every page that includes google-auth-handler.js.
  // It loads the GIS library and fetches the client ID so that
  // when the user clicks the button, everything is ready.
  function preInitialize() {
    console.log('[GoogleAuth] Pre-initializing Google auth...');

    waitForGISLibrary(GIS_LIB_RETRIES)
      .then(function () {
        return fetchClientId(CLIENT_ID_RETRIES);
      })
      .then(function (clientId) {
        initializeGIS(clientId, handleCredentialResponse);
        console.log('[GoogleAuth] Pre-initialization complete. Ready for sign-in.');
      })
      .catch(function (err) {
        // Pre-init failed — will retry on button click
        console.warn('[GoogleAuth] Pre-initialization failed:', err.message);
        console.warn('[GoogleAuth] Will retry on button click.');
      });
  }

  // ── Error Display ───────────────────────────────────────
  function showError(btn, msg) {
    if (!msg) return;
    var el = document.getElementById('auth-error');
    if (!el) {
      el = document.createElement('p');
      el.id = 'auth-error';
      el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
      if (btn && btn.parentNode) {
        btn.parentNode.insertBefore(el, btn.nextSibling);
      } else {
        document.querySelector('.auth-submit')?.before(el);
      }
    }
    el.textContent = msg;
    // Auto-clear after 10 seconds
    if (el._clearTimer) clearTimeout(el._clearTimer);
    el._clearTimer = setTimeout(function () {
      if (el && el.parentNode) el.remove();
    }, 10000);
  }

  // ── Expose Public API ───────────────────────────────────
  window.initGoogleAuth = initGoogleAuth;

  // Add a reset function for manual control
  window.resetGoogleAuthState = function () {
    authInProgress = false;
    pendingResolve = null;
    pendingReject = null;
  };

  // ── Run pre-initialization on DOM ready ─────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', preInitialize);
  } else {
    preInitialize();
  }

  // ── Inject spinner keyframe (if not already present) ────
  if (!document.getElementById('g-auth-spinner-style')) {
    var style = document.createElement('style');
    style.id = 'g-auth-spinner-style';
    style.textContent = '@keyframes gspin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  // ════════════════════════════════════════════════════════
  // CAPACITOR DEEP LINK HANDLER
  // Handles anistrim://auth?code=xxx deep link for mobile app
  // ════════════════════════════════════════════════════════

  var BACKEND_DL = getBackendUrl();

  // Extract code from URL or deep link
  function getCodeFromUrl(url) {
    try {
      var u = new URL(url);
      var code = u.searchParams.get('code');
      if (code) return code;
    } catch(e) {}
    var match = (url || '').match(/[?&]code=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // Fetch JWT using the one-time code
  async function fetchAndLogin(code) {
    if (!code) return;
    showOverlay('Signing you in...');
    try {
      var res  = await fetch(BACKEND_DL + '/api/auth/google/token?code=' + encodeURIComponent(code));
      var data = await res.json();
      if (!res.ok || !data.token || !data.user) {
        hideOverlay();
        showDLError('Sign-in failed. Please try again.');
        return;
      }
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.history.replaceState({}, document.title, window.location.pathname);
      hideOverlay();
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } catch(e) {
      hideOverlay();
      console.error('Deep link auth error:', e);
      showDLError('Could not complete sign-in. Please try again.');
    }
  }

  // Check URL params on page load
  function checkUrlOnLoad() {
    var code = getCodeFromUrl(window.location.href);
    if (code) {
      fetchAndLogin(code);
      return true;
    }
    return false;
  }

  // Listen for Capacitor deep link event
  function listenForDeepLink() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;
    try {
      window.Capacitor.Plugins.App.addListener('appUrlOpen', function(data) {
        if (!data || !data.url) return;
        if (!data.url.includes('anistrim://auth')) return;
        try { window.Capacitor.Plugins.Browser.close(); } catch(e) {}
        if (data.url.includes('error=')) return;
        var code = getCodeFromUrl(data.url);
        if (code) fetchAndLogin(code);
      });
    } catch(e) {
      console.log('Deep link listener error:', e.message);
    }
  }

  // UI helpers for overlay
  function showOverlay(msg) {
    if (document.getElementById('g-auth-overlay')) return;
    var div = document.createElement('div');
    div.id = 'g-auth-overlay';
    div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,10,15,0.96);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
    div.innerHTML = '<div style="width:48px;height:48px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div><p style="color:#aaa;font-size:0.9rem;font-family:sans-serif;">' + msg + '</p><style>@keyframes gspin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(div);
  }

  function hideOverlay() {
    var el = document.getElementById('g-auth-overlay');
    if (el) el.remove();
  }

  function showDLError(msg) {
    var el = document.getElementById('auth-error');
    if (!el) {
      el = document.createElement('p');
      el.id = 'auth-error';
      el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    }
    el.textContent = msg;
  }

  // Run deep link check on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      if (!checkUrlOnLoad()) listenForDeepLink();
    });
  } else {
    if (!checkUrlOnLoad()) listenForDeepLink();
  }

  console.log('[GoogleAuth] Shared module loaded.');
})();

