/* eslint-env browser */
/* global google */
// AniStrim Web — auth state + flows (independent from Frontend/)
(function () {
  'use strict';

  var API = window.AniStrimApi;
  var USER_KEY = 'web_user';

  function readUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
  }
  function writeUser(u) {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  }

  function decodeExp(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length === 3) {
        var p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (p && typeof p.exp === 'number') return p.exp * 1000;
      }
    } catch (e) { /* malformed token — ignore */ void e; }
    return null;
  }

  function persistAuth(authData) {
    // authData from login/signup/refresh: { token, refreshToken, user }
    API.setTokens(authData.token, authData.refreshToken || API.getRefreshToken());
    writeUser(authData.user || null);
    notify();
  }

  var listeners = [];
  function notify() {
    var u = currentUser();
    listeners.forEach(function (cb) {
      try { cb(u); } catch (e) { void e; }
    });
  }

  var Auth = {
    get token() { return API.getToken(); },
    get user() { return readUser(); },
    get isLoggedIn() {
      var t = API.getToken();
      if (!t) return false;
      var exp = decodeExp(t);
      if (exp !== null && exp < Date.now()) return false;
      return true;
    },
    get isPremium() {
      var u = readUser();
      if (!u) return false;
      if (u.entitlement) return u.entitlement.isPremium === true;
      return u.isPremium === true;
    },
    get isAdmin() {
      var u = readUser();
      return !!(u && (u.isAdmin === true || u.role === 'admin'));
    },
    save: persistAuth,
    setUser: writeUser,
    clear: function () {
      API.clearTokens();
      writeUser(null);
      notify();
    },
    onChange: function (cb) { listeners.push(cb); return cb; },
  };
  function currentUser() { return readUser(); }

  // ── Login ──────────────────────────────────────────────
  async function login(email, password) {
    var data = await API.login(email, password);
    if (!data || !data.token) throw new Error('Login failed: no token returned.');
    persistAuth(data);
    return data;
  }

  // ── Signup ─────────────────────────────────────────────
  async function signup(payload) {
    var data = await API.signup(payload);
    if (data && data.token) persistAuth(data);
    return data;
  }

  // ── Verify email / OTP ─────────────────────────────────
  async function verifyEmail(email, otp) {
    var data = await API.verifyEmail(email, otp);
    if (data && data.token) persistAuth(data);
    return data;
  }

  // ── Google ─────────────────────────────────────────────
  var gisLoaded = null;
  function loadGIS() {
    if (gisLoaded) return gisLoaded;
    gisLoaded = new Promise(function (resolve, reject) {
      if (typeof google !== 'undefined' && google.accounts) return resolve();
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = function () { if (google && google.accounts) resolve(); else reject(new Error('GIS load failed')); };
      s.onerror = function () { reject(new Error('GIS script failed')); };
      document.head.appendChild(s);
    });
    return gisLoaded;
  }

  async function googleSignIn(intent) {
    var clientIdRes = await API.googleClientId();
    var clientId = clientIdRes && clientIdRes.clientId;
    if (!clientId) throw new Error('Could not load Google client id.');
    await loadGIS();
    return new Promise(function (resolve, reject) {
      var tokenClient;
      try {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'openid email profile',
          callback: function (resp) {
            if (resp && resp.access_token) {
              // Exchange the access token for an id_token via backend OAuth is
              // complex; instead we use the ID token flow when available.
              resolve(resp);
            } else {
              reject(new Error(resp && resp.error_description || 'Google sign-in failed.'));
            }
          },
        });
      } catch (e) { reject(e); }
      tokenClient.requestAccessToken();
    });
  }

  // ── Refresh / me ───────────────────────────────────────
  async function refreshMe() {
    if (!Auth.isLoggedIn) return null;
    try {
      var user = await API.me();
      if (user) { writeUser(user); notify(); }
      return user;
    } catch (e) {
      if (e.status === 401) { Auth.clear(); }
      return null;
    }
  }

  // ── Logout ─────────────────────────────────────────────
  async function logout() {
    try { if (Auth.isLoggedIn) await API.logout(); } catch (e) { /* ignore */ }
    Auth.clear();
    return Promise.resolve();
  }

  window.AniStrimAuth = {
    login: login,
    signup: signup,
    verifyEmail: verifyEmail,
    googleSignIn: googleSignIn,
    googleVerify: function (idToken) { return API.googleVerify(idToken).then(persistAuth); },
    googleSignup: function (idToken) { return API.googleSignup(idToken).then(persistAuth); },
    logout: logout,
    refreshMe: refreshMe,
    state: Auth,
  };
})();