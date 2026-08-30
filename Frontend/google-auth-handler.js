/**
 * google-auth-handler.js — Shared Google Identity Services (GIS) Module
 *
 * SINGLE SOURCE OF TRUTH for all Google authentication in the application.
 *
 * This module:
 *   ✓ Loads and waits for the GIS library (with timeout + retry)
 *   ✓ Fetches GOOGLE_CLIENT_ID from backend (with timeout + retry)
 *   ✓ Initializes GIS exactly once (never re-initializes)
 *   ✓ Renders the OFFICIAL GIS button via google.accounts.id.renderButton()
 *     into a container next to the custom button — a user click ALWAYS opens
 *     the Google account chooser (One Tap suppression can no longer block it)
 *   ✓ Keeps google.accounts.id.prompt() ONLY as an optional fallback
 *     (single call — no nested second prompt)
 *   ✓ Provides a clean Promise-based API: initGoogleAuth(buttonId, options)
 *   ✓ Manages loading/error states on the button (element IDs configurable)
 *   ✓ Returns the credential response on success
 *   ✓ Rejects with specific error messages on failure
 *   ✓ Prevents duplicate authentication requests
 *
 * Usage:
 *   const credential = await window.initGoogleAuth('google-login-btn', {
 *     textElementId: 'google-btn-text',   // optional, defaults shown
 *     iconElementId: 'google-btn-icon',   // optional
 *     defaultText: 'Continue with Google' // restored on reset
 *   });
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
 *   <script src="config.js"></script>            (Frontend pages)
 *   <script src="js/backend-url.js"></script>    (Admin pages — instead of config.js)
 *   <script src="google-auth-handler.js"></script>
 *   <script src="login.js"></script> (or signup.js / AdminDashboard/js/auth.js)
 */

(function () {
  'use strict';

  // ── Configuration ───────────────────────────────────────
  var GIS_LIB_RETRIES = 10;      // Wait up to 10s for GIS library
  var GIS_LIB_INTERVAL = 1000;   // Check every 1s
  var CLIENT_ID_RETRIES = 3;     // Retry client ID fetch 3 times
  var CLIENT_ID_INTERVAL = 2000; // 2s between retries
  var CLIENT_ID_TIMEOUT = 10000; // 10s max for fetch

  var SPINNER_HTML =
    '<div style="width:20px;height:20px;border:2px solid rgba(108,43,217,0.2);' +
    'border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div>';

  // ── State ────────────────────────────────────────────────
  var gisInitialized = false;     // Has GIS been initialized?
  var gisClientId = null;         // Stored client ID after fetch
  var authInProgress = false;     // Prevent concurrent auth requests
  var pendingResolve = null;      // Promise resolve function
  var pendingReject = null;       // Promise reject function
  var popupWatchdogTimer = null;  // Post-popup cancel detection timer

  // ── Backend URL ─────────────────────────────────────────
  // Resolution order:
  //   1. window.getAdminBackendUrl()  — AdminDashboard shared helper (js/backend-url.js)
  //   2. window.getApiBaseUrl()       — Frontend shared helper (Frontend/config.js)
  //   3. window.__API_BASE_URL        — legacy global
  //   4. production backend (last resort)
  function getBackendUrl() {
    if (typeof window.getAdminBackendUrl === 'function') {
      return window.getAdminBackendUrl();
    }
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
            data = (data && data.success === true && data.data) ? data.data : data;
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
      cancel_on_tap_outside: true,
      auto_select: false,
      itp_support: true,
      prompt_parent_id: null,
      use_fedcm_for_prompt: false,
    });
    gisInitialized = true;
    gisClientId = clientId;
    console.log('[GoogleAuth] GIS initialized successfully.');
  }

  // ── Official GIS button (renderButton) ──────────────────
  // Renders Google's official Sign-In button into a container placed NEXT TO
  // the caller's custom button. Clicking that official button ALWAYS opens the
  // Google account chooser — this is the primary flow and is immune to One Tap
  // suppression (iTP, FedCM, prior dismissal).
  function ensureOfficialButton(btn) {
    try {
      if (!gisInitialized || typeof google === 'undefined' || !google.accounts ||
          !google.accounts.id || typeof google.accounts.id.renderButton !== 'function') {
        return null;
      }
      // Reuse an existing container if it is still attached to the DOM.
      if (btn._gisOfficialParent && document.body.contains(btn._gisOfficialParent)) {
        return btn._gisOfficialParent;
      }
      var parent = document.createElement('div');
      parent.className = 'gis-official-btn-container';
      parent.style.cssText = 'display:flex;justify-content:center;margin-top:10px;min-height:40px;';
      // Insert the container right after the custom button.
      if (btn.parentNode) {
        btn.parentNode.insertBefore(parent, btn.nextSibling);
      } else {
        document.body.appendChild(parent);
      }
      var width = Math.max(200, Math.min(400, btn.offsetWidth || 320));
      google.accounts.id.renderButton(parent, {
        theme: 'outline',
        size: 'large',
        type: 'standard',
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: width
      });
      btn._gisOfficialParent = parent;
      console.log('[GoogleAuth] Official GIS button rendered next to custom button.');
      return parent;
    } catch (e) {
      console.warn('[GoogleAuth] renderButton failed:', e && e.message);
      return null;
    }
  }

  // Find the clickable element inside the official-button container and click it.
  function clickOfficialButton(parent) {
    if (!parent) return false;
    var target = parent.querySelector('div[role="button"]') ||
                 parent.querySelector('[role="button"]') ||
                 parent.firstElementChild;
    if (target && typeof target.click === 'function') {
      target.click();
      return true;
    }
    return false;
  }

  // ── Popup watchdog ──────────────────────────────────────
  // When the popup account chooser closes, the window regains focus. If no
  // credential has arrived shortly after, treat it as a cancel so the button
  // never stays stuck. FedCM (in-page modal) flows never blur the window, so
  // this watchdog is a no-op there.
  function startPopupWatchdog(btn, ctx) {
    try {
      var onBlur = function () {
        window.removeEventListener('blur', onBlur);
        window.addEventListener('focus', onFocusOnce, { once: true });
      };
      var onFocusOnce = function () {
        if (popupWatchdogTimer) clearTimeout(popupWatchdogTimer);
        popupWatchdogTimer = setTimeout(function () {
          if (authInProgress) {
            console.log('[GoogleAuth] Popup closed without credential — treating as cancel.');
            cancelSignIn(btn, ctx);
          }
        }, 1500);
      };
      window.addEventListener('blur', onBlur);
      // Safety: stop watching after 5 minutes regardless.
      setTimeout(function () { window.removeEventListener('blur', onBlur); }, 300000);
    } catch (e) { /* watchdog is best-effort */ }
  }

  // ── Handle Credential Response ──────────────────────────
  function handleCredentialResponse(response) {
    authInProgress = false;
    if (popupWatchdogTimer) {
      clearTimeout(popupWatchdogTimer);
      popupWatchdogTimer = null;
    }
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

  // ── Outcome helpers ─────────────────────────────────────
  function failSignIn(btn, ctx, suppressErrors, msg) {
    resetButtonState(btn, ctx);
    if (!suppressErrors) showError(btn, msg);
    if (pendingReject) {
      var r = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      r(new Error(msg));
    }
  }

  function cancelSignIn(btn, ctx) {
    resetButtonState(btn, ctx);
    if (pendingReject) {
      var r = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      r(new Error('Authentication cancelled'));
    }
  }

  // ── Public API: Initialize Google Auth on a Button ──────
  /**
   * initGoogleAuth(buttonId, options)
   *
   * @param {string} buttonId - DOM element ID of the custom "Continue with Google" button
   * @param {object} [options] - Optional settings
   * @param {boolean} [options.suppressErrors=false] - If true, don't show inline error messages
   * @param {string} [options.loadingText='Signing in...'] - Text during loading
   * @param {string} [options.defaultText='Continue with Google'] - Restored on reset
   * @param {string} [options.textElementId='google-btn-text'] - ID of the button-text element
   * @param {string} [options.iconElementId='google-btn-icon'] - ID of the button-icon element
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
    var ctx = {
      suppressErrors: options.suppressErrors || false,
      loadingText: options.loadingText || 'Signing in...',
      defaultText: options.defaultText || 'Continue with Google',
      textElementId: options.textElementId || 'google-btn-text',
      iconElementId: options.iconElementId || 'google-btn-icon',
      defaultIconHtml: null
    };

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
      var btnText = document.getElementById(ctx.textElementId);
      var btnIcon = document.getElementById(ctx.iconElementId);
      // Capture the caller's original icon markup once so reset restores it.
      if (btnIcon && ctx.defaultIconHtml === null) {
        ctx.defaultIconHtml = btnIcon.innerHTML;
      }
      if (btnText) btnText.textContent = ctx.loadingText;
      if (btnIcon) btnIcon.innerHTML = SPINNER_HTML;

      // Store promise callbacks
      pendingResolve = resolve;
      pendingReject = reject;

      // If GIS is already initialized and we have a client ID, show the chooser
      if (gisInitialized && gisClientId) {
        console.log('[GoogleAuth] GIS ready, opening account chooser...');
        showGoogleSignIn(btn, ctx);
        return;
      }

      // Step 1: Wait for GIS library
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
          // Step 4: Open the account chooser (official button primary path)
          showGoogleSignIn(btn, ctx);
        })
        .catch(function (err) {
          // Reset state
          authInProgress = false;
          pendingResolve = null;
          pendingReject = null;

          // Reset button
          btn.disabled = false;
          if (btnText) btnText.textContent = ctx.defaultText;
          if (btnIcon && ctx.defaultIconHtml !== null) btnIcon.innerHTML = ctx.defaultIconHtml;

          // Show meaningful error
          if (!ctx.suppressErrors) {
            showError(btn, err.message);
          }
          reject(err);
        });
    });
  }

  // ── Show Google Sign-In (account chooser) ───────────────
  // PRIMARY PATH: click the official GIS button rendered next to the custom
  // button — this always opens the Google account chooser.
  // OPTIONAL FALLBACK: a SINGLE google.accounts.id.prompt() call (no nested
  // second prompt) when the official button cannot be rendered/clicked.
  function showGoogleSignIn(btn, ctx) {
    try {
      var parent = ensureOfficialButton(btn);
      var clicked = parent ? clickOfficialButton(parent) : false;
      if (clicked) {
        console.log('[GoogleAuth] Official GIS button activated — account chooser opening.');
        startPopupWatchdog(btn, ctx);
        return;
      }

      // Optional enhancement / fallback: single prompt() call.
      console.log('[GoogleAuth] Official button unavailable — falling back to prompt().');
      google.accounts.id.prompt(function (notification) {
        if (notification.isNotDisplayed()) {
          console.log('[GoogleAuth] Prompt not displayed:', notification.getNotDisplayedReason());
          failSignIn(btn, ctx, ctx.suppressErrors,
            'Google sign-in unavailable. Please use email/password or try again later.');
        } else if (notification.isSkippedMoment()) {
          console.log('[GoogleAuth] Prompt skipped:', notification.getSkippedReason());
          cancelSignIn(btn, ctx);
        } else if (notification.isDismissedMoment()) {
          console.log('[GoogleAuth] Prompt dismissed:', notification.getDismissedReason());
          cancelSignIn(btn, ctx);
        }
        // If credential_returned, the initialize callback handles it
      });
    } catch (e) {
      console.error('[GoogleAuth] Error showing sign-in UI:', e);
      failSignIn(btn, ctx, ctx.suppressErrors, 'Google sign-in unavailable. Please try again.');
    }
  }

  // ── Reset Button State ──────────────────────────────────
  // Restores the caller-provided defaultText (never a hardcoded string) and the
  // captured original icon markup.
  function resetButtonState(btn, ctx) {
    authInProgress = false;
    if (popupWatchdogTimer) {
      clearTimeout(popupWatchdogTimer);
      popupWatchdogTimer = null;
    }
    if (btn) {
      btn.disabled = false;
    }
    ctx = ctx || {};
    var btnText = document.getElementById(ctx.textElementId || 'google-btn-text');
    if (btnText) btnText.textContent = ctx.defaultText || 'Continue with Google';
    var btnIcon = document.getElementById(ctx.iconElementId || 'google-btn-icon');
    if (btnIcon && ctx.defaultIconHtml != null) {
      btnIcon.innerHTML = ctx.defaultIconHtml;
    }
  }

  // ── Capacitor native detection ─────────────────────────
  // Returns true when running inside Capacitor native WebView.
  // Used to suppress the entire GIS module on native — the native
  // @capawesome/capacitor-google-sign-in plugin is the sole auth path.
  function isCapacitorNative() {
    return typeof window.Capacitor !== 'undefined'
        && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform();
  }

  // ── REGRESSION GUARD: In Capacitor native mode, skip all GIS operations. ──
  // GIS should never initialize, render buttons, or handle auth inside the
  // native WebView. The native plugin is the only auth path on Android/iOS.
  // This guard is the first thing checked — before any GIS API is called.
  if (isCapacitorNative()) {
    console.log('[GoogleAuth] Capacitor native detected — GIS module disabled.');
    // Export a stub initGoogleAuth that immediately rejects so any accidental
    // caller in the native path gets a clear error instead of a silent failure.
    window.initGoogleAuth = function () {
      return Promise.reject(new Error('Use native Google Sign-In plugin in Capacitor mode.'));
    };
    return; // ← EXIT EARLY — skip everything GIS-related
  }

  // ── On Page Load: Pre-initialize GIS (warm up) ──────────
  // This runs on every page that includes google-auth-handler.js.
  // It loads the GIS library and fetches the client ID so that
  // when the user clicks the button, everything is ready. After init it also
  // pre-renders the official GIS button next to any known custom button so a
  // visible, guaranteed account-chooser target exists immediately.
  var KNOWN_BUTTON_IDS = ['admin-google-btn', 'google-login-btn', 'google-signup-btn'];

  function preRenderOfficialButtons() {
    // Do NOT render the official GIS button in Capacitor native mode.
    // The native plugin (login.js → CapGoogleSignIn.signIn()) handles auth.
    if (isCapacitorNative()) {
      console.log('[GoogleAuth] Capacitor native detected — skipping official GIS button render.');
      return;
    }
    for (var i = 0; i < KNOWN_BUTTON_IDS.length; i++) {
      var btn = document.getElementById(KNOWN_BUTTON_IDS[i]);
      if (btn) {
        ensureOfficialButton(btn);
      }
    }
  }

  function preInitialize() {
    console.log('[GoogleAuth] Pre-initializing Google auth...');

    waitForGISLibrary(GIS_LIB_RETRIES)
      .then(function () {
        return fetchClientId(CLIENT_ID_RETRIES);
      })
      .then(function (clientId) {
        initializeGIS(clientId, handleCredentialResponse);
        preRenderOfficialButtons();
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
      var raw  = await res.json();
      // Standard envelope: { success:true, data:{ token, user } } — unwrap.
      var data = (raw && raw.success === true && raw.data) ? raw.data : raw;
      if (!res.ok || !data.token || !data.user) {
        hideOverlay();
        showDLError('Sign-in failed. Please try again.');
        return;
      }
      if (window.AniStrimSession) window.AniStrimSession.create('mobile').setTokens(data.token, data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.history.replaceState({}, document.title, window.location.pathname);
      hideOverlay();
      window.redirectAfterAuthentication(data.user, data.token);
    } catch(e) {
      hideOverlay();
      console.error('Deep link auth error:', e);
      showDLError('Could not complete sign-in. Please try again.');
    }
  }

  // Check URL params on page load (web/desktop only — deep links are handled
  // centrally by login.js / signup.js appUrlOpen listeners in the native app).
  function checkUrlOnLoad() {
    var code = getCodeFromUrl(window.location.href);
    if (code) {
      fetchAndLogin(code);
      return true;
    }
    return false;
  }

  // Deep-link handling in the native app is consolidated in login.js and
  // signup.js (each page registers exactly one appUrlOpen listener). This
  // module's deep-link handler is removed to prevent duplicate callback
  // processing where the same login code could be consumed twice.
  // The listenForDeepLink function is kept as a no-op for backward compat.
  function listenForDeepLink() {
    // Intentionally empty — deep-link handling is centralized in login.js /
    // signup.js to prevent duplicate appUrlOpen processing.
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
