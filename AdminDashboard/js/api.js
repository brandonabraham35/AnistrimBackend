/**
 * Centralized API fetch function for the Admin Dashboard.
 * - Uses the global getApiBaseUrl() from config.js
 * - Implements a simple retry mechanism for transient network errors.
 * - Throws an error for non-successful responses to be caught by the caller.
 */
async function apiFetch(endpoint, options = {}, retries = 1) {
  // For the Admin Dashboard, always target the production backend to avoid
  // conflicts with local frontend development servers or misconfigurations.
  const BASE_URL = 'https://anistrimbackend.onrender.com';

  const url = `${BASE_URL}${endpoint}`;
  const token = localStorage.getItem('admin_token');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
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

    return await response.json();

  } catch (error) {
    if (retries > 0) {
      console.warn(`[API] Fetch failed for ${endpoint}. Retrying... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5s before retry
      return apiFetch(endpoint, options, retries - 1);
    }
    console.error(`[API] Fetch failed for ${endpoint} after all retries.`, error);
    throw error;
  }
}

// Expose the function globally for other scripts (auth.js, anime.js, etc.)
window.apiRequest = apiFetch;