// watch.js — AniStrim Premium Watch Experience
// ─────────────────────────────────────────────────────────────
// Preserves the original playback/resolution backend (multi-API
// streaming, AnimeHeaven proxy, skip-intro, autoplay-next, progress
// tracking, ad tracker, offline downloads) and layers a premium,
// modern player UI on top:
//   • Custom controls (play/pause, prev/next ep, ±10s seek, volume,
//     mute, progress bar, time/remaining display, fullscreen, PiP)
//   • Auto-hiding controls with premium fade/slide behavior
//   • Custom draggable/clackable progress bar with buffered + hover
//   • Settings menu (quality, speed, subtitles, audio tracks)
//   • Keyboard shortcuts, mouse controls, touch controls
//   • Center action indicators + buffering spinner

// ── Episode Identity ────────────────────────────────────────
//   episodeId   = Database record ID (used for progress saving, DB lookups)
//   episodeNumber = Sequential episode number (1, 2, 3...) (used for streaming)

let requestId = 'W' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
function watchLog(event, meta = {}) {
  const entry = { requestId, event, timestamp: new Date().toISOString(), ...meta };
  console.log(`[WATCH] ${event}`, entry);
}
function setLoadingStatus(text) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = text;
}

let currentAnime = null;
let currentEp    = 1;
let nextEpData   = null;
let prevEpData   = null;
let currentEpId  = null;
let autoplayCountdown = null;
let introRange = null;
let hlsInstance = null;
let controlsTimer = null;

// ── Multi-API / Provider Switching State ────────────────────
let availableProviders = [];
let currentProvider = '';
let currentStreamUrl = '';
let currentAnimeTitle = '';
let currentStreamSources = [];
let currentStreamQuality = 'auto';

// ── Premium player state ────────────────────────────────────
let isScrubbing = false;
let autoplayEnabled = localStorage.getItem('anistrim_autoplay') !== 'off';
let speedValue = parseFloat(localStorage.getItem('anistrim_speed') || '1');
let lastTapTime = 0;
let lastTapX = 0;
let suppressNextClick = false;
let cancelledNext = false;
let hlsQualityOptions = [{ label: 'Auto', value: -1 }];
let currentQualityIndex = -1; // -1 = Auto
let subtitleTracksList = [];
let audioTracksList = [];

// ── Ad Mid-Roll Tracking ────────────────────────────────────
let adPlayInterval = null;
let lastAdPlayedAt = 0;
const AD_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ── Playback stage timeouts (ms) ────────────────────────────
const API_TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 60000;
const SOURCE_ATTACH_TIMEOUT_MS = 30000;

function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches);
}

// ════════════════════════════════════════════════════════════
//  PAGE LOAD / STREAM RESOLUTION  (unchanged backend contract)
// ════════════════════════════════════════════════════════════
async function loadWatch() {
  watchLog('page initialized', { url: window.location.href });
  const params = new URLSearchParams(window.location.search);
  const animeId = params.get('id') || params.get('animeId');
  const epNumRaw = params.get('ep');
  const epIdRaw = params.get('epId');

  if (params.get('animeId')) console.warn('[Watch] Legacy param "animeId" detected — use "id" instead');
  if (params.get('epId') && !params.get('ep')) console.warn('[Watch] Legacy param "epId" detected — use "ep" with episode NUMBER instead');

  if (epNumRaw) {
    currentEp = parseInt(epNumRaw, 10) || 1;
  } else {
    currentEp = parseInt(epIdRaw, 10) || 1;
  }

  if (!animeId) { showWatchError('Missing anime ID. Please go back and try again.'); return; }

  try {
    setLoadingStatus('Finding episode...');
    watchLog('anime request started', { animeId });

    const animeRes = await apiFetch('/api/anime/' + animeId, { timeout: API_TIMEOUT_MS });
    if (animeRes.timedOut) {
      showWatchError('Timed out loading anime data. Please check your connection and try again.');
      return;
    }
    const animeData = animeRes.data;
    currentAnime = animeData;
    if (!animeData || !animeData.id) { showWatchError('Could not load anime data.'); return; }
    watchLog('anime request completed', { animeId, title: animeData.title });

    currentAnimeTitle = window._escapeHTML(animeData.title);
    const loadingAnimeTitle = document.getElementById('loading-anime-title');
    const loadingEpisodeInfo = document.getElementById('loading-episode-info');
    if (loadingAnimeTitle) loadingAnimeTitle.textContent = currentAnimeTitle;
    if (loadingEpisodeInfo) loadingEpisodeInfo.textContent = 'Episode ' + currentEp;
    document.title = 'Ep ' + currentEp + ' - ' + window._escapeHTML(animeData.title) + ' | AniStrim';
    document.getElementById('watch-ep-title').textContent = 'Episode ' + currentEp;
    document.getElementById('watch-anime-title').textContent = currentAnimeTitle;

    watchLog('episodes request started', { animeId });
    const episodesRes = await apiFetch('/api/anime/' + animeId + '/episodes', { timeout: API_TIMEOUT_MS });
    if (episodesRes.timedOut) {
      showWatchError('Timed out loading episode list. Please try again.');
      return;
    }
    const episodesData = episodesRes.data;
    const episodes = Array.isArray(episodesData) ? episodesData : [];
    watchLog('episodes request completed', { animeId, count: episodes.length });

    let ep;
    if (params.get('epId')) {
      ep = episodes.find(function(e) { return String(e.id) === String(params.get('epId')); });
    }
    if (!ep) {
      ep = episodes.find(function(e) { return (e.number || e.episode_number) === currentEp; });
    }
    currentEpId  = ep && ep.id ? ep.id : null;
    nextEpData   = episodes.find(function(e) { return (e.number || e.episode_number) === ((ep && (ep.number || ep.episode_number)) || currentEp) + 1; }) || null;
    prevEpData   = episodes.find(function(e) { return (e.number || e.episode_number) === ((ep && (ep.number || ep.episode_number)) || currentEp) - 1; }) || null;

    if (nextEpData) {
      const nextEpTitleOverlay = document.getElementById('next-ep-title-overlay');
      if (nextEpTitleOverlay) nextEpTitleOverlay.textContent = 'Episode ' + (nextEpData.number || nextEpData.episode_number);
    }

    var video = document.getElementById('animePlayer');
    const loadingOverlay = document.getElementById('loading-overlay');

    if (ep && ep.video_url) {
      setLoadingStatus('Loading video...');
      await attachStreamSource(video, ep.video_url);
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      setupPlayer(video);
      watchLog('source selected', { directVideo: true });
    } else {
      const errorOverlay = document.getElementById('error-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      if (errorOverlay) errorOverlay.style.display = 'none';

      try {
        setLoadingStatus('Finding stream...');
        await resolveAndPlayStream(animeData.title, currentEp, video);
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        watchLog('stream resolution completed', { episode: currentEp });
        setupPlayer(video);
      } catch (err) {
        showWatchError(err.message || 'Stream resolution failed.');
      }
    }

    loadSkipTimes(animeId, (ep && (ep.number || ep.episode_number)) || currentEp);
    renderMoreEpisodes(episodes, animeId);

    if (!(State.isPremium || State.isAdmin)) {
      startMidRollAdTracker(video);
    }

  } catch(e) {
    console.error('Watch error:', e);
    showWatchError('Network error. Please check your connection and try again.');
  }
}

// ── Provider List (lazy, non-blocking) ─────────────────────
async function fetchAvailableProviders(animeTitle, episodeNumber) {
  try {
    watchLog('provider request started', { animeTitle, episodeNumber });
    var { data, timedOut } = await apiFetch('/api/stream/providers/' + encodeURIComponent(animeTitle) + '/' + episodeNumber, { timeout: 8000 });
    if (timedOut) return;
    if (data && data.providers && data.providers.length > 0) {
      availableProviders = data.providers;
      populateServerSwitcher();
    }
  } catch (e) {
    console.debug('Could not fetch provider list:', e.message);
  }
}

function populateServerSwitcher() {
  // DORMANT: No #serverSwitcher element in the new HTML. Quality is now the primary selector.
}

// ── Multi-API: Resolve and play stream ──────────────────────
async function resolveAndPlayStream(animeTitle, episodeNumber, video, preferredProvider) {
  var url = '/api/stream/' + encodeURIComponent(animeTitle) + '/' + episodeNumber;
  if (preferredProvider) {
    url += '?preferredProvider=' + preferredProvider;
  }

  const requestStart = Date.now();
  watchLog('stream request started', { url, method: 'GET', timeoutMs: STREAM_TIMEOUT_MS });

  console.log("[PLAYER] Requesting stream from:", url);
  var { data, status, timedOut } = await apiFetch(url, { timeout: STREAM_TIMEOUT_MS });
  const responseReceived = Date.now();
  watchLog('stream request completed', { status, elapsedMs: responseReceived - requestStart, timedOut });

  if (timedOut) {
    throw new Error('Stream resolution timed out. The server is taking too long. Try again or change server.');
  }

  console.log("[PLAYER] Stream API response", data);

  if (data && data.sources && data.sources.length > 0) {
    const parsedTime = Date.now();
    watchLog('stream response parsed', { sources: data.sources.length, elapsedMs: parsedTime - requestStart });

    const API_BASE_URL = window.getApiBaseUrl();
    const sourcesToTry = data.sources.map(source => ({
        ...source,
        url: source.url.startsWith('http') ? source.url : API_BASE_URL + source.url
    }));
    currentStreamSources = sourcesToTry;

    for (const source of sourcesToTry) {
        try {
            console.log(`[PLAYER] Attempting to attach source: ${source.url} (Quality: ${source.quality})`);
            setLoadingStatus('Connecting to server...');
            watchLog('source selected', { url: source.url, quality: source.quality });
            await attachStreamSource(video, source.url);

            currentStreamUrl = source.url;
            currentProvider = data.provider || 'unknown';
            currentStreamQuality = source.quality || 'auto';
            console.log("[PLAYER] Successfully attached stream:", currentStreamUrl);
            watchLog('video source attached', { provider: currentProvider, quality: source.quality });

            // Attach external subtitle tracks returned by the provider (best effort).
            if (data.subtitles && data.subtitles.length) {
              attachSubtitles(video, data.subtitles);
            }

            // Update quality value in settings menu
            const qualityValue = document.getElementById('quality-value');
            if (qualityValue) qualityValue.textContent = currentStreamQuality;

            // Populate the server switcher lazily (non-blocking, no re-scrape)
            if (!availableProviders.length && data.provider) {
              availableProviders = [{ provider: data.provider, bestQuality: source.quality }];
              populateServerSwitcher();
            }
            return;
        } catch (err) {
            console.warn(`[PLAYER] Source failed to load: ${source.url}. Trying next source...`, err.message);
        }
    }
    throw new Error('All available stream sources failed to load.');
  } else {
    throw new Error((data && data.error) || 'No stream URL returned');
  }
}

// ── Multi-API: Switch provider ──────────────────────────────
async function switchProvider(providerName) {
  if (!currentAnimeTitle) return;

  var video = document.getElementById('animePlayer');
  var currentTime = video.currentTime;
  var wasPlaying = !video.paused;

  const loadingOverlay = document.getElementById('loading-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'flex';
  if (errorOverlay) errorOverlay.style.display = 'none';

  try {
    setLoadingStatus('Connecting to server...');
    await resolveAndPlayStream(currentAnimeTitle, currentEp, video, providerName || undefined);

    video.addEventListener('loadedmetadata', function() {
      if (currentTime > 1 && currentTime < (video.duration || Infinity)) {
        video.currentTime = currentTime;
      }
      if (wasPlaying) video.play()['catch'](function() {});
    }, { once: true });

    if (loadingOverlay) loadingOverlay.style.display = 'none';
  } catch (err) {
    console.error('Provider switch failed:', err.message);
    showWatchError(err.message || 'Provider switch failed.');
  }
}
window.switchProvider = switchProvider;

// ── Mid-Roll Ad Tracker (Free users only) ──────────────────
function startMidRollAdTracker(video) {
  if (State.isPremium || State.isAdmin) return;
  if (adPlayInterval) clearInterval(adPlayInterval);
  lastAdPlayedAt = Date.now();

  adPlayInterval = setInterval(function() {
    if (video.paused || video.ended) return;
    var elapsed = Date.now() - lastAdPlayedAt;
    if (elapsed >= AD_INTERVAL_MS) {
      showMidRollAd(video);
    }
  }, 30000);
}

function showMidRollAd(video) {
  // DORMANT: No #adOverlay element in new HTML
}

// ════════════════════════════════════════════════════════════
//  PREMIUM PLAYER SETUP
// ════════════════════════════════════════════════════════════
function setupPlayer(video) {
  const wrap = document.getElementById('player-wrap');
  const skipBtn = document.getElementById('skip-intro-btn');
  const nextBanner = document.getElementById('next-episode-overlay');
  var isPremium = State.isPremium || State.isAdmin;

  // ── Instrumented playback events (prevent silent failures) ──
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error'].forEach(eventName => {
    video.addEventListener(eventName, () => {
      watchLog(eventName, {
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
      });
      const loadingOverlay = document.getElementById('loading-overlay');
      const bufferingEl = document.getElementById('buffering-spinner');
      if (eventName === 'waiting' || eventName === 'stalled') {
        setLoadingStatus('Buffering...');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        if (bufferingEl) bufferingEl.classList.add('visible');
      } else if (eventName === 'playing' || eventName === 'canplay') {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (bufferingEl) bufferingEl.classList.remove('visible');
      } else if (eventName === 'error') {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (bufferingEl) bufferingEl.classList.remove('visible');
      }
    });
  });

  if (currentEpId) loadProgress(video, currentEpId);

  // ── Time / Progress updates ──────────────────────────────
  video.addEventListener('timeupdate', function() {
    updateProgressBarUI(video);
    updateTimeDisplay(video);

    // Skip intro (premium)
    if (isPremium && introRange && video.currentTime >= introRange.start && video.currentTime < introRange.end) {
      if(skipBtn) skipBtn.style.display = 'block';
    } else {
      if(skipBtn) skipBtn.style.display = 'none';
    }

    // Next-episode banner near end
    if (isPremium && nextEpData && video.duration) {
      var remaining = video.duration - video.currentTime;
      if (remaining <= 30 && remaining > 0 && !cancelledNext) {
        if (nextBanner) nextBanner.style.display = 'flex';
        const secEl = document.getElementById('next-ep-countdown');
        if (secEl) secEl.textContent = `Playing next in ${Math.ceil(remaining)}s`;
      } else if (remaining > 30) {
        if (nextBanner) nextBanner.style.display = 'none';
      }
    }

    // Progress save (throttled)
    if (currentEpId && Math.floor(video.currentTime) % 10 === 0 && video.currentTime > 0) {
      saveProgress(currentEpId, Math.floor(video.currentTime), false);
    }
  });

  // Buffered progress indicator
  video.addEventListener('progress', function() {
    updateBufferedUI(video);
  });

  video.addEventListener('ended', function() {
    if (currentEpId) saveProgress(currentEpId, Math.floor(video.duration || 0), true);
    wrap.classList.add('ended');
    cancelledNext = false;
    if (isPremium && nextEpData) {
      if (autoplayEnabled) {
        startAutoplayCountdown();
      } else if (nextBanner) {
        nextBanner.style.display = 'flex';
        const countdownEl = document.getElementById('next-ep-countdown');
        if(countdownEl) countdownEl.style.display = 'none';
      }
    } else if (!isPremium && nextEpData) {
      if (nextBanner) {
        nextBanner.style.display = 'flex';
        const countdownEl = document.getElementById('next-ep-countdown');
        if(countdownEl) countdownEl.style.display = 'none';
      }
    }
  });

  video.addEventListener('play', function() {
    wrap.classList.remove('paused', 'ended');
    cancelledNext = false;
    setPlayIcon(true);
    watchLog('playing', { provider: currentProvider, sourceUrl: currentStreamUrl });

    if (!window._videoStartedLogged) {
        window._videoStartedLogged = true;
        const payload = {
            event: 'videoStarted',
            animeTitle: currentAnimeTitle,
            episode: currentEp,
            provider: currentProvider,
            sourceUrl: currentStreamUrl,
            requestId,
        };
        apiFetch('/api/reports/client-event', { method: 'POST', body: JSON.stringify(payload) }).catch(err => console.warn('Failed to log videoStarted event:', err));
    }
    showControls();
  });
  video.addEventListener('pause', function() {
    wrap.classList.add('paused');
    setPlayIcon(false);
    showControls();
    cancelAutoplay();
  });

  // ── Wire control buttons ─────────────────────────────────
  document.getElementById('play-pause-btn')?.addEventListener('click', togglePlay);
  document.getElementById('seek-backward-btn')?.addEventListener('click', skipBack);
  document.getElementById('seek-forward-btn')?.addEventListener('click', skipForward);
  document.getElementById('fullscreen-btn')?.addEventListener('click', toggleFullscreen);
  document.getElementById('back-btn')?.addEventListener('click', () => window.history.back());
  document.getElementById('prev-ep-btn')?.addEventListener('click', goPrevEp);
  document.getElementById('next-ep-btn')?.addEventListener('click', goNextEp);
  if (skipBtn) skipBtn.addEventListener('click', skipIntro);

  // Volume
  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.value = String(video.volume || 1);
    volumeSlider.addEventListener('input', (e) => setVolume(e.target.value));
  }
  const volumeBtn = document.getElementById('volume-btn');
  if (volumeBtn) {
    volumeBtn.addEventListener('click', toggleMute);
    const volContainer = volumeBtn.closest('.volume-container');
    if (volContainer) {
      volumeBtn.addEventListener('focus', () => volContainer.classList.add('focused'));
      volumeBtn.addEventListener('blur', () => volContainer.classList.remove('focused'));
    }
  }

  // Episodes sidebar
  document.getElementById('episodes-btn')?.addEventListener('click', () => {
    document.getElementById('episode-sidebar')?.classList.add('visible');
    showControls();
  });
  document.getElementById('close-sidebar-btn')?.addEventListener('click', () => {
    document.getElementById('episode-sidebar')?.classList.remove('visible');
  });

  // Picture-in-Picture
  const pipBtn = document.getElementById('pip-btn');
  if (pipBtn && isPipSupported()) {
    pipBtn.style.display = 'flex';
    pipBtn.addEventListener('click', togglePip);
  }
  video.addEventListener('enterpictureinpicture', () => { pipBtn && pipBtn.classList.add('active'); });
  video.addEventListener('leavepictureinpicture', () => { pipBtn && pipBtn.classList.remove('active'); });

  // Settings menu
  document.getElementById('settings-btn')?.addEventListener('click', toggleSettingsMenu);
  document.querySelectorAll('[data-opens]').forEach(btn => {
    btn.addEventListener('click', () => openSettingsPanel(btn.getAttribute('data-opens')));
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => openSettingsPanel('main'));
  });
  document.getElementById('autoplay-toggle-btn')?.addEventListener('click', toggleAutoplaySetting);
  updateAutoplayUI();

  // Next-episode overlay controls
  document.getElementById('play-next-btn')?.addEventListener('click', playNextEp);
  document.getElementById('cancel-next-btn')?.addEventListener('click', () => {
    cancelAutoplay();
    cancelledNext = true;
    if (nextBanner) nextBanner.style.display = 'none';
    showControls();
  });

  // ── Custom progress bar ──────────────────────────────────
  initProgressBar(video);
  initControlsAutoHide(wrap);
  initKeyboardShortcuts();
  initTouchControls(wrap, video);

  // Restore saved playback speed / volume
  video.playbackRate = speedValue;
  updateSpeedUI();
  updateVolumeIcon();

  // fmtTime displays
  updateTimeDisplay(video);

  // Attempt autoplay (existing behaviour)
  video.play()['catch'](function() { wrap.classList.add('paused'); });
}

// ════════════════════════════════════════════════════════════
//  CONTROLS AUTO-HIDE + SHOW/HIDE
// ════════════════════════════════════════════════════════════
function showControls() {
  const wrap = document.getElementById('player-wrap');
  if (!wrap) return;
  if (isTouchDevice()) wrap.classList.add('controls-visible-mobile');
  else wrap.classList.add('controls-visible');
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsTimer = setTimeout(hideControls, 3000);
}

function hideControls() {
  const wrap = document.getElementById('player-wrap');
  if (!wrap) return;
  const video = document.getElementById('animePlayer');
  const settingsMenu = document.getElementById('settings-menu');
  const sidebar = document.getElementById('episode-sidebar');
  if (settingsMenu && settingsMenu.classList.contains('visible')) return;
  if (sidebar && sidebar.classList.contains('visible')) return;
  // Never hide when paused, ended, scrubbing or when metadata still loading.
  if (!video || video.paused || video.ended || isScrubbing) return;
  if (!isFinite(video.duration)) return;
  wrap.classList.remove('controls-visible', 'controls-visible-mobile');
}

function initControlsAutoHide(wrap) {
  wrap.addEventListener('mousemove', showControls);
  wrap.addEventListener('mouseenter', showControls);
  wrap.addEventListener('touchstart', showControls, { passive: true });
  // Keyboard interaction reveals controls
  document.addEventListener('keydown', function() {
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') showControls();
  });

  // Click on video area toggles play/pause (desktop) or controls (touch)
  wrap.addEventListener('click', function(e) {
    if (suppressNextClick) { suppressNextClick = false; return; }
    if (e.target.closest('.controls-overlay') ||
        e.target.closest('.settings-menu') ||
        e.target.closest('.skip-btn') ||
        e.target.closest('.next-ep') ||
        e.target.closest('.progress-bar-container') ||
        e.target.closest('.player-sidebar') ||
        e.target.closest('.buffering-spinner')) return;
    var video = document.getElementById('animePlayer');
    if (!video) return;
    if (isTouchDevice()) {
      // If controls hidden, show them; if visible, toggle play/pause
      if (!wrap.classList.contains('controls-visible-mobile') && !wrap.classList.contains('controls-visible')) {
        showControls();
      } else {
        togglePlay();
      }
    } else {
      togglePlay();
    }
  });
}

// ════════════════════════════════════════════════════════════
//  PLAYBACK ACTION HELPERS
// ════════════════════════════════════════════════════════════
function togglePlay() {
  var v = document.getElementById('animePlayer');
  if (!v) return;
  if (v.paused) {
    v.play()['catch'](function() {});
    setPlayIcon(true);
    flashCenterIndicator('<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>', '');
  } else {
    v.pause();
    setPlayIcon(false);
    flashCenterIndicator('<path d="M8 5v14l11-7z"/>', '');
  }
}
window.togglePlay = togglePlay;

function setPlayIcon(isPlaying) {
  const playIcon = document.getElementById('play-icon');
  if (!playIcon) return;
  if (isPlaying) playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  else playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
}

function skipBack() {
  var v = document.getElementById('animePlayer');
  if (!v || !isFinite(v.duration)) return;
  v.currentTime = Math.max(0, v.currentTime - 10);
  flashCenterIndicator('<path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>', '10s');
  showControls();
}
window.skipBack = skipBack;

function skipForward() {
  var v = document.getElementById('animePlayer');
  if (!v || !isFinite(v.duration)) return;
  v.currentTime = Math.min(v.duration - 0.5, v.currentTime + 10);
  flashCenterIndicator('<path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>', '10s');
  showControls();
}
window.skipForward = skipForward;

function goPrevEp() {
  if (!prevEpData || !currentAnime) return;
  var prevNum = prevEpData.number || prevEpData.episode_number;
  location.href = 'watch.html?id=' + currentAnime.id + '&ep=' + prevNum;
}
window.goPrevEp = goPrevEp;

function goNextEp() {
  if (!nextEpData || !currentAnime) return;
  playNextEp();
}
window.goNextEp = goNextEp;

function setVolume(v) {
  const video = document.getElementById('animePlayer');
  if (!video) return;
  var val = Math.min(1, Math.max(0, parseFloat(v) || 0));
  video.volume = val;
  video.muted = false;
  if (val === 0) video.muted = true;
  const slider = document.getElementById('volume-slider');
  if (slider) slider.value = String(video.muted ? 0 : val);
  updateVolumeIcon();
  flashCenterIndicator('', Math.round(video.muted ? 0 : video.volume * 100) + '%');
}
window.setVolume = setVolume;

function adjustVolume(delta) {
  const video = document.getElementById('animePlayer');
  if (!video) return;
  var next = Math.min(1, Math.max(0, video.volume + delta));
  setVolume(next);
}

function toggleMute() {
  const video = document.getElementById('animePlayer');
  if (!video) return;
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) video.volume = 0.5;
  updateVolumeIcon();
  if (video.muted) {
    flashCenterIndicator(
      '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>',
      'Muted'
    );
  } else {
    flashCenterIndicator(
      '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>',
      video.volume > 0 ? Math.round(video.volume * 100) + '%' : '0%'
    );
  }
  showControls();
}
window.toggleMute = toggleMute;

function updateVolumeIcon() {
  const video = document.getElementById('animePlayer');
  const icon = document.getElementById('volume-icon');
  if (!video || !icon) return;
  if (video.muted || video.volume === 0) {
    icon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  } else if (video.volume < 0.5) {
    icon.innerHTML = '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>';
  } else {
    icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  }
}

function toggleFullscreen() {
  var wrap = document.getElementById('player-wrap');
  if (!wrap) return;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (wrap.requestFullscreen) wrap.requestFullscreen()['catch'](function(){});
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen()['catch'](function(){});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}
window.toggleFullscreen = toggleFullscreen;

function updateFullscreenIcon() {
  const icon = document.getElementById('fullscreen-icon');
  if (!icon) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    icon.innerHTML = '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>';
  } else {
    icon.innerHTML = '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>';
  }
}
document.addEventListener('fullscreenchange', updateFullscreenIcon);
document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);

function isPipSupported() {
  const video = document.getElementById('animePlayer');
  return !!(document.pictureInPictureEnabled && video && typeof video.requestPictureInPicture === 'function');
}

async function togglePip() {
  const video = document.getElementById('animePlayer');
  if (!video) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  } catch (e) {
    console.warn('PiP error:', e.message);
  }
}
window.togglePip = togglePip;

function flashCenterIndicator(svgPath, label) {
  const ind = document.getElementById('center-indicator');
  const svg = document.getElementById('center-indicator-svg');
  const lab = document.getElementById('center-indicator-label');
  if (!ind) return;
  if (svg && svgPath) svg.innerHTML = svgPath;
  if (lab) lab.textContent = (label !== undefined && label !== null) ? label : '';
  ind.classList.remove('flash');
  void ind.offsetWidth; // restart CSS animation
  ind.classList.add('flash');
}

// ── Time Formatting ─────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  s = Math.floor(s);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

function updateTimeDisplay(video) {
  if (!video) return;
  const cur = document.getElementById('current-time');
  const dur = document.getElementById('duration-time');
  const rem = document.getElementById('remaining-time');
  if (cur) cur.textContent = fmtTime(video.currentTime);
  if (dur) dur.textContent = isFinite(video.duration) ? fmtTime(video.duration) : '0:00';
  if (rem) rem.textContent = isFinite(video.duration) ? '-' + fmtTime(Math.max(0, video.duration - video.currentTime)) : '-0:00';
}

// ── Progress Bar UI ─────────────────────────────────────────
function updateProgressBarUI(video) {
  const playedEl = document.getElementById('progress-played');
  const thumbEl = document.getElementById('progress-thumb');
  if (!playedEl || !video) return;
  const ratio = (isFinite(video.duration) && video.duration > 0) ? (video.currentTime / video.duration) : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  if (!isScrubbing) {
    playedEl.style.width = pct + '%';
    if (thumbEl) thumbEl.style.left = pct + '%';
  }
  updateTimeDisplay(video);
}

function updateBufferedUI(video) {
  const bufferEl = document.getElementById('progress-buffer');
  if (!bufferEl || !video) return;
  let ratio = 0;
  try {
    if (video.buffered && video.buffered.length > 0 && isFinite(video.duration) && video.duration > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      ratio = Math.min(1, end / video.duration);
    }
  } catch (e) { ratio = 0; }
  bufferEl.style.width = (ratio * 100) + '%';
}

function initProgressBar(video) {
  const container = document.getElementById('progress-bar-container');
  const track = document.getElementById('progress-track');
  const hoverEl = document.getElementById('progress-hover');
  const tooltipEl = document.getElementById('progress-tooltip');
  const tooltipTimeEl = document.getElementById('progress-tooltip-time');
  if (!container || !track) return;

  function ratioFromEvent(e) {
    const rect = track.getBoundingClientRect();
    let x = e.clientX;
    if (x === undefined && e.touches && e.touches[0]) x = e.touches[0].clientX;
    if (x === undefined && e.changedTouches && e.changedTouches[0]) x = e.changedTouches[0].clientX;
    if (x === undefined || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  }

  function seekGuard() {
    // Protection against accidental seeking while metadata is unavailable.
    return !!(video && isFinite(video.duration) && video.duration > 0);
  }

  function updateScrubVisual(ratio) {
    const pct = ratio * 100;
    const playedEl = document.getElementById('progress-played');
    const thumbEl = document.getElementById('progress-thumb');
    if (playedEl) playedEl.style.width = pct + '%';
    if (thumbEl) thumbEl.style.left = pct + '%';
    if (tooltipTimeEl) tooltipTimeEl.textContent = fmtTime(ratio * (isFinite(video.duration) ? video.duration : 0));
    if (tooltipEl) tooltipEl.style.left = Math.min(Math.max(pct, 3), 97) + '%';
  }

  function applySeek(ratio) {
    if (!seekGuard()) return;
    video.currentTime = ratio * video.duration;
  }

  // Pointer events unify mouse + touch for click-to-seek and dragging.
  container.addEventListener('pointerdown', function(e) {
    if (!seekGuard()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isScrubbing = true;
    container.classList.add('scrubbing');
    if (container.setPointerCapture && e.pointerId !== undefined) {
      try { container.setPointerCapture(e.pointerId); } catch (_) {}
    }
    updateScrubVisual(ratioFromEvent(e));
    e.preventDefault();
  });

  container.addEventListener('pointermove', function(e) {
    const ratio = ratioFromEvent(e);
    if (isScrubbing) {
      updateScrubVisual(ratio);
    } else {
      // Hover preview (desktop)
      const pct = ratio * 100;
      if (hoverEl) hoverEl.style.width = pct + '%';
      if (tooltipTimeEl) {
        const dur = (video && isFinite(video.duration)) ? video.duration : 0;
        tooltipTimeEl.textContent = fmtTime(ratio * dur);
      }
      if (tooltipEl) tooltipEl.style.left = Math.min(Math.max(pct, 3), 97) + '%';
    }
  });

  container.addEventListener('pointerup', function(e) {
    if (!isScrubbing) return;
    isScrubbing = false;
    container.classList.remove('scrubbing');
    applySeek(ratioFromEvent(e));
    showControls();
  });

  container.addEventListener('pointercancel', function() {
    isScrubbing = false;
    container.classList.remove('scrubbing');
  });

  container.addEventListener('pointerleave', function() {
    if (!isScrubbing && hoverEl) hoverEl.style.width = '0%';
  });

  // Touch fallback for browsers without PointerEvent.
  if (!window.PointerEvent) {
    container.addEventListener('touchstart', function(e) {
      if (!seekGuard()) return;
      isScrubbing = true;
      container.classList.add('scrubbing');
      updateScrubVisual(ratioFromEvent(e));
      e.preventDefault();
    }, { passive: false });
    container.addEventListener('touchmove', function(e) {
      if (isScrubbing) updateScrubVisual(ratioFromEvent(e));
    }, { passive: false });
    container.addEventListener('touchend', function(e) {
      if (!isScrubbing) return;
      isScrubbing = false;
      container.classList.remove('scrubbing');
      applySeek(ratioFromEvent(e));
      showControls();
    }, { passive: false });
  }
}

// Legacy seekVideo(progressEvent | fraction) compatibility.
function seekVideo(arg) {
  const video = document.getElementById('animePlayer');
  if (!video || !isFinite(video.duration) || video.duration <= 0) return;
  let fraction;
  if (typeof arg === 'number') {
    fraction = arg;
  } else if (arg && arg.currentTarget && arg.currentTarget.max) {
    fraction = (Number(arg.currentTarget.value) || 0) / (Number(arg.currentTarget.max) || 1);
  } else {
    return;
  }
  video.currentTime = Math.min(video.duration, Math.max(0, fraction * video.duration));
}
window.seekVideo = seekVideo;

// ════════════════════════════════════════════════════════════
//  SETTINGS MENU
// ════════════════════════════════════════════════════════════
function toggleSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (!menu) return;
  if (menu.classList.contains('visible')) {
    closeSettingsMenu();
  } else {
    refreshAllSettingsOptions();
    openSettingsPanel('main');
    menu.classList.add('visible');
    showControls();
  }
}

function closeSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (menu) menu.classList.remove('visible');
  showControls();
}

function openSettingsPanel(name) {
  document.querySelectorAll('.settings-panel').forEach(function(p) {
    p.hidden = p.getAttribute('data-panel') !== name;
  });
}

function refreshAllSettingsOptions() {
  populateQualityOptions();
  populateSpeedOptions();
  refreshSubtitleTracks();
  populateSubtitleOptions();
  refreshAudioTracks();
  populateAudioOptions();
  updateAutoplayUI();
}

// ── Quality ─────────────────────────────────────────────────
function populateQualityOptions() {
  const container = document.getElementById('quality-options');
  const qualityValue = document.getElementById('quality-value');
  if (!container) return;

  let options = [];
  // HLS: options come from the adaptive levels.
  if (hlsInstance && window.Hls && hlsInstance.levels && hlsInstance.levels.length) {
    hlsQualityOptions = [{ label: 'Auto', value: -1 }];
    const seen = new Set();
    hlsInstance.levels.forEach(function(lvl, idx) {
      const h = lvl.height ? lvl.height + 'p' : ('Level ' + (idx + 1));
      if (!seen.has(h)) {
        seen.add(h);
        hlsQualityOptions.push({ label: h, value: idx });
      }
    });
    options = hlsQualityOptions;
  } else if (currentStreamSources.length > 1) {
    // Direct/MP4: switch between available source URLs.
    const seen = new Set();
    options = [{ label: 'Auto', value: -1 }];
    currentStreamSources.forEach(function(src, idx) {
      const label = src.quality || 'auto';
      if (!seen.has(label)) {
        seen.add(label);
        options.push({ label: label === 'auto' ? 'Auto' : label, value: idx });
      }
    });
  } else {
    // Single source: show just the current quality (no switching).
    options = [{ label: currentStreamQuality || 'Auto', value: -1 }];
  }

  container.innerHTML = options.map(function(opt) {
    const active = String(opt.value) === String(currentQualityIndex) ||
      (currentQualityIndex === -1 && opt.value === -1);
    return `<button class="settings-item${active ? ' active' : ''}" data-quality="${opt.value}">
      <span>${opt.label}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('[data-quality]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const value = parseInt(btn.getAttribute('data-quality'), 10);
      setQuality(value);
    });
  });

  if (qualityValue) qualityValue.textContent = getCurrentQualityLabel();
}

function getCurrentQualityLabel() {
  if (currentQualityIndex === -1) return 'Auto';
  const found = hlsQualityOptions.find(function(o) { return o.value === currentQualityIndex; });
  return found ? found.label : 'Auto';
}

function setQuality(value) {
  currentQualityIndex = value;
  const video = document.getElementById('animePlayer');
  if (hlsInstance && window.Hls && hlsInstance.levels && hlsInstance.levels.length) {
    // Adaptive HLS: -1 = auto, otherwise specific level index.
    hlsInstance.currentLevel = value;
    hlsInstance.nextLevel = value >= 0 ? Math.min(value, (hlsInstance.levels.length || 1) - 1) : -1;
  } else {
    // Non-HLS multi-source: re-attach the selected source, preserving position.
    const src = value >= 0 ? currentStreamSources[value] : null;
    if (src && currentStreamSources.length > 1) {
      const currentTime = video.currentTime;
      const wasPlaying = !video.paused;
      attachStreamSource(video, src.url).then(function() {
        return new Promise(function(resolve) {
          video.addEventListener('loadedmetadata', function() {
            if (currentTime > 1 && currentTime < (video.duration || Infinity)) {
              video.currentTime = currentTime;
            }
            if (wasPlaying) video.play()['catch'](function() {});
            resolve();
          }, { once: true });
        });
      })['catch'](function(err) {
        console.warn('Quality switch failed:', err.message);
      });
    }
  }
  const qualityValue = document.getElementById('quality-value');
  if (qualityValue) qualityValue.textContent = getCurrentQualityLabel();
  populateQualityOptions();
  showControls();
}

// ── Playback Speed ──────────────────────────────────────────
function populateSpeedOptions() {
  const container = document.getElementById('speed-options');
  const speedValueEl = document.getElementById('speed-value');
  if (!container) return;
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  container.innerHTML = speeds.map(function(s) {
    const label = s === 1 ? 'Normal' : s + 'x';
    const active = Math.abs(speedValue - s) < 0.001;
    return `<button class="settings-item${active ? ' active' : ''}" data-speed="${s}">
      <span>${label}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('[data-speed]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      speedValue = parseFloat(btn.getAttribute('data-speed'));
      const video = document.getElementById('animePlayer');
      if (video) video.playbackRate = speedValue;
      localStorage.setItem('anistrim_speed', String(speedValue));
      updateSpeedUI();
      populateSpeedOptions();
      showControls();
    });
  });
  if (speedValueEl) speedValueEl.textContent = speedValue === 1 ? 'Normal' : speedValue + 'x';
}

function updateSpeedUI() {
  const speedValueEl = document.getElementById('speed-value');
  if (speedValueEl) speedValueEl.textContent = speedValue === 1 ? 'Normal' : speedValue + 'x';
}

// ── Subtitles ───────────────────────────────────────────────
function attachSubtitles(video, subtitleList) {
  if (!video || !Array.isArray(subtitleList)) return;
  // Remove any previously injected track elements.
  video.querySelectorAll('track[data-anistrim]').forEach(function(t) { t.remove(); });
  subtitleList.forEach(function(sub, i) {
    if (!sub || !sub.url) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.lang && sub.lang !== 'Unknown' ? sub.lang : 'Subtitle ' + (i + 1);
    track.srclang = (sub.lang || 'en').split('-')[0].toLowerCase() || 'en';
    track.src = sub.url;
    track.default = !!(sub.default || i === 0);
    track.setAttribute('data-anistrim', '1');
    video.appendChild(track);
  });
}

function refreshSubtitleTracks() {
  subtitleTracksList = [];
  const video = document.getElementById('animePlayer');
  if (video && video.textTracks) {
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') {
        subtitleTracksList.push({
          label: t.label || t.language || 'Subtitle ' + (subtitleTracksList.length + 1),
          apply: function(on) { t.mode = on ? 'showing' : 'hidden'; },
        });
      }
    }
  }
  if (hlsInstance && window.Hls && hlsInstance.subtitleTracks && hlsInstance.subtitleTracks.length) {
    hlsInstance.subtitleTracks.forEach(function(t, i) {
      subtitleTracksList.push({
        label: t.name || t.lang || 'Subtitle ' + (subtitleTracksList.length + 1),
        apply: function(on) { hlsInstance.subtitleTrack = on ? i : -1; },
      });
    });
  }
}

function populateSubtitleOptions() {
  const container = document.getElementById('subtitle-options');
  const subtitleValueEl = document.getElementById('subtitle-value');
  if (!container) return;
  refreshSubtitleTracks();

  const currentMode = currentSubtitleMode();
  let html = `<button class="settings-item${currentMode === -1 ? ' active' : ''}" data-subtitle="-1">
    <span>Off</span>
  </button>`;
  subtitleTracksList.forEach(function(track, idx) {
    html += `<button class="settings-item${currentMode === idx ? ' active' : ''}" data-subtitle="${idx}">
      <span>${track.label}</span>
    </button>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('[data-subtitle]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const idx = parseInt(btn.getAttribute('data-subtitle'), 10);
      setSubtitle(idx);
    });
  });

  if (subtitleValueEl) {
    subtitleValueEl.textContent = currentMode === -1 ? 'Off' : (subtitleTracksList[currentMode] ? subtitleTracksList[currentMode].label : 'Off');
  }
}

let _selectedSubtitleIndex = -1;
function currentSubtitleMode() {
  const video = document.getElementById('animePlayer');
  if (video && video.textTracks) {
    for (let i = 0; i < video.textTracks.length; i++) {
      if (video.textTracks[i].mode === 'showing') return i;
    }
  }
  if (hlsInstance && window.Hls && hlsInstance.subtitleTracks && hlsInstance.subtitleTracks.length && hlsInstance.subtitleTrack >= 0) {
    return subtitleTracksList.length ? video.textTracks.length + hlsInstance.subtitleTrack : -1;
  }
  return -1;
}

function setSubtitle(idx) {
  _selectedSubtitleIndex = idx;
  subtitleTracksList.forEach(function(track, i) {
    track.apply(i === idx);
  });
  populateSubtitleOptions();
  showControls();
}

// ── Audio Tracks ────────────────────────────────────────────
function refreshAudioTracks() {
  audioTracksList = [];
  const video = document.getElementById('animePlayer');
  if (video && video.audioTracks) {
    Array.from(video.audioTracks).forEach(function(t) {
      audioTracksList.push({
        label: t.label || t.language || 'Track ' + (audioTracksList.length + 1),
        apply: function(on) { t.enabled = on; },
      });
    });
  }
  if (hlsInstance && window.Hls && hlsInstance.audioTracks && hlsInstance.audioTracks.length) {
    hlsInstance.audioTracks.forEach(function(t, i) {
      audioTracksList.push({
        label: t.name || t.lang || 'Track ' + (audioTracksList.length + 1),
        apply: function(on) { if (on) hlsInstance.audioTrack = i; },
      });
    });
  }
  const item = document.getElementById('audio-settings-item');
  if (item) item.style.display = audioTracksList.length > 1 ? 'flex' : 'none';
}

function populateAudioOptions() {
  const container = document.getElementById('audio-options');
  const audioValueEl = document.getElementById('audio-value');
  if (!container) return;
  refreshAudioTracks();

  const currentAudio = currentAudioIndex();
  container.innerHTML = audioTracksList.map(function(track, idx) {
    return `<button class="settings-item${currentAudio === idx ? ' active' : ''}" data-audio="${idx}">
      <span>${track.label}</span>
    </button>`;
  }).join('') || '<button class="settings-item"><span>Default</span></button>';

  container.querySelectorAll('[data-audio]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const idx = parseInt(btn.getAttribute('data-audio'), 10);
      setAudioTrack(idx);
    });
  });

  if (audioValueEl) {
    audioValueEl.textContent = currentAudio >= 0 && audioTracksList[currentAudio] ? audioTracksList[currentAudio].label : 'Default';
  }
}

function currentAudioIndex() {
  const video = document.getElementById('animePlayer');
  if (video && video.audioTracks) {
    const arr = Array.from(video.audioTracks);
    const enabled = arr.findIndex(function(t) { return t.enabled; });
    if (enabled >= 0) return enabled;
  }
  if (hlsInstance && window.Hls && hlsInstance.audioTracks && hlsInstance.audioTracks.length && hlsInstance.audioTrack >= 0) {
    return (video && video.audioTracks ? video.audioTracks.length : 0) + hlsInstance.audioTrack;
  }
  return -1;
}

function setAudioTrack(idx) {
  audioTracksList.forEach(function(track, i) {
    if (i === idx) track.apply(true);
  });
  populateAudioOptions();
  showControls();
}

// ── Autoplay setting ────────────────────────────────────────
function toggleAutoplaySetting() {
  autoplayEnabled = !autoplayEnabled;
  localStorage.setItem('anistrim_autoplay', autoplayEnabled ? 'on' : 'off');
  updateAutoplayUI();
  showControls();
}

function updateAutoplayUI() {
  const el = document.getElementById('autoplay-value');
  if (el) el.textContent = autoplayEnabled ? 'On' : 'Off';
}

// ════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
//  Space = play/pause   ← = -10s   → = +10s   M = mute
//  F = fullscreen       P = picture-in-picture
// ════════════════════════════════════════════════════════════
function initKeyboardShortcuts() {
  document.addEventListener('keydown', function(e) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target && e.target.isContentEditable) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    const video = document.getElementById('animePlayer');
    if (!video) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        skipBack();
        break;
      case 'ArrowRight':
        e.preventDefault();
        skipForward();
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'p':
      case 'P':
        if (isPipSupported()) togglePip();
        break;
      case 'ArrowUp':
        e.preventDefault();
        adjustVolume(0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        adjustVolume(-0.1);
        break;
    }
  });
}

// ════════════════════════════════════════════════════════════
//  TOUCH CONTROLS
//  • Double-tap left third  → -10s
//  • Double-tap right third → +10s
//  • Single tap             → toggle controls / play-pause
// ════════════════════════════════════════════════════════════
function initTouchControls(wrap, video) {
  if (!isTouchDevice()) return;
  wrap.classList.add('touch-active');

  wrap.addEventListener('touchend', function(e) {
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const now = Date.now();
    const dx = Math.abs(touch.clientX - lastTapX);
    if (now - lastTapTime < 300 && dx < 40) {
      const rect = wrap.getBoundingClientRect();
      const rel = (touch.clientX - rect.left) / rect.width;
      if (rel < 0.33) {
        suppressNextClick = true;
        skipBack();
      } else if (rel > 0.66) {
        suppressNextClick = true;
        skipForward();
      }
      e.preventDefault();
    }
    lastTapTime = now;
    lastTapX = touch.clientX;
  }, { passive: false });
}

// ════════════════════════════════════════════════════════════
//  AUTOPLAY NEXT + SKIP INTRO  (preserved backend behaviour)
// ════════════════════════════════════════════════════════════
function startAutoplayCountdown() {
  const nextBanner = document.getElementById('next-episode-overlay');
  const countEl = document.getElementById('next-ep-countdown');
  const playNextBtn = document.getElementById('play-next-btn');
  if (playNextBtn) playNextBtn.onclick = playNextEp;
  if (nextBanner) nextBanner.style.display = 'flex';
  const countdownEl = document.getElementById('next-ep-countdown');
  if (countdownEl) countdownEl.style.display = 'block';
  var sec = 5;
  if (countEl) countEl.textContent = sec;
  autoplayCountdown = setInterval(function() {
    sec--;
    if (countEl) countEl.textContent = sec;
    if (sec <= 0) { cancelAutoplay(); playNextEp(); }
  }, 1000);
}

function cancelAutoplay() {
  if (autoplayCountdown) { clearInterval(autoplayCountdown); autoplayCountdown = null; }
}
window.cancelAutoplay = cancelAutoplay;

async function loadProgress(video, epId) {
  try {
    var { data } = await apiFetch('/api/watchlist/progress/' + epId, { timeout: API_TIMEOUT_MS });
    if (data && data.progress_sec > 10 && !data.completed) {
      video.addEventListener('loadedmetadata', function() {
        video.currentTime = data.progress_sec;
      }, { once: true });
    }
  } catch(e) {}
}

async function saveProgress(epId, sec, completed) {
  try {
    await apiFetch('/api/watchlist/progress', { method: 'POST', body: JSON.stringify({ episodeId: epId, progressSec: sec, completed: completed }) });
  } catch(e) {}
}

function skipIntro() {
  if (!State.isPremium && !State.isAdmin) return;
  var video = document.getElementById('animePlayer');
  if (introRange) video.currentTime = introRange.end;
  document.getElementById('skip-intro-btn').style.display = 'none';
}
window.skipIntro = skipIntro;

function playNextEp() {
  cancelAutoplay();
  if (!nextEpData || !currentAnime) return;
  var nextNum = nextEpData.number || nextEpData.episode_number;
  location.href = 'watch.html?id=' + currentAnime.id + '&ep=' + nextNum;
}
window.playNextEp = playNextEp;

// ════════════════════════════════════════════════════════════
//  EPISODE SIDEBAR
// ════════════════════════════════════════════════════════════
function renderMoreEpisodes(episodes, animeId) {
  var container = document.getElementById('sidebar-episode-list');
  if (!container) return;
  var epNum = currentEp;
  var others = episodes.filter(function(e) { return (e.number || e.episode_number) !== epNum; }).slice(0, 24);
  if (!others.length) { container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No other episodes available.</p>'; return; }
  container.innerHTML = others.map(function(e) {
    var isLocked = e.is_premium && !State.isPremium && !State.isAdmin;
    var displayNum = e.number || e.episode_number;
    var epTitle = e.title && e.title !== 'undefined' ? e.title : 'Episode ' + displayNum;
    var thumbSrc = e.thumbnail_url && e.thumbnail_url.trim() && e.thumbnail_url !== 'undefined' ? e.thumbnail_url : makeFallbackImg(epTitle);
    var lockIcon = isLocked ? '🔒' : '▶';
    var premiumTag = e.is_premium ? '<span style="color:var(--orange);font-size:0.72rem;">👑 Premium</span>' : '';
    const targetEpNum = e.number || e.episode_number;
    const currentClass = targetEpNum === epNum ? 'current' : '';
    return `<div class="episode-item ${currentClass}" onclick="location.href='watch.html?id=${animeId}&ep=${targetEpNum}'">
              <div class="ep-thumb-wrap"><img src="${thumbSrc}" alt="${epTitle.replace(/'/g,"\\'")}" loading="lazy" onerror="cardImgError(this,'${epTitle.replace(/'/g,"\\'")}')"></div>
              <div class="ep-info">
                <div class="ep-title">${window._escapeHTML(epTitle)} ${premiumTag}</div>
                <div class="ep-duration">${fmtTime(e.duration_sec || 1440)}</div>
              </div>
              <span class="ep-play-icon">${lockIcon}</span>
            </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════
//  ERROR OVERLAY (preserved recovery actions)
// ════════════════════════════════════════════════════════════
function showWatchError(msg) {
  watchLog('error shown', { message: msg });
  const loadingOverlay = document.getElementById('loading-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const errorMessage = document.getElementById('error-message');

  if (loadingOverlay) loadingOverlay.style.display = 'none';
  if (errorOverlay) errorOverlay.style.display = 'flex';
  if (errorMessage) errorMessage.textContent = msg;

  const retryBtn = document.getElementById('retry-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const changeSourceBtn = document.getElementById('change-source-btn');
  const prevEpBtn = document.getElementById('prev-ep-btn-error');
  const nextEpBtn = document.getElementById('next-ep-btn-error');

  if (retryBtn) retryBtn.onclick = () => location.reload();
  if (reloadBtn) reloadBtn.onclick = () => location.reload();
  if (changeSourceBtn) {
    changeSourceBtn.onclick = () => {
      const params = new URLSearchParams(window.location.search);
      const animeId = params.get('id');
      if (animeId && currentAnimeTitle && currentEp) {
        const video = document.getElementById('animePlayer');
        const errorOverlay = document.getElementById('error-overlay');
        const loadingOverlay = document.getElementById('loading-overlay');
        if (errorOverlay) errorOverlay.style.display = 'none';
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        setLoadingStatus('Connecting to server...');
        resolveAndPlayStream(currentAnimeTitle, currentEp, video, 'animeheaven')
          .then(() => {
            if (loadingOverlay) loadingOverlay.style.display = 'none';
          })
          .catch(err => showWatchError('Change server failed: ' + err.message));
      }
    };
  }
  if (prevEpBtn) {
    prevEpBtn.onclick = () => {
      const params = new URLSearchParams(window.location.search);
      const animeId = params.get('id');
      if (animeId && currentEp > 1) location.href = 'watch.html?id=' + animeId + '&ep=' + (currentEp - 1);
    };
  }
  if (nextEpBtn) {
    nextEpBtn.onclick = () => {
      const params = new URLSearchParams(window.location.search);
      const animeId = params.get('id');
      if (animeId && nextEpData) location.href = 'watch.html?id=' + animeId + '&ep=' + (nextEpData.number || nextEpData.episode_number);
    };
  }
}
window.showWatchError = showWatchError;

document.addEventListener('DOMContentLoaded', loadWatch);

// ── Sandboxed Offline Download via IndexedDB ──────────────────
var OFFLINE_STORAGE_KEY = 'anistrim_offline_episodes';
function getOfflineList() { try { return JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) || '[]'); } catch(e) { return []; } }
function saveOfflineList(list) { localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(list)); }
function isEpisodeDownloaded(animeTitle, epNum) { return getOfflineList().some(function(e) { return e.animeTitle === animeTitle && e.episodeNumber === epNum; }); }

async function handleDownload() {
  if (!State.isPremium && !State.isAdmin) { if (confirm('Offline downloads are for premium users only. Upgrade now?')) location.href = 'upgrade.html'; return; }
  if (!currentAnimeTitle || !currentEp) { alert('Cannot download this episode.'); return; }
  if (isEpisodeDownloaded(currentAnimeTitle, currentEp)) { alert('Already downloaded.'); return; }
  try {
    var { data } = await apiFetch('/api/stream/offline-download', { method: 'POST', body: JSON.stringify({ animeTitle: currentAnimeTitle, episodeNumber: currentEp, provider: currentProvider || undefined }) });
    if (!data || !data.authorized || !data.streamUrl) { alert(window._escapeHTML('Download authorization failed.')); return; }
    var downloadInfo = { animeTitle: currentAnimeTitle, episodeNumber: currentEp, streamUrl: data.streamUrl, quality: data.quality || 'auto', provider: data.provider || currentProvider };
    var blob = await (await fetch(data.streamUrl)).blob();
    var offlineList = getOfflineList();
    offlineList.push({ animeTitle: downloadInfo.animeTitle, episodeNumber: downloadInfo.episodeNumber, quality: downloadInfo.quality, provider: downloadInfo.provider, downloadedAt: new Date().toISOString(), blobSize: blob.size, blobType: blob.type });
    saveOfflineList(offlineList);
    await storeBlobInIndexedDB(downloadInfo.animeTitle, downloadInfo.episodeNumber, blob);
    alert('✅ Download complete! (Sandboxed storage)');
  } catch (e) { console.error('Download error:', e); alert('Download failed: ' + e.message); }
}
window.handleDownload = handleDownload;

function closeOfflineModal() { window.__pendingDownload = null; }
window.closeOfflineModal = closeOfflineModal;

async function startOfflineDownload() { alert('Offline download is being processed. Check your downloads.'); }
window.startOfflineDownload = startOfflineDownload;

function deleteOfflineDownload() {
  var list = getOfflineList();
  var filtered = list.filter(function(e) { return !(e.animeTitle === currentAnimeTitle && e.episodeNumber === currentEp); });
  saveOfflineList(filtered);
  deleteBlobFromIndexedDB(currentAnimeTitle, currentEp);
  alert('🗑️ Deleted from offline storage.');
}
window.deleteOfflineDownload = deleteOfflineDownload;

// ── IndexedDB Sandboxed Storage ──────────────────────────────
var DB_NAME = 'AnistrimOfflineDB';
var DB_VERSION = 1;
var STORE_NAME = 'episodes';

function openOfflineDB() {
  return new Promise(function(resolve, reject) {
    var request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function(event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function() { reject(request.error); };
  });
}

async function storeBlobInIndexedDB(animeTitle, episodeNumber, blob) {
  var db = await openOfflineDB();
  var tx = db.transaction(STORE_NAME, 'readwrite');
  var store = tx.objectStore(STORE_NAME);
  store.put({ id: animeTitle + '_ep' + episodeNumber, animeTitle: animeTitle, episodeNumber: episodeNumber, blob: blob, storedAt: new Date().toISOString() });
  return new Promise(function(resolve, reject) { tx.oncomplete = function() { resolve(); }; tx.onerror = function() { reject(tx.error); }; });
}

async function getBlobFromIndexedDB(animeTitle, episodeNumber) {
  var db = await openOfflineDB();
  var tx = db.transaction(STORE_NAME, 'readonly');
  var store = tx.objectStore(STORE_NAME);
  var request = store.get(animeTitle + '_ep' + episodeNumber);
  return new Promise(function(resolve, reject) { request.onsuccess = function() { resolve(request.result ? request.result.blob : null); }; request.onerror = function() { reject(request.error); }; });
}

async function deleteBlobFromIndexedDB(animeTitle, episodeNumber) {
  var db = await openOfflineDB();
  var tx = db.transaction(STORE_NAME, 'readwrite');
  var store = tx.objectStore(STORE_NAME);
  store.delete(animeTitle + '_ep' + episodeNumber);
  return new Promise(function(resolve, reject) { tx.oncomplete = function() { resolve(); }; tx.onerror = function() { reject(tx.error); }; });
}

// ── HLS / Stream Source Attacher ─────────────────────────────
async function downloadEpisode(ep) {
  if (!State.isPremium && !State.isAdmin) { if (confirm('Offline downloads are available for premium users only. Upgrade now?')) location.href = 'upgrade.html'; return; }
  if (!ep || !ep.id) { alert('Cannot download this episode.'); return; }
  try {
    var token = State.token || localStorage.getItem('token') || '';
    var response = await fetch(API + '/api/download/' + ep.id, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!response.ok) {
      var errData = await response.json().catch(function() { return {}; });
      throw new Error(errData.message || 'Download failed (status ' + response.status + ')');
    }
    var blob = await response.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (currentAnime && currentAnime.title || 'anime') + '_ep' + currentEp + '.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    console.error('Download error:', e);
    alert('Download failed: ' + (e.message || 'Please try again.'));
  }
}

function attachStreamSource(video, source) {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  var isHlsStream = /\.m3u8(?:$|\?)/i.test(source);
  return new Promise(function(resolve, reject) {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out loading video source.'));
    }, SOURCE_ATTACH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
    }

    if (isHlsStream && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(source);
      hlsInstance.attachMedia(video);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, function() {
        cleanup();
        watchLog('loadedmetadata', { hls: true });
        // Populate adaptive quality selector from HLS levels.
        hlsQualityOptions = [{ label: 'Auto', value: -1 }];
        currentQualityIndex = -1;
        const qualityValue = document.getElementById('quality-value');
        if (qualityValue) qualityValue.textContent = 'Auto';
        refreshHlsQualityOptions();
        refreshAudioTracks();
        populateAudioOptions();
        refreshSubtitleTracks();
        populateSubtitleOptions();
        resolve();
      });
      hlsInstance.on(window.Hls.Events.LEVEL_SWITCHED, function(_e, data) {
        if (data && data.level >= 0) {
          const qualityValue = document.getElementById('quality-value');
          if (qualityValue && currentQualityIndex === -1) {
            const lvl = hlsInstance.levels && hlsInstance.levels[data.level];
            if (lvl && lvl.height) qualityValue.textContent = lvl.height + 'p';
          }
        }
      });
      hlsInstance.on(window.Hls.Events.ERROR, function(_event, data) {
        if (data.fatal) {
          cleanup();
          reject(new Error('HLS playback could not start.'));
        }
      });
      return;
    }

    video.src = source;
    video.addEventListener('loadedmetadata', function() {
      cleanup();
      watchLog('loadedmetadata', { hls: false });
      // For non-HLS direct sources, refresh quality options.
      currentQualityIndex = -1;
      refreshHlsQualityOptions();
      refreshAudioTracks();
      populateAudioOptions();
      refreshSubtitleTracks();
      populateSubtitleOptions();
      resolve();
    }, { once: true });
    video.addEventListener('error', function() {
      cleanup();
      reject(new Error('Video source could not be loaded.'));
    }, { once: true });
    video.load();
  });
}

function refreshHlsQualityOptions() {
  // Populates the quality settings list from current source/HLS state.
  const container = document.getElementById('quality-options');
  if (!container) return;
  populateQualityOptions();
}

async function loadSkipTimes(animeId, episodeNumber) {
  introRange = null;
  try {
    var { data } = await apiFetch('/api/watch/skip-times/' + encodeURIComponent(animeId) + '/' + encodeURIComponent(episodeNumber), { timeout: API_TIMEOUT_MS });
    if (data && data.op && Number.isFinite(Number(data.op.start)) && Number.isFinite(Number(data.op.end))) {
      introRange = { start: Number(data.op.start), end: Number(data.op.end) };
    }
  } catch (error) {
    console.debug('No skip-intro marker available:', error.message);
  }
}