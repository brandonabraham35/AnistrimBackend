// Frontend/js/progress.js — Phase 3 client-side watch progress save policy.
//
// Save on:
//   • every 15 s while playing (only if position moved ≥5 s)
//   • pause
//   • seeked (debounced 2 s)
//   • ended
//   • visibilitychange→hidden
//   • pagehide via navigator.sendBeacon
//
// Queue writes in IndexedDB when offline and flush on reconnect — device-
// independent progress that survives an Android app kill.
//
// On load, `t` in the URL wins, else server position, else 0; if percent ≥ 95
// offer "Start over".

(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var DB_NAME = 'anistrim-progress';
  var DB_STORE = 'pending';
  var SAVE_INTERVAL = 15000; // 15 s
  var MIN_MOVE = 5;          // 5 s position change required
  var SEEK_DEBOUNCE = 2000;  // 2 s

  var lastSavedPosition = null;
  var saveTimer = null;
  var seekTimer = null;

  // ── IndexedDB queue (offline persistence) ────────────────
  var idbPromise = null;

  function openDB() {
    if (idbPromise) return idbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    idbPromise = new Promise(function (resolve) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return idbPromise;
  }

  function queueWrite(payload) {
    return openDB().then(function (db) {
      if (!db) return Promise.resolve();
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).add({ payload: payload, ts: Date.now() });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    });
  }

  function flushQueue() {
    return openDB().then(function (db) {
      if (!db) return Promise.resolve();
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        var store = tx.objectStore(DB_STORE);
        var req = store.getAll();
        req.onsuccess = function () {
          var items = req.result || [];
          items.forEach(function (item) {
            sendProgress(item.payload);
            store.delete(item.id);
          });
          resolve();
        };
        req.onerror = function () { resolve(); };
      });
    });
  }

  // ── Core send logic ──────────────────────────────────────
  function getToken() {
    return (window.Auth && window.Auth.token) || localStorage.getItem('token') || '';
  }

  function sendProgress(payload, useBeacon) {
    var token = getToken();
    if (!token) return Promise.resolve(false);

    var url = API_BASE + '/api/watch/progress';
    var body = JSON.stringify(payload);

    // Offline detection: use sendBeacon for pagehide, fetch otherwise.
    if (useBeacon && navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'application/json' });
      // Beacon can't set Authorization header — append token via query? Not
      // supported by our API. Fall back to fetch with keepalive instead.
      try {
        // sendBeacon can't send custom headers; use fetch with keepalive.
        fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: body,
          keepalive: true,
        });
        return Promise.resolve(true);
      } catch (e) { /* fall through */ }
    }

    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: body,
    })
      .then(function (res) { return res.ok; })
      .catch(function () {
        // Offline — queue it.
        return queueWrite(payload).then(function () { return true; });
      });
  }

  // ── Public save API ──────────────────────────────────────
  // payload: { episodeId, positionSec, durationSec, event }
  function save(payload) {
    if (!payload || !payload.episodeId) return;

    // Only save if position moved ≥5 s since last save (for heartbeats).
    if (payload.event === 'heartbeat') {
      var movedEnough = lastSavedPosition === null ||
        Math.abs((payload.positionSec || 0) - lastSavedPosition) >= MIN_MOVE;
      if (!movedEnough) return;
    }

    lastSavedPosition = payload.positionSec || 0;
    sendProgress(payload);
  }

  // Save on heartbeat with throttling (every 15 s).
  function heartbeat(episodeId, positionSec, durationSec) {
    if (!episodeId) return;
    save({ episodeId, positionSec, durationSec, event: 'heartbeat' });
  }

  function pause(episodeId, positionSec, durationSec) {
    if (!episodeId) return;
    save({ episodeId, positionSec, durationSec, event: 'pause' });
  }

  function seeked(episodeId, positionSec, durationSec) {
    if (!episodeId) return;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () {
      save({ episodeId, positionSec, durationSec, event: 'seek' });
    }, SEEK_DEBOUNCE);
  }

  function ended(episodeId, positionSec, durationSec) {
    if (!episodeId) return;
    save({ episodeId, positionSec, durationSec, event: 'ended' });
  }

  // ── Auto-save interval (heartbeats while playing) ────────
  function startAutoSave(getState) {
    stopAutoSave();
    saveTimer = setInterval(function () {
      try {
        var state = getState();
        if (state && !state.paused && !state.ended) {
          heartbeat(state.episodeId, state.currentTime, state.duration);
        }
      } catch (e) {}
    }, SAVE_INTERVAL);
  }

  function stopAutoSave() {
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
  }

  // ── Page hidden / unload ─────────────────────────────────
  function onVisibilityChange(getState) {
    if (document.visibilityState === 'hidden') {
      try {
        var state = getState();
        if (state) pause(state.episodeId, state.currentTime, state.duration);
      } catch (e) {}
    }
  }

  function onPageHide(getState) {
    try {
      var state = getState();
      if (state) {
        sendProgress({ episodeId: state.episodeId, positionSec: state.currentTime, durationSec: state.duration, event: 'exit' }, true);
      }
    } catch (e) {}
  }

  // ── Attach listeners ─────────────────────────────────────
  function init(getState) {
    if (!getState || typeof getState !== 'function') {
      console.error('[Progress] init requires a getState function.');
      return;
    }
    document.addEventListener('visibilitychange', function () { onVisibilityChange(getState); });
    window.addEventListener('pagehide', function () { onPageHide(getState); });
    window.addEventListener('online', flushQueue);
    // Flush on init.
    flushQueue();
  }

  window.Progress = {
    save: save,
    heartbeat: heartbeat,
    pause: pause,
    seeked: seeked,
    ended: ended,
    startAutoSave: startAutoSave,
    stopAutoSave: stopAutoSave,
    flushQueue: flushQueue,
    init: init,
  };
})();