/**
 * Centralized API fetch function for the Admin Dashboard.
 * - Uses the global getApiBaseUrl() from config.js
 * - Implements a simple retry mechanism for transient network errors.
 * - Throws an error for non-successful responses to be caught by the caller.
 */
async function apiFetch(endpoint, options = {}, retries = 1) {
  // Backend URL comes from the SINGLE shared helper (js/backend-url.js), which
  // must be loaded before this file. Fallback keeps the old behaviour if the
  // helper is somehow missing.
  const BASE_URL = (typeof window.getAdminBackendUrl === 'function')
    ? window.getAdminBackendUrl()
    : ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:5000'
        : 'https://anistrimbackend.onrender.com');

  const url = `${BASE_URL}${endpoint}`;
  const session = window.AniStrimSession && window.AniStrimSession.create
    ? window.AniStrimSession.create('admin') : null;
  const token = session ? session.getToken() : '';
  const headers = { ...options.headers };
  // Required by backend client-specific redirect and deep-link handling.
  // This works for JSON and FormData without forcing a Content-Type.
  headers['X-Client'] = 'admin';
  const method = options.method || 'GET';

// Only set Content-Type for JSON. Let the browser handle it for FormData.
  // IMPORTANT: Avoid double-serialization. If the body is ALREADY a string
  // (e.g. after a retry where options.body was mutated), do NOT stringify again.
  if (options.body && !(options.body instanceof FormData)) {
    console.log(`[API] ${method} ${url} (JSON Body)`);
    headers['Content-Type'] = 'application/json';
    if (typeof options.body !== 'string') {
      options.body = JSON.stringify(options.body);
    }
  } else if (options.body instanceof FormData) {
    console.log(`[API] ${method} ${url} (FormData Body)`);
  } else {
    console.log(`[API] ${method} ${url}`);
  }

if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Add a 60-second timeout to handle slow server startup on free tiers (Issue #6)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    // Pass the abort signal to the fetch request
    const response = await fetch(url, { ...options, headers, signal: controller.signal });

    if (!response.ok) {
      // ── SILENT TOKEN REFRESH ON 401 ─────────────────────────
      // Access tokens are short-lived (15 min). When one expires, the backend
      // returns 401. Instead of immediately logging out, attempt a silent
      // refresh via the stored refresh token (30-day lifetime).
      //
      // If refresh succeeds, retry the original request with the new token.
      // Only if the refresh also fails do we log out.
      //
      // This keeps the Admin Dashboard authenticated indefinitely without
      // weakening security — the admin is still authenticated on every API
      // call, just with automatically refreshed credentials.
      if (response.status === 401) {
        const refreshed = await _tryTokenRefresh(BASE_URL, session);
        if (refreshed) {
          // Retry the original request with the fresh token.
          headers['Authorization'] = `Bearer ${session.getToken()}`;
          const retryResponse = await fetch(url, { ...options, headers, signal: controller.signal });
          if (retryResponse.ok) {
            const body = await retryResponse.json();
            return unwrapAdminEnvelope(body);
          }
          // If retry also gets a non-ok status, handle it below.
          return _handleHttpError(retryResponse, session);
        }
        // Refresh failed — session is genuinely expired or revoked.
        if (session) session.clear();
        localStorage.removeItem('admin_user');
        window.location.replace('index.html');
        throw new Error('Session expired. Please log in again.');
      }
      return _handleHttpError(response, session);
    }

    const body = await response.json();
    return unwrapAdminEnvelope(body);

  } catch (error) {
    if (retries > 0) {
      console.warn(`[API] Fetch failed for ${endpoint}. Retrying... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5s before retry
      return apiFetch(endpoint, options, retries - 1);
    }
    console.error(`[API] Fetch failed for ${endpoint} after all retries.`, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Standard envelope compatibility shim ──────────────────────
// The backend standardizes SUCCESS responses to
//   { success:true, data:{...}, meta?:{...} }
// List endpoints use { success:true, data:[...], meta:{ pagination:{...} } }.
// This shim unwraps the inner payload back so every existing admin page reading
// `data.<field>` / `data.rows` / `data.pagination` keeps working identically
// regardless of whether the endpoint has been migrated. Non-envelope responses
// (plain arrays/objects) pass through untouched.
function unwrapAdminEnvelope(body) {
  if (!body || typeof body !== 'object') return body;
  // { success:true, data: {...} } → return the inner data, plus meta merged.
  if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
    const inner = body.data;
    // { success:true, data:[...], meta:{pagination} } → expose
    // { items, rows, pagination } at the top so `data.items` / `data.rows` /
    // `data.pagination` both work.
    if (Array.isArray(inner)) {
      const merged = { items: inner, rows: inner };
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
    }
    if (typeof inner === 'object' && inner !== null) {
      const merged = Object.assign({}, inner);
      if (body.meta && typeof body.meta === 'object') Object.assign(merged, body.meta);
      return merged;
    }
    return inner;
  }
  return body;
}

/**
 * Attempt a silent token refresh using the stored refresh token.
 * Returns true if the refresh succeeded, false otherwise.
 * The new tokens are stored in the session so subsequent requests
 * automatically use the fresh access token.
 */
async function _tryTokenRefresh(baseUrl, session) {
  if (!session) return false;
  const refreshToken = session.getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client': 'admin' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const raw = await res.json();
    const data = (raw && raw.success === true && raw.data) ? raw.data : raw;
    if (data && data.token) {
      session.setTokens(data.token, data.refreshToken || refreshToken);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[API] Token refresh failed:', e.message);
    return false;
  }
}

/**
 * Handle a non-ok HTTP response by parsing the error body and throwing.
 * Shared between the initial request path and the post-refresh retry path.
 */
function _handleHttpError(response, session) {
  // If the retry also returns 401, the session is genuinely invalid.
  if (response.status === 401) {
    if (session) session.clear();
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
    throw new Error('Session expired. Please log in again.');
  }
  // Try to parse error message from backend, otherwise use status text
  return response.json().then(function (errorData) {
    var message = errorData.message || response.statusText;
    throw new Error('API Error: ' + message + ' (Status: ' + response.status + ')');
  }).catch(function (e) {
    if (e && e.message && e.message.indexOf('API Error') === 0) throw e;
    throw new Error('API Error: ' + response.statusText + ' (Status: ' + response.status + ')');
  });
}

// Expose the function globally for other scripts (auth.js, anime.js, etc.)
window.apiRequest = apiFetch;
window.unwrapAdminEnvelope = unwrapAdminEnvelope;
