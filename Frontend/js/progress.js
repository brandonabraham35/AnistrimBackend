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
      var req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          var newStore = db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
          newStore.createIndex('byUserEpisode', ['userId', 'episodeId'], { unique: false });
        } else {
          // DB already exists from v1 — only add the ownership index needed for
          // per-account deduplication and safe flushing.
          var existingStore = req.transaction.objectStore(DB_STORE);
          if (!existingStore.indexNames.contains('byUserEpisode')) {
            existingStore.createIndex('byUserEpisode', ['userId', 'episodeId'], { unique: false });
          }
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return idbPromise;
  }

  // ── Account identity for the offline queue ────────────────
  // Records are tagged with the authenticated user's stable numeric id (from
  // the cached user DTO), so a queued write can NEVER be flushed under
  // another account's token. Emails and raw tokens are intentionally avoided.
  function currentUserId() {
    try {
      var auth = window.Auth;
      if (auth) {
        var u = (auth.user && typeof auth.user === 'object') ? auth.user
          : (typeof auth.getUser === 'function' ? auth.getUser() : null);
        if (u && u.id !== undefined && u.id !== null) return String(u.id);
      }
      if (window.State && window.State.user && window.State.user.id !== undefined) {
        return String(window.State.user.id);
      }
      var cached = localStorage.getItem('user');
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.id !== undefined && parsed.id !== null) return String(parsed.id);
      }
    } catch (e) {}
    return null;
  }

  function episodeKeyOf(payload) {
    return String(payload && payload.episodeId !== undefined && payload.episodeId !== null ? payload.episodeId : '');
  }

  function queueWrite(payload) {
    var userId = currentUserId();
    var episodeId = episodeKeyOf(payload);
    // Security: never queue progress without an authenticated account, and
    // never queue a record that has no episode to attach to.
    if (!userId || !episodeId) return Promise.resolve(false);
    return openDB().then(function (db) {
      if (!db) return Promise.resolve(false);
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        var store = tx.objectStore(DB_STORE);
        var idx = store.index('byUserEpisode');
        var getReq = idx.get([userId, episodeId]);
        getReq.onsuccess = function () {
          var existing = getReq.result;
          if (existing && existing.id) {
            // Deduplicate per (user, episode): replace the older queued write
            // with this newest one so a stale heartbeat can never clobber a
            // fresher position and repeated failures do not grow unboundedly.
            store.delete(existing.id);
          }
          store.add({ userId: userId, episodeId: episodeId, payload: payload, queuedAt: Date.now() });
        };
        getReq.onerror = function () {
          // Index lookup failed — fall back to a plain append rather than lose
          // the write entirely.
          try { store.add({ userId: userId, episodeId: episodeId, payload: payload, queuedAt: Date.now() }); } catch (e) {}
        };
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      });
    });
  }

  function deleteQueuedItem(id) {
    if (id === undefined || id === null) return Promise.resolve();
    return openDB().then(function (db) {
      if (!db) return Promise.resolve();
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    });
  }

  var flushInFlight = null;

  function flushQueue() {
    var userId = currentUserId();
    // Security: without an authenticated user we never transmit queued
    // progress and we NEVER delete it — a record may belong to another
    // account and deleting it would silently drop that user's data.
    if (!userId) return Promise.resolve(false);
    if (flushInFlight) return flushInFlight;

    flushInFlight = openDB().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = function () {
          var items = (req.result || []).filter(function (it) {
            return it && String(it.userId) === String(userId);
          });
          resolve(items);
        };
        req.onerror = function () { resolve([]); };
      });
    }).then(function (items) {
      // Send sequentially (insertion order), awaiting each attempt. Delete a
      // record ONLY after the server confirms success; on failure the original
      // record is retained for a later retry — no duplicate copy is created.
      return items.reduce(function (chain, item) {
        return chain.then(function () {
          return sendProgress(item.payload, false, true).then(function (ok) {
            if (ok) return deleteQueuedItem(item.id);
            return undefined;
          });
        });
      }, Promise.resolve());
    }).then(function () {
      flushInFlight = null;
      return true;
    }, function () {
      flushInFlight = null;
      return false;
    });
    return flushInFlight;
  }

  // ── Core send logic ──────────────────────────────────────
  function getToken() {
    return (window.Auth && window.Auth.token) || localStorage.getItem('token') || '';
  }

  function sendProgress(payload, useBeacon, avoidRequeue) {
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
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-Client': 'mobile' },
          body: body,
          keepalive: true,
        }).catch(function () {
          // Keepalive still failed (e.g. offline) — queue it for later when
          // the record did not originate from the queue itself.
          if (!avoidRequeue) queueWrite(payload);
        });
        return Promise.resolve(true);
      } catch (e) { /* fall through */ }
    }

    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-Client': 'mobile' },
      body: body,
    })
      .then(function (res) { return res.ok; })
      .catch(function () {
        // Offline — queue it, unless this send already came from the queue
        // (in that case the original record is retained for a later retry and
        // re-queuing here would create a duplicate).
        if (avoidRequeue) return false;
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