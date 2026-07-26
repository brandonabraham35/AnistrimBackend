/**
 * config.js — AniStrim Dynamic API Configuration
 * 
 * Detects the runtime environment (Capacitor native vs browser)
 * and returns the correct API base URL.
 * 
 * In Capacitor Android: the WebView origin is https://localhost,
 * so we must use the absolute Render backend URL for all API calls.
 * In browser: same — always use the Render backend.
 * 
 * This file must be loaded BEFORE scrpt.js in every HTML page.
 */

(function() {
  var API_BASE_URL = 'https://anistrimbackend.onrender.com';

  // Detect if we're running inside Capacitor native app
  function isCapacitorNative() {
    return typeof window.Capacitor !== 'undefined' 
        && window.Capacitor.isNative === true;
  }

  // Get the correct API base URL for the current environment
  function getApiBaseUrl() {
    // Always use the absolute Render backend URL.
    // In Capacitor, localhost refers to the device itself, not the server.
    // Using relative paths would fail because the app is served from
    // https://localhost or capacitor://localhost.
    return API_BASE_URL;
  }

  // Expose globally
  window.__API_BASE_URL = API_BASE_URL;
  window.getApiBaseUrl = getApiBaseUrl;
  window.isCapacitorNative = isCapacitorNative;

  // Log environment info for debugging
  console.log('[Config] Environment:', isCapacitorNative() ? 'Capacitor Native' : 'Browser');
  console.log('[Config] API Base URL:', getApiBaseUrl());
})();

