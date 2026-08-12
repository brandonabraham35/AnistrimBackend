// player-controls.js — AniStrim player control system
// ─────────────────────────────────────────────────────────────
// Defines ALL player helper functions that watch.js references but which
// were previously missing. Loaded BEFORE watch.js so the functions are
// available globally when watch.js calls them.
//
// These are the root-cause fixes for:
//   - "fmtTime is not defined"
//   - "initProgressBar is not defined"
//   - "updateProgressBarUI is not defined"
//   - "updateBufferedUI is not defined"
//   - "updateTimeDisplay is not defined"
//   - "updateVolumeIcon is not defined"
//   - "setVolume is not defined"
//   - "adjustVolume is not defined"
//   - "toggleMute is not defined"
//   - "toggleFullscreen is not defined"
//   - "togglePip is not defined"
//   - "isPipSupported is not defined"
//   - "flashCenterIndicator is not defined"
//   - "deleteBlobFromIndexedDB is not defined"
//
// Each function is defensive: if a DOM element is missing, it no-ops
// rather than throwing, so a failure in one subsystem never breaks playback.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  fmtTime — format seconds as HH:MM:SS or MM:SS
  // ════════════════════════════════════════════════════════════
  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    seconds = Math.floor(seconds);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    var mStr = String(m);
    var sStr = String(s).padStart(2, '0');
    if (h > 0) {
      return String(h) + ':' + String(m).padStart(2, '0') + ':' + sStr;
    }
    return mStr + ':' + sStr;
  }

  // ════════════════════════════════════════════════════════════
  //  Volume helpers
  // ════════════════════════════════════════════════════════════
  function getVideo() {
    return document.getElementById('animePlayer');
  }

  function updateVolumeIcon() {
    var video = getVideo();
    var icon = document.getElementById('volume-icon');
    if (!video || !icon) return;
    if (video.muted || video.volume === 0) {
      icon.innerHTML = '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
    } else if (video.volume < 0.5) {
      icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    } else {
      icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
  }

  function setVolume(value) {
    var video = getVideo();
    if (!video) return;
    var v = parseFloat(value);
    if (isNaN(v)) v = 1;
    v = Math.max(0, Math.min(1, v));
    video.volume = v;
    video.muted = v === 0;
    var slider = document.getElementById('volume-slider');
    if (slider) slider.value = String(v);
    updateVolumeIcon();
  }

  function adjustVolume(delta) {
    var video = getVideo();
    if (!video) return;
    var v = video.muted ? 0 : video.volume;
    v = Math.max(0, Math.min(1, v + delta));
    video.volume = v;
    video.muted = v === 0;
    var slider = document.getElementById('volume-slider');
    if (slider) slider.value = String(v);
    updateVolumeIcon();
  }

  function toggleMute() {
    var video = getVideo();
    if (!video) return;
    video.muted = !video.muted;
    if (video.muted) {
      video.volume = 0;
    } else if (video.volume === 0) {
      video.volume = 1;
    }
    var slider = document.getElementById('volume-slider');
    if (slider) slider.value = String(video.muted ? 0 : video.volume);
    updateVolumeIcon();
  }

  // ════════════════════════════════════════════════════════════
  //  Fullscreen
  // ════════════════════════════════════════════════════════════
  function toggleFullscreen() {
    var container = document.getElementById('player-wrap') || document.getElementById('player-container');
    if (!container) return;
    if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function() {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
    } else {
      var req = container.requestFullscreen || container.webkitRequestFullscreen || container.mozRequestFullScreen || container.msRequestFullscreen;
      if (req) req.call(container).catch(function() {});
    }
    // Ensure controls re-appear after fullscreen change.
    setTimeout(function() { if (typeof showControls === 'function') showControls(); }, 100);
  }

  // ════════════════════════════════════════════════════════════
  //  Picture-in-Picture
  // ════════════════════════════════════════════════════════════
  function isPipSupported() {
    var video = getVideo();
    return !!(video && document.pictureInPictureEnabled && video.requestPictureInPicture);
  }

  function togglePip() {
    var video = getVideo();
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(function() {});
    } else if (video.requestPictureInPicture) {
      video.requestPictureInPicture().catch(function() {});
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Center action indicator (play/pause/seek flash)
  // ════════════════════════════════════════════════════════════
  function flashCenterIndicator(iconInnerHtml, label) {
    var indicator = document.getElementById('center-indicator');
    if (!indicator) return;
    var svg = document.getElementById('center-indicator-svg');
    var labelEl = document.getElementById('center-indicator-label');
    if (svg && iconInnerHtml) svg.innerHTML = iconInnerHtml;
    if (labelEl) labelEl.textContent = label || '';
    indicator.classList.remove('flash');
    // Force reflow so the animation restarts.
    void indicator.offsetWidth;
    indicator.classList.add('flash');
  }

  // ════════════════════════════════════════════════════════════
  //  Progress bar system
  // ════════════════════════════════════════════════════════════
  var progressScrubbing = false;

  function updateProgressBarUI(video) {
    if (!video) return;
    var played = document.getElementById('progress-played');
    var thumb = document.getElementById('progress-thumb');
    var current = document.getElementById('current-time');
    var remaining = document.getElementById('remaining-time');
    var dur = video.duration;

    if (played) {
      played.style.width = (isFinite(dur) && dur > 0 ? (video.currentTime / dur) * 100 : 0) + '%';
    }
    if (thumb) {
      thumb.style.left = (isFinite(dur) && dur > 0 ? (video.currentTime / dur) * 100 : 0) + '%';
    }
    if (current) current.textContent = fmtTime(video.currentTime);
    if (remaining && isFinite(dur) && dur > 0) {
      remaining.textContent = '-' + fmtTime(Math.max(0, dur - video.currentTime));
    }
  }

  function updateBufferedUI(video) {
    if (!video) return;
    var bufferEl = document.getElementById('progress-buffer');
    if (!bufferEl) return;
    var dur = video.duration;
    if (!isFinite(dur) || dur <= 0) { bufferEl.style.width = '0%'; return; }
    var buffered = video.buffered;
    var end = 0;
    if (buffered && buffered.length > 0) {
      end = buffered.end(buffered.length - 1);
    }
    bufferEl.style.width = Math.min(100, (end / dur) * 100) + '%';
  }

  function updateTimeDisplay(video) {
    if (!video) return;
    var current = document.getElementById('current-time');
    var duration = document.getElementById('duration-time');
    if (current) current.textContent = fmtTime(video.currentTime);
    if (duration) duration.textContent = isFinite(video.duration) ? fmtTime(video.duration) : '0:00';
    updateProgressBarUI(video);
  }

  function seekToPercent(percent) {
    var video = getVideo();
    if (!video || !isFinite(video.duration) || video.duration <= 0) return;
    var pct = Math.max(0, Math.min(100, percent));
    video.currentTime = (pct / 100) * video.duration;
    updateProgressBarUI(video);
  }

  function seekFromEvent(clientX) {
    var container = document.getElementById('progress-bar-container');
    var video = getVideo();
    if (!container || !video) return;
    var rect = container.getBoundingClientRect();
    var pct = ((clientX - rect.left) / rect.width) * 100;
    seekToPercent(pct);
  }

  function initProgressBar(video) {
    if (!video) return;
    var container = document.getElementById('progress-bar-container');
    if (!container) return;

    var showTooltip = function(e) {
      var rect = container.getBoundingClientRect();
      var pct = ((e.clientX - rect.left) / rect.width) * 100;
      var tooltip = document.getElementById('progress-tooltip');
      var hover = document.getElementById('progress-hover');
      var timeEl = document.getElementById('progress-tooltip-time');
      if (tooltip) tooltip.style.left = pct + '%';
      if (hover) hover.style.width = pct + '%';
      if (timeEl && video.duration) {
        timeEl.textContent = fmtTime((pct / 100) * video.duration);
      }
    };

    container.addEventListener('mousemove', showTooltip);
    container.addEventListener('mouseleave', function() {
      var hover = document.getElementById('progress-hover');
      if (hover) hover.style.width = '0%';
    });

    // Click to seek
    container.addEventListener('click', function(e) {
      seekFromEvent(e.clientX);
    });

    // Drag to seek
    var dragging = false;
    container.addEventListener('mousedown', function(e) {
      dragging = true;
      progressScrubbing = true;
      container.classList.add('scrubbing');
      seekFromEvent(e.clientX);
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (dragging) {
        seekFromEvent(e.clientX);
      }
    });
    document.addEventListener('mouseup', function() {
      if (dragging) {
        dragging = false;
        progressScrubbing = false;
        container.classList.remove('scrubbing');
      }
    });

    // Touch seek
    container.addEventListener('touchstart', function(e) {
      progressScrubbing = true;
      container.classList.add('touching');
      var t = e.touches[0];
      if (t) seekFromEvent(t.clientX);
    }, { passive: true });
    container.addEventListener('touchmove', function(e) {
      var t = e.touches[0];
      if (t) seekFromEvent(t.clientX);
    }, { passive: true });
    container.addEventListener('touchend', function() {
      progressScrubbing = false;
      container.classList.remove('touching');
    });
  }

  // ════════════════════════════════════════════════════════════
  //  IndexedDB blob deletion (offline downloads)
  // ════════════════════════════════════════════════════════════
  function deleteBlobFromIndexedDB(animeTitle, episodeNumber) {
    try {
      var DB_NAME = 'AnistrimOfflineDB';
      var DB_VERSION = 1;
      var STORE_NAME = 'episodes';
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = function() {
        var db = request.result;
        try {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          store.delete(String(animeTitle) + '_ep' + String(episodeNumber));
        } catch (e) { /* no-op */ }
      };
    } catch (e) { /* no-op */ }
  }

  // ════════════════════════════════════════════════════════════
  //  Expose all functions globally (so watch.js can call them)
  // ════════════════════════════════════════════════════════════
  window.fmtTime = fmtTime;
  window.updateVolumeIcon = updateVolumeIcon;
  window.setVolume = setVolume;
  window.adjustVolume = adjustVolume;
  window.toggleMute = toggleMute;
  window.toggleFullscreen = toggleFullscreen;
  window.togglePip = togglePip;
  window.isPipSupported = isPipSupported;
  window.flashCenterIndicator = flashCenterIndicator;
  window.initProgressBar = initProgressBar;
  window.updateProgressBarUI = updateProgressBarUI;
  window.updateBufferedUI = updateBufferedUI;
  window.updateTimeDisplay = updateTimeDisplay;
  window.deleteBlobFromIndexedDB = deleteBlobFromIndexedDB;

  // Also expose under a namespace for clarity.
  window.AniStrimPlayerControls = {
    fmtTime: fmtTime,
    updateVolumeIcon: updateVolumeIcon,
    setVolume: setVolume,
    adjustVolume: adjustVolume,
    toggleMute: toggleMute,
    toggleFullscreen: toggleFullscreen,
    togglePip: togglePip,
    isPipSupported: isPipSupported,
    flashCenterIndicator: flashCenterIndicator,
    initProgressBar: initProgressBar,
    updateProgressBarUI: updateProgressBarUI,
    updateBufferedUI: updateBufferedUI,
    updateTimeDisplay: updateTimeDisplay,
    deleteBlobFromIndexedDB: deleteBlobFromIndexedDB
  };
})();