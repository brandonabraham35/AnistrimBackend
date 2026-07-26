// File Path: AdminDashboard/js/api.js
// Cross-platform API client — uses window.getApiBaseUrl() for Capacitor/browser parity

// Resolve base API URL: try runtime helper first, then localStorage override, then default
(function() {
  function resolveApiBase() {
    // 1. Use the centralized getApiBaseUrl() from config.js if available
    if (typeof window.getApiBaseUrl === 'function') {
      return window.getApiBaseUrl() + '/api';
    }
    // 2. Allow localStorage override (for testing)
    if (localStorage.getItem('api_base')) {
      return localStorage.getItem('api_base');
    }
    // 3. Default fallback
    return 'https://anistrimbackend.onrender.com/api';
  }

  window.API_BASE = resolveApiBase();
  console.log('[API] Base URL:', window.API_BASE);
})();

async function apiRequest(endpoint, options = {}) {
    // Re-resolve base URL each call so config.js changes take effect without page reload
    const base = (typeof window.getApiBaseUrl === 'function')
      ? window.getApiBaseUrl() + '/api'
      : (localStorage.getItem('api_base') || window.API_BASE || 'https://anistrimbackend.onrender.com/api');

    const token = localStorage.getItem('admin_token');
    const headers = {
        'Accept': 'application/json',
        ...options.headers
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }

    // Retry configuration
    const maxRetries = options._retries || 1;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${base}${endpoint}`, {
            ...options,
            headers
        });

        if (response.status === 204) return null;

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : { message: await response.text() || `Request failed (${response.status})` };

        // A 401 means the credential is missing, expired, or invalid. A 403 means
        // the current authenticated account is not permitted for this one action;
        // clearing a valid token on 403 caused the observed dashboard login loop.
        if (response.status === 401) {
            localStorage.removeItem('admin_token');
            localStorage.removeItem('admin_user');
            const currentPath = window.location.pathname;
            if (!currentPath.endsWith('index.html') && currentPath !== '/' && !currentPath.endsWith('/')) {
                window.location.replace('index.html');
            }
            throw new Error(data?.message || 'Your session has expired. Please log in again.');
        }

        if (!response.ok) {
            throw new Error(data?.message || 'API Request failed');
        }

        return data;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          console.warn(`[API] Retry ${attempt + 1}/${maxRetries} for ${endpoint}:`, error.message);
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }

    console.error(`[API] Error [${endpoint}]:`, lastError);
    throw lastError;
}

window.apiRequest = apiRequest;
