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
  const token = localStorage.getItem('admin_token');
  const headers = { ...options.headers };
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
      // If the token is expired or invalid, the API will return a 401.
      // We should clear the session and redirect to the login page.
      if (response.status === 401) {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        window.location.replace('index.html');
        // Throw an error to prevent the rest of the code from executing
        throw new Error('Session expired. Please log in again.');
      }
      // Try to parse error message from backend, otherwise use status text
      let message = response.statusText;
      try {
        const errorData = await response.json();
        message = errorData.message || message;
      } catch (e) {
        // Not a JSON response, stick with status text
      }
      throw new Error(`API Error: ${message} (Status: ${response.status})`);
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

// Expose the function globally for other scripts (auth.js, anime.js, etc.)
window.apiRequest = apiFetch;
window.unwrapAdminEnvelope = unwrapAdminEnvelope;
