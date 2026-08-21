/* eslint-env browser */
/* global Hls */
// AniStrim Web — the single owner of the browser media/HLS lifecycle.
(function () {
  'use strict';

  var API = window.AniStrimApi;
  var hlsInstance = null;
  var videoEl = null;
  var state = null;
  var onErrorDisplay = null;
  var onStatusDisplay = null;
  var AUTH_REFRESH_EARLY_MS = 15000;
  var SOURCE_READY_TIMEOUT_MS = 30000;

  function notify(message) { if (typeof onErrorDisplay === 'function') onErrorDisplay(message); }
  function status(message) { if (typeof onStatusDisplay === 'function') onStatusDisplay(message); }
  function supportsNativeHls(video) { return !!(video && video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')); }
  function isHlsUrl(url) {
    return /\.m3u8(?:$|\?)/i.test(url || '') ||
      (/\/api\/stream-proxy\//.test(url || '') && !/\.(mp4|webm|ogg)(?:$|\?)/i.test(url || ''));
  }
  function streamUrl(auth) {
    if (!auth) return '';
    if (auth.proxyUrl || auth.streamUrl) return auth.proxyUrl || auth.streamUrl;
    return auth.streams && auth.streams.length && auth.streams[0].url ? auth.streams[0].url : '';
  }
  function absoluteUrl(url) { return /^https?:\/\//i.test(url) ? url : API.API_BASE + url; }
  function addListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    state.listeners.push(function () { target.removeEventListener(event, handler, options); });
  }
  function clearRuntime(clearSource, keepAuthTimer) {
    if (!state) return;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    if (!keepAuthTimer && state.authTimer) clearTimeout(state.authTimer);
    state.listeners.forEach(function (remove) { try { remove(); } catch (e) { /* ignore */ } });
    state.listeners = [];
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e2) { /* ignore */ } hlsInstance = null; }
    if (clearSource && videoEl) {
      try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (e3) { /* ignore */ }
    }
  }
  function destroy() { clearRuntime(true); state = null; videoEl = null; }
  function accessFailure(err) {
    return err && (err.status === 401 || err.status === 403 ||
      err.code === 'AUTH_REQUIRED' || err.code === 'UNAUTHORIZED' ||
      err.code === 'PREMIUM_REQUIRED' || err.code === 'DEVICE_LIMIT_REACHED' || err.code === 'ACCESS_UNKNOWN');
  }
  function errorMessage(err, fallback) {
    if (!err) return fallback || 'Playback could not be started.';
    if (err.code === 'DEVICE_LIMIT_REACHED') return err.message || 'Your device limit has been reached.';
    if (err.code === 'PREMIUM_REQUIRED') return err.message || 'Premium access is required for this episode.';
    if (err.code === 'AUTH_REQUIRED' || err.code === 'UNAUTHORIZED' || err.status === 401) return 'Sign in is required to watch this episode.';
    if (err.code === 'ACCESS_UNKNOWN') return 'This episode is currently unavailable.';
    return err.message || fallback || 'Playback could not be started.';
  }
  function fail(err, fallback) {
    if (!state || state.failed) return;
    state.failed = true;
    if (accessFailure(err)) {
      if (state.callbacks.onAccessDenied) state.callbacks.onAccessDenied(err, null);
    } else if (state.callbacks.onError) {
      err = err || new Error(fallback);
      err.message = errorMessage(err, fallback);
      state.callbacks.onError(err);
    } else notify(errorMessage(err, fallback));
  }
  function applyAuthorization(auth) {
    var owner = state;
    state.auth = auth;
    state.url = absoluteUrl(streamUrl(auth));
    if (!state.url) throw new Error('No playable stream URL returned by the server.');
    if (state.authTimer) clearTimeout(state.authTimer);
    var expiresIn = Number(auth && auth.expiresIn) || 120;
    var delay = Math.max(1000, expiresIn * 1000 - AUTH_REFRESH_EARLY_MS);
    state.authTimer = setTimeout(function () {
      // Keep a fresh concrete URL ready for an HLS/native recovery. Do not
      // restart healthy playback merely because a token is being refreshed.
      if (state !== owner) return;
      API.authorizeStream(state.episodeId).then(function (next) {
        if (state === owner) applyAuthorization(next);
      }).catch(function (err) {
        console.warn('[WebPlayer] stream authorization refresh failed:', errorMessage(err));
      });
    }, delay);
  }
  function playWhenReady() {
    if (!videoEl || !state) return;
    var promise = videoEl.play();
    if (promise && typeof promise.catch === 'function') promise.catch(function () { status('Ready to play. Press play to start.'); });
  }
  function finishReady() {
    if (!state || state.ready) return;
    state.ready = true;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    status('Playing');
    playWhenReady();
    // Preserve the established Web callback contract: a null access error
    // means authorization and source attachment both succeeded.
    if (state.callbacks.onAccessDenied) state.callbacks.onAccessDenied(null, state.auth);
    if (state.callbacks.onReady) state.callbacks.onReady(state.auth);
  }
  function reauthorizeAndReload(reason) {
    if (!state || state.reauthAttempts >= 1 || state.reauthorizing) return false;
    state.reauthAttempts += 1;
    state.reauthorizing = true;
    var owner = state;
    var resumeAt = videoEl && isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    status('Refreshing stream authorization…');
    API.authorizeStream(state.episodeId).then(function (auth) {
      if (state !== owner) return;
      state.reauthorizing = false;
      applyAuthorization(auth);
      attachSource(state.url, resumeAt, reason);
    }).catch(function (err) {
      if (state !== owner) return;
      state.reauthorizing = false;
      fail(err, 'Stream authorization expired. Please try again.');
    });
    return true;
  }
  function hlsError(data) {
    if (!state || !data || !data.fatal) return;
    var details = String(data.details || '');
    var reason = String(data.reason || (data.error && data.error.message) || '');
    var authLike = /401|403|forbidden|unauthori[sz]ed|token|expired/i.test(details + ' ' + reason);
    if (authLike && reauthorizeAndReload('expired authorization')) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (state.networkRecoveries < 1) {
        state.networkRecoveries += 1;
        status('Network interruption. Reconnecting…');
        try { hlsInstance.startLoad(); return; } catch (e) { /* reauthorize below */ }
      }
      if (reauthorizeAndReload('network recovery')) return;
      fail(new Error('The stream could not be recovered after a network error.'));
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && state.mediaRecoveries < 1) {
      state.mediaRecoveries += 1;
      status('Recovering playback…');
      try { hlsInstance.recoverMediaError(); return; } catch (e2) { /* fail below */ }
    }
    fail(new Error('The video stream could not be decoded or is unavailable.'));
  }
  function nativeError() {
    if (!state) return;
    var mediaError = videoEl && videoEl.error;
    var message = mediaError && mediaError.code === 2 ? 'Network error while loading the video.' :
      mediaError && mediaError.code === 3 ? 'The video could not be decoded.' :
      mediaError && mediaError.code === 4 ? 'This stream format is not supported by your browser.' : 'The video source could not be loaded.';
    if (mediaError && mediaError.code === 2 && reauthorizeAndReload('native network error')) return;
    fail(new Error(message));
  }
  function attachSource(url, resumeAt) {
    if (!state || !videoEl) return;
    clearRuntime(false, true);
    state.ready = false;
    state.failed = false;
    status('Loading stream…');
    var owner = state;
    state.readyTimer = setTimeout(function () {
      if (state === owner && !state.ready && !reauthorizeAndReload('source timeout')) fail(new Error('Timed out loading the video stream.'));
    }, SOURCE_READY_TIMEOUT_MS);
    addListener(videoEl, 'loadedmetadata', function () {
      if (resumeAt && isFinite(videoEl.duration) && resumeAt < videoEl.duration) videoEl.currentTime = resumeAt;
      finishReady();
    }, { once: true });
    addListener(videoEl, 'canplay', finishReady, { once: true });
    addListener(videoEl, 'waiting', function () { if (state && state.ready) status('Buffering…'); });
    addListener(videoEl, 'playing', function () { status('Playing'); });
    addListener(videoEl, 'error', nativeError, { once: true });
    if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, finishReady);
      hlsInstance.on(Hls.Events.ERROR, function (event, data) { hlsError(data); });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(videoEl);
    } else {
      videoEl.src = url;
      videoEl.load();
    }
  }
  async function playEpisode(episodeId, video, onAccessDenied, onError, callbacks) {
    destroy();
    videoEl = video;
    state = {
      episodeId: String(episodeId), callbacks: Object.assign({ onAccessDenied: onAccessDenied, onError: onError }, callbacks || {}),
      listeners: [], ready: false, failed: false, networkRecoveries: 0, mediaRecoveries: 0,
      reauthAttempts: 0, reauthorizing: false, readyTimer: null, authTimer: null,
    };
    if (!videoEl) { fail(new Error('Player element is unavailable.')); return null; }
    try {
      status('Authorizing playback…');
      var auth = await API.authorizeStream(state.episodeId);
      if (!state) return null;
      applyAuthorization(auth);
      attachSource(state.url, 0);
      return auth;
    } catch (err) {
      fail(err, 'Stream authorization failed.');
      return null;
    }
  }

  window.AniStrimPlayer = {
    playEpisode: playEpisode,
    destroy: destroy,
    setErrorDisplay: function (fn) { onErrorDisplay = fn; },
    setStatusDisplay: function (fn) { onStatusDisplay = fn; },
    getCurrentEpisodeId: function () { return state && state.episodeId; },
  };
})();
