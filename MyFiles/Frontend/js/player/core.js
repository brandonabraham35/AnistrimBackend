// Frontend/js/player/core.js — Phase 4.1 player engine.
//
// Handles hls.js | native HLS detection, source loading, and the error bus.
// No global state — explicit init contract. The page wires:
//
//   core.init({
//     video, sourceUrl, episodeId, onSourceLoaded, onError, onLevels,
//     getToken, isHlsUrl
//   })
//
// Returns { getHls, getLevels, setQuality, setSource, destroy }.
(function () {
  'use strict';

  function init(opts) {
    var video = opts.video;
    var sourceUrl = opts.sourceUrl;
    var episodeId = opts.episodeId;
    var onSourceLoaded = opts.onSourceLoaded || function () {};
    var onError = opts.onError || function (err) {};
    var onLevels = opts.onLevels || function (levels) {};
    var getToken = opts.getToken || function () { return localStorage.getItem('token') || ''; };
    var isHlsUrl = opts.isHlsUrl || function (url) {
      return /\.m3u8|application\/vnd\.apple\.mpegurl|application\/x-mpegURL/i.test(url) ||
        (video.canPlayType && !video.canPlayType('application/vnd.apple.mpegurl'));
    };

    if (!video) return null;

    var hls = null;
    var currentLevel = -1;

    function supportsNativeHls() {
      return video && video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl');
    }

    // Load a source: use hls.js when available & native HLS unsupported,
    // else fall back to native.
    function loadSource(url) {
      sourceUrl = url || sourceUrl;
      if (!sourceUrl) return;

      // Clean up existing hls instance.
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }

      var token = getToken();
      var headers = {};
      if (token) { headers['Authorization'] = 'Bearer ' + token; }

      if (typeof Hls !== 'undefined' && !supportsNativeHls()) {
        hls = new Hls({ xhrSetup: function (xhr) { xhr.open('GET', url, true); } });
        hls.loadSource(sourceUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          try {
            var levels = hls.levels.map(function (l) { return { height: l.height, bandwidth: l.bitrate }; });
            onLevels(levels);
            onSourceLoaded(hls.levels);
          } catch (e) {}
        });

        hls.on(Hls.Events.ERROR, function (event, data) {
          onError({ type: 'hls', data: data });
        });

        // Expose to resilience via the error bus.
        if (opts.errorBus) { opts.errorBus.hls = hls; }
        return hls;
      }

      // Native HLS.
      video.src = sourceUrl;
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        var levels = [];
        try {
          var lvls = video.audioTracks || [];
          onLevels(levels);
        } catch (e) {}
        onSourceLoaded(null);
      });
      return null;
    }

    function getLevels() {
      if (hls) {
        try { return hls.levels.map(function (l) { return { height: l.height, bandwidth: l.bitrate }; }); } catch (e) {}
      }
      return [];
    }

    function setQuality(levelIndex) {
      currentLevel = levelIndex;
      if (hls) { try { hls.currentLevel = levelIndex; } catch (e) {} }
      if (levelIndex === -1 && hls) { try { hls.currentLevel = -1; } catch (e) {} }
    }

    function setSource(url) { loadSource(url); }

    function destroy() {
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      if (video) { try { video.removeAttribute('src'); video.load(); } catch (e) {} }
    }

    // Load the initial source.
    loadSource(sourceUrl);

    return {
      getHls: function () { return hls; },
      getLevels: getLevels,
      setQuality: setQuality,
      setSource: setSource,
      destroy: destroy,
    };
  }

  window.PlayerCore = { init: init };
})();