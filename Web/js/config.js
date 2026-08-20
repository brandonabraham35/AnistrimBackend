/* eslint-env browser */
// AniStrim Web — environment config (independent from Frontend/)
(function () {
  'use strict';

  var API_BASE = 'https://anistrimbackend.onrender.com';

  function getApiBaseUrl() {
    var override = (window.__ANISTRIM_API || '').trim();
    if (override) return override.replace(/\/+$/, '');
    return API_BASE;
  }

  window.AniStrimConfig = {
    API_BASE: API_BASE,
    getApiBaseUrl: getApiBaseUrl,
    APP_NAME: 'AniStrim',
  };
})();