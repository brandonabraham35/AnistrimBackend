// Frontend/js/player/ads.js — Phase 8.3 player ad rules (non-negotiable).
//
// • Ads never call video.pause() on content already playing; pre-roll resolves
//   BEFORE the content source loads; mid-roll only at an outro marker or a
//   natural pause the user initiated.
// • If the ad SDK fails or takes >3 s, skip the ad and start content. Ad
//   failure must never surface as a playback error.
// • Premium users: /api/ads/policy returns empty AND ad modules are never
//   initialised.
// • Log impressions/failures to POST /api/ads/event for the health dashboard.
(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';
  var AD_TIMEOUT_MS = 3000; // 3 s — if ad fails/times out, skip to content.

  function getToken() {
    return (window.Auth && window.Auth.token) || localStorage.getItem('token') || '';
  }

  // Fetch the server-administrated policy. Premium → { ads: [] }.
  function fetchPolicy(context) {
    var token = getToken();
    if (!token) return Promise.resolve({ ads: [], session: null });
    return fetch(API_BASE + '/api/ads/policy?context=' + encodeURIComponent(context || 'player'), {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    })
      .then(function (r) { return r.json().catch(function () { return { ads: [], session: null }; }); })
      .catch(function () { return { ads: [], session: null }; });
  }

  function logEvent(provider, slot, event, context, detail) {
    var token = getToken();
    if (!token) return;
    fetch(API_BASE + '/api/ads/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ provider: provider || 'admob', slot: slot || null, event: event, context: context || 'player', detail: detail || null }),
    }).catch(function () {});
  }

  /**
   * Resolve the pre-roll ad BEFORE content loads.
   * Returns a promise that resolves to { ad, served } — if no ad, policy empty,
   * or the ad SDK fails/times out, it resolves with { served:false } and content
   * starts. Ad failure NEVER surfaces as a playback error.
   * @param {object} opts { context, video (optional, for mid-roll), onError }
   */
  function init(opts) {
    var context = opts.context || 'player';
    var video = opts.video || null;
    var $ = opts.$ || null;

    return {
      // Pre-roll: call before setting the content source.
      preRoll: function () {
        return fetchPolicy(context).then(function (policy) {
          // Premium or empty → no ads.
          if (!policy || !policy.ads || !policy.ads.length) return { served: false };
          var preRoll = policy.ads.find(function (a) { return a.slot === 'pre_roll'; });
          if (!preRoll) return { served: false };

          // Attempt to show the ad with a 3 s timeout. Never block content on it.
          return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
              if (done) return; done = true;
              logEvent(preRoll.provider, 'pre_roll', 'timeout', context, 'ad took too long');
              resolve({ served: false });
            }, AD_TIMEOUT_MS);

            // If there is a real ad-slot element, show it. On success/fail, resolve.
            if ($ && typeof $ === 'function') {
              try {
                $().then(function () {
                  if (done) return; done = true; clearTimeout(timer);
                  logEvent(preRoll.provider, 'pre_roll', 'impression', context);
                  resolve({ served: true, ad: preRoll });
                }).catch(function (err) {
                  if (done) return; done = true; clearTimeout(timer);
                  logEvent(preRoll.provider, 'pre_roll', 'fail', context, err && err.message);
                  resolve({ served: false });
                });
              } catch (e) {
                if (done) return; done = true; clearTimeout(timer);
                resolve({ served: false });
              }
            } else {
              // No ad SDK wired — skip the ad (never block content).
              if (done) return; done = true; clearTimeout(timer);
              resolve({ served: false });
            }
          });
        }).catch(function () {
          // Policy fetch failed — serve no ad, start content.
          return { served: false };
        });
      },

      // Mid-roll: only at an outro marker or a natural pause the user initiated.
      // The caller passes a `shouldPlay` test — we never auto-pause playing content.
      midRoll: function () {
        if (!video) return Promise.resolve({ served: false });
        return fetchPolicy(context).then(function (policy) {
          if (!policy || !policy.ads || !policy.ads.length) return { served: false };
          // Never pause already-playing content. Only show if user paused (or outro).
          if (!video.paused) return { served: false };
          return { served: false }; // mid-roll placeholders — SDK integration not wired.
        });
      },

      // Premium users never initialise ad SDK — call this after preRoll; if it
      // returns empty, skip any SDK bootstrap.
      shouldServe: function () {
        return fetchPolicy(context).then(function (p) { return p && p.ads && p.ads.length > 0; });
      },

      // Expose for the player to log skip as well.
      logEvent: logEvent,
    };
  }

  window.PlayerAds = { init: init, fetchPolicy: fetchPolicy };
})();