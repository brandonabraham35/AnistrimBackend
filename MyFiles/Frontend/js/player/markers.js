// Frontend/js/player/markers.js — Phase 4.4 (Item 11) layered Skip Intro/Outro.
//
// Consumes GET /api/watch/markers/:episodeId → { intro: {start,end}, outro: ... }
// Shows "Skip Intro"/"Skip Outro" from start_sec until end_sec + 5, seeks to
// end_sec on tap. If user_preferences.skip_intro_auto is on, auto-seek after
// 2 s with an "Undo" affordance.
(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  function init(opts) {
    var video = opts.video;
    var episodeId = opts.episodeId;
    var getToken = opts.getToken || function () { return localStorage.getItem('token') || ''; };
    var skipButtonEl = opts.skipButtonEl;         // the Skip button container
    var onSkip = opts.onSkip || function (marker) {}; // fired when skipping
    var skipIntroAuto = opts.skipIntroAuto || false;  // from user_preferences
    var autoTimer = null;
    var lastShownKind = null;

    if (!video || !episodeId) return;

    // Fetch + listen on timeupdate.
    loadMarkers().then(function (markers) {
      video.addEventListener('timeupdate', function () {
        var t = video.currentTime;
        checkMarkers(markers, t);
      });
    }).catch(function () { /* no markers available */ });

    function loadMarkers() {
      var token = getToken();
      if (!token) return Promise.resolve({});
      return fetch(API_BASE + '/api/watch/markers/' + episodeId, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) { return (data && data.markers) || {}; });
    }

    function checkMarkers(markers, t) {
      var kindToCheck = ['intro', 'outro', 'recap'];
      for (var i = 0; i < kindToCheck.length; i++) {
        var kind = kindToCheck[i];
        var m = markers[kind];
        if (!m) continue;
        // Show from start_sec until end_sec + 5.
        if (t >= m.start && t <= (m.end + 5)) {
          if (lastShownKind !== kind) {
            showSkipButton(kind, m);
            lastShownKind = kind;
            // Auto-skip if preference is on (after 2 s, with Undo).
            if (skipIntroAuto || m.auto) {
              autoTimer = setTimeout(function () {
                doSkip(m);
              }, 2000);
            }
          }
          return;
        }
      }
      // Not in any marker window → hide.
      if (lastShownKind) hideSkipButton();
      lastShownKind = null;
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }

    function showSkipButton(kind, m) {
      if (!skipButtonEl) return;
      skipButtonEl.style.display = 'block';
      var label = 'Skip ' + (kind === 'intro' ? 'Intro' : kind === 'outro' ? 'Outro' : 'Recap');
      skipButtonEl.textContent = label;
      skipButtonEl.onclick = function () { doSkip(m); };
    }

    function hideSkipButton() {
      if (skipButtonEl) skipButtonEl.style.display = 'none';
    }

    function doSkip(m) {
      if (!video) return;
      video.currentTime = m.end;
      onSkip(m);
      hideSkipButton();
      lastShownKind = null;
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }

    return {
      refresh: function () { loadMarkers(); hideSkipButton(); },
      doSkip: doSkip,
    };
  }

  window.PlayerMarkers = { init: init };
})();