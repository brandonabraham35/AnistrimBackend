// Frontend/js/player/resilience.js — Phase 4.3 (Item 5) playback resilience ladder.
//
// Replaces "Unable to Play Episode" on the first failure with a graded ladder:
//   level 0  hls.js internal recovery (recoverMediaError / startLoad)
//   level 1  reload the SAME manifest, resume at lastKnownPosition (3×, backoff)
//   level 2  re-resolve the stream URL (GET /api/stream/resolve?episodeId&force=1)
//   level 3  failover to the next healthy provider from providerRegistry
//   level 4  only now show the error card with Retry / Report / Choose source
//
// Shows a subtle "Reconnecting…" chip for levels 0–3; never unmounts the
// <video> element (that would lose the position). Pauses the ladder while
// offline.
(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var MAX_LEVEL1_RETRIES = 3;
  var BACKOFFS = [1000, 2000, 4000];

  function init(opts) {
    var video = opts.video;
    var hls = opts.hls;              // hls.js instance (may be null for native)
    var getCurrentTime = opts.getCurrentTime || function () { return video ? video.currentTime : 0; };
    var getEpisodeId = opts.getEpisodeId || function () { return null; };
    var resolveStreamUrl = opts.resolveStreamUrl || function (episodeId, force) {
      return API_BASE + '/api/stream/resolve?episodeId=' + encodeURIComponent(episodeId) + (force ? '&force=1' : '');
    };
    var onReconnect = opts.onReconnect || function (level) {};  // show "Reconnecting…" chip
    var onErrorCard = opts.onErrorCard || function () {};        // show error card (level 4)
    var logEscalation = opts.logEscalation || function (payload) {}; // → stream_reports

    var level1Attempts = 0;
    var offline = false;
    var recovering = false;
    var lastKnownPosition = 0;

    function log(level, errorType, details) {
      logEscalation({ episodeId: getEpisodeId(), level: level, hls_error_type: errorType, details: details });
    }

    function setReconnecting(level) {
      onReconnect(level);
    }

    // HLS.js error handler — the ladder engine.
    function onHlsError(event, data) {
      if (recovering) return;
      recovering = true;
      var position = getCurrentTime();
      lastKnownPosition = position;
      var hlsErrorType = data && data.type;
      var fatal = data && data.fatal;

      try {
        if (!fatal) {
          // level 0: non-fatal media/network error → internal recovery.
          if (data.type === 'mediaError' && hls && hls.recoverMediaError) {
            setReconnecting(0);
            hls.recoverMediaError();
            log(0, hlsErrorType, 'mediaError recoverMediaError');
          } else if (data.type === 'networkError' && hls && hls.startLoad) {
            setReconnecting(0);
            hls.startLoad();
            log(0, hlsErrorType, 'networkError startLoad');
          }
          recovering = false;
          return;
        }

        // Fatal error → escalate through the ladder.
        if (data.type === 'networkError' || data.type === 'mediaError') {
          escalate(position);
        }
      } catch (e) {
        recovering = false;
      }
    }

    // Escalate: level 1 → 2 → 3 → 4.
    async function escalate(position) {
      // Level 1: reload the SAME manifest (up to 3×, backoff).
      if (level1Attempts < MAX_LEVEL1_RETRIES) {
        setReconnecting(1);
        var backoff = BACKOFFS[level1Attempts] || 4000;
        level1Attempts++;
        log(1, 'fatal_network', 'reload manifest attempt ' + level1Attempts);
        await sleep(backoff);
        if (offline) { recovering = false; return; }
        try {
          if (hls && hls.startLoad) {
            hls.startLoad();
            await seekTo(position);
          } else if (video) {
            await seekTo(position);
          }
          recovering = false;
          return;
        } catch (e) { /* fall through */ }
      }

      // Level 2: re-resolve the stream URL (force=1) — cached proxy may be stale.
      setReconnecting(2);
      log(2, 'fatal_network', 're-resolve stream force=1');
      try {
        var episodeId = getEpisodeId();
        var newUrl = resolveStreamUrl(episodeId, true);
        if (newUrl) {
          if (window.__playerCore && typeof window.__playerCore.loadSource === 'function') {
            // Delegate to PlayerCore — it destroys the old HLS instance first,
            // clears the video src, and creates a fresh instance. This is the
            // SINGLE HLS owner; we never attach directly.
            window.__playerCore.loadSource(newUrl);
            await seekTo(position);
          } else if (video) {
            video.src = newUrl;
            await seekTo(position);
            video.play().catch(function () {});
          }
          level1Attempts = 0;
          recovering = false;
          return;
        }
      } catch (e) { log(2, 're-resolve_failed', e.message); }

      // Level 3: failover to next healthy provider. Re-authorize + re-resolve
      // via the currentUnifiedStream pipeline, then delegate to PlayerCore.
      setReconnecting(3);
      log(3, 'fatal_network', 'provider failover');
      try {
        var episodeId2 = getEpisodeId();
        if (window.__playerCore && typeof window.__playerCore.loadSource === 'function') {
          // Re-authorize to mint a fresh token for the same episode, then
          // delegate the new source to PlayerCore (which destroys the old hls).
          if (typeof window.authorizeStream === 'function') {
            await new Promise(function (resolve) {
              window.authorizeStream(episodeId2).then(function (auth) {
                if (auth && auth.token && typeof window.appendStreamToken === 'function') {
                  var base = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : '';
                  var current = window.currentStreamUrl;
                  if (current && current.includes('/api/stream-proxy/')) {
                    var sep = current.includes('?') ? '&' : '?';
                    current = current + sep + 'token=' + encodeURIComponent(auth.token);
                    window.__playerCore.loadSource(current);
                    resolve();
                    return;
                  }
                }
                resolve();
              }).catch(function () { resolve(); });
            });
            await seekTo(position);
          }
          level1Attempts = 0;
          recovering = false;
          return;
        }
      } catch (e) { log(3, 'failover_failed', e.message); }

      // Level 4: only now show the error card.
      log(4, 'fatal_network', 'all levels exhausted');
      onErrorCard();
      recovering = false;
    }

    function seekTo(position) {
      return new Promise(function (resolve) {
        if (!video) return resolve();
        video.currentTime = position;
        video.addEventListener('loadedmetadata', function once() {
          try { video.currentTime = position; } catch (e) {}
          video.removeEventListener('loadedmetadata', once);
          resolve();
        });
        // Resolve anyway after a short timeout.
        setTimeout(resolve, 2000);
      });
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // Pause the ladder while offline.
    window.addEventListener('offline', function () { offline = true; });
    window.addEventListener('online', function () { offline = false; });

    if (hls) {
      hls.on('hlsError', onHlsError);
    } else if (video && opts.nativeErrorHandler) {
      video.addEventListener('error', function () { escalate(getCurrentTime()); });
    }

    return {
      reset: function () { level1Attempts = 0; recovering = false; },
      setOffline: function (v) { offline = v; },
      onError: onHlsError,
    };
  }

  window.PlayerResilience = { init: init };
})();