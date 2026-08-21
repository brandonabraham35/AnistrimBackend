/* eslint-env browser */
/* global Hls */
// AniStrim Web — media player (independent from Frontend/)
(function () {
  'use strict';

  var API = window.AniStrimApi;
  var hlsInstance = null;
  var videoEl = null;
  var currentEpisodeId = null;
  var onErrorDisplay = null; // set by UI layer

  function supportsNativeHls(video) {
    return video && video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl');
  }

  function notify(msg) {
    if (typeof onErrorDisplay === 'function') {
      try { onErrorDisplay(msg); } catch (e) { void e; }
    } else {
      console.warn('[WebPlayer]', msg);
    }
  }

  function destroy() {
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) { /* ignore */ } hlsInstance = null; }
    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      } catch (e) { /* ignore */ }
    }
    videoEl = null;
  }

  function loadSource(url, video) {
    if (!url || !video) return;
    destroy();
    videoEl = video;
    if (typeof Hls !== 'undefined' && !supportsNativeHls(video)) {
      try {
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.ERROR, function (e, data) {
          if (data && data.fatal) {
            notify('Playback error. Trying to recover...');
            try {
              if (data.type === 'networkError') hlsInstance.startLoad();
              else if (data.type === 'mediaError') hlsInstance.recoverMediaError();
              else { hlsInstance.destroy(); hlsInstance = null; }
            } catch (err) { /* ignore */ }
          }
        });
        return;
      } catch (e) { /* fall back to native below */ }
    }
    video.src = url;
  }

  // Authorize then play.  The API is authoritative for entitlement, device
  // limits, and guest access; this layer only passes its decision to the UI.
  async function playEpisode(episodeId, video, onAccessDenied, onError) {
    currentEpisodeId = episodeId;
    try {
      var auth = await API.authorizeStream(episodeId);
      var url = auth && (auth.streamUrl || auth.proxyUrl);
      if (auth && auth.streams && auth.streams.length && auth.streams[0].url) url = auth.streams[0].url;
      if (!url) throw new Error('No playable stream URL returned.');
      if (!/^https?:\/\//.test(url)) {
        url = API.API_BASE + url;
      }
      loadSource(url, video);
      if (onAccessDenied) onAccessDenied(null, auth);
      return auth;
    } catch (err) {
      // Keep authorization failures distinct from HLS/provider failures.  In
      // particular, never retry an AUTH_REQUIRED, PREMIUM_REQUIRED, or device
      // limit response from the browser.
      if (err.status === 401 || err.status === 403 ||
          err.code === 'AUTH_REQUIRED' || err.code === 'PREMIUM_REQUIRED' ||
          err.code === 'DEVICE_LIMIT_REACHED' || err.code === 'ACCESS_UNKNOWN') {
        if (onAccessDenied) onAccessDenied(err, null);
      } else if (onError) onError(err);
      return null;
    }
  }

  window.AniStrimPlayer = {
    playEpisode: playEpisode,
    loadSource: loadSource,
    destroy: destroy,
    setErrorDisplay: function (fn) { onErrorDisplay = fn; },
  };
})();
