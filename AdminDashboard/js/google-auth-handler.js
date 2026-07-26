// google-auth-handler.js
// Handles the OAuth callback for the Admin Dashboard.

(function() {
  // Use the globally exposed apiRequest function from api.js
  const apiRequest = window.apiRequest;
  if (!apiRequest) {
    console.error('[Google Auth] window.apiRequest is not defined. Make sure api.js is loaded first.');
    return;
  }

  // --- Extract code from URL ---
  function getCodeFromUrl(url) {
    try {
      const u = new URL(url);
      const code = u.searchParams.get('code');
      if (code) return code;
    } catch (e) {}
    // Fallback for non-standard URL formats
    const match = (url || '').match(/[?&]code=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // --- Fetch JWT using the one-time code ---
  async function fetchAndLogin(code) {
    if (!code) return;

    showOverlay('Verifying account...');

    try {
      // Exchange the code for a token. This endpoint does not require auth.
      const data = await apiRequest(`/api/auth/google/token?code=${encodeURIComponent(code)}`);

      const u = data?.user;
      const isAdmin = u && (u.isAdmin || u.is_admin == 1 || (u.is_admin?.data?.[0] === 1));

      if (!data.token || !isAdmin) {
        hideOverlay();
        showAuthError('Access Denied. This Google account is not an administrator.');
        return;
      }

      // Save admin token and user info
      localStorage.setItem('admin_token', data.token);
      localStorage.setItem('admin_user', JSON.stringify(u));

      // Clean the code from the URL and redirect
      window.history.replaceState({}, document.title, window.location.pathname.replace('index.html', 'dashboard.html'));
      window.location.replace('dashboard.html');

    } catch (e) {
      hideOverlay();
      console.error('Google auth handler error:', e);
      showAuthError(e.message || 'Could not complete sign-in.');
    }
  }

  // --- UI helpers ---
  function showOverlay(msg) {
    if (document.getElementById('g-auth-overlay')) return;
    const div = document.createElement('div');
    div.id = 'g-auth-overlay';
    div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,10,15,0.96);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
    div.innerHTML = `<div style="width:48px;height:48px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div><p style="color:#aaa;font-size:0.9rem;font-family:sans-serif;">${msg}</p><style>@keyframes gspin{to{transform:rotate(360deg)}}</style>`;
    document.body.appendChild(div);
  }

  function hideOverlay() {
    const el = document.getElementById('g-auth-overlay');
    if (el) el.remove();
  }

  function showAuthError(msg) {
    const errorMsg = document.getElementById('error-message');
    if (errorMsg) {
      errorMsg.innerText = msg;
    } else {
      alert(msg); // Fallback
    }
  }

  // --- Run on page load ---
  function checkUrlOnLoad() {
    const code = getCodeFromUrl(window.location.href);
    if (code) fetchAndLogin(code);
  }

  document.addEventListener('DOMContentLoaded', checkUrlOnLoad);
})();