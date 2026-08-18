// Frontend/js/player/core.js — Phase 4.1 player engine.
//
// SINGLE HLS OWNER. Handles hls.js | native HLS detection, source loading,
// manifest parsing, level switching, error bus, and clean destruction.
// No global state — explicit init contract. The page wires:
//
//   core.init({
//     video, onSourceLoaded, onError, onLevels,
//     onManifestParsed, onLevelSwitched
//   })
//
// init() MUST be called ONCE per playback session. It does NOT auto-load a
// source — call loadSource(url) after init to begin playback.
//
// Returns { getHls, getLevels, setQuality, loadSource, destroy }.
(function () {
  'use strict';

  function init(opts) {
    var video = opts.video;
    var onSourceLoaded = opts.onSourceLoaded || function () {};
    var onError = opts.onError || function (err) {};
    var onLevels = opts.onLevels || function (levels) {};
    var onManifestParsed = opts.onManifestParsed || function () {};
    var onLevelSwitched = opts.onLevelSwitched || function (level) {};
    var onFragmentLoaded = opts.onFragmentLoaded || function (info) {};
    var onLevelLoaded = opts.onLevelLoaded || function (info) {};

    if (!video) return null;

    var hls = null;
    var currentLevel = -1;

    function supportsNativeHls() {
      return video && video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl');
    }

    // Load a source: use hls.js when available & native HLS unsupported,
    // else fall back to native. Destroys any previous HLS instance first.
    // Returns the hls.js instance (or null for native).
    function loadSource(url) {
      if (!url) return null;

      // Clean up existing hls instance.
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }

      // Clear video src to stop any existing playback before re-attaching.
      try { video.removeAttribute('src'); video.load(); } catch (e) {}

      if (typeof Hls !== 'undefined' && !supportsNativeHls()) {
        hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          try {
            var levels = hls.levels.map(function (l) { return { height: l.height, bandwidth: l.bitrate }; });
            onLevels(levels);
            onSourceLoaded(hls.levels);
            onManifestParsed();
          } catch (e) {}
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, function (_e, data) {
          if (data && data.level >= 0) {
            onLevelSwitched(data.level);
          }
        });

        hls.on(Hls.Events.LEVEL_LOADED, function (_e, data) {
          onLevelLoaded({ level: data.level, details: data.details });
        });

        hls.on(Hls.Events.FRAG_LOADED, function (_e, data) {
          onFragmentLoaded({ fragSn: data.frag ? data.frag.sn : null, type: data.frag ? data.frag.type : null });
        });

        hls.on(Hls.Events.ERROR, function (event, data) {
          onError({ type: 'hls', data: data, event: event });
        });

        return hls;
      }

      // Native HLS or MP4 — set src directly.
      video.src = url;
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        onSourceLoaded(null);
        onManifestParsed();
      });
      return null;
    }

    function getHls() { return hls; }

    function getLevels() {
      if (hls) {
        try { return hls.levels.map(function (l) { return { height: l.height, bandwidth: l.bitrate }; }); } catch (e) {}
      }
      return [];
    }

    function setQuality(levelIndex) {
      currentLevel = levelIndex;
      if (hls) { try { hls.currentLevel = levelIndex; } catch (e) {} }
    }

    function destroy() {
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      if (video) { try { video.removeAttribute('src'); video.load(); } catch (e) {} }
    }

    return {
      getHls: function () { return hls; },
      getLevels: getLevels,
      setQuality: setQuality,
      loadSource: loadSource,
      destroy: destroy,
    };
  }

  window.PlayerCore = { init: init };
})();
