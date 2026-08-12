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
//   • Settings menu (quality, speed, subtitles, audio tracks, autoplay)
//   • Episode sidebar drawer with season navigation, watched state,
//     progress percentage, thumbnails, and current-episode highlight
//   • End-of-episode overlay with countdown, Next Episode, Replay,
//     Episode List, Exit Player, and Cancel
//   • Resume/Restart overlay for near-end continues
//   • Continue Watching support (persisted position, duration, timestamp)
//   • Keyboard shortcuts, mouse controls, touch controls
//   • Center action indicators + buffering spinner

// ── Episode Identity ────────────────────────────────────────
//   episodeId        = Database record ID (used for progress saving, DB lookups)
//   episodeNumber    = Sequential episode number (1, 2, 3...) (used for streaming)
//   allEpisodes      = Full episode list for the anime (all seasons)
//   seasonEpisodes   = Filtered episode list for the active season

let requestId = 'W' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
function watchLog(event, meta = {}) {
  const entry = { requestId, event, timestamp: new Date().toISOString(), ...meta };
  console.log(`[WATCH] ${event}`, entry);
}
function setLoadingStatus(text) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = text;
}

// ── Core player state ────────────────────────────────────────
let currentAnime = null;
let currentAnimeId = null;
let currentEp = 1;
let nextEpData = null;
let prevEpData = null;
let currentEpId = null;
let autoplayCountdown = null;
let introRange = null;
let outroRange = null;
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
let autoplayCountdownSeconds = parseInt(localStorage.getItem('anistrim_autoplay_seconds') || '10', 10);
let speedValue = parseFloat(localStorage.getItem('anistrim_speed') || '1');
let lastTapTime = 0;
let lastTapX = 0;
let suppressNextClick = false;
let cancelledNext = false;
let hlsQualityOptions = [{ label: 'Auto', value: -1 }];
let currentQualityIndex = -1; // -1 = Auto
let subtitleTracksList = [];
let audioTracksList = [];
let playerSetupDone = false;

// ── Episode list / season / progress state ──────────────────
let allEpisodes = [];          // full episode list (all seasons)
let seasonEpisodes = [];       // episodes filtered by current season
let currentSeason = 1;
let seasonNumbers = [];        // sorted unique season numbers
let episodeProgressMap = {};   // batch progress: { epNum: { progressSec, durationSec, watched } }

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
  console.log('[PLAYBACK] Requested episode', { url: window.location.href });

  // Global safety timeout — never leave the user stuck on "Preparing player..."
  const PLAYBACK_TOTAL_TIMEOUT_MS = 90000;
  let playbackTimeout = setTimeout(() => {
    console.error('[PLAYBACK] Total playback timeout exceeded');
    showWatchError('Playback timed out. Please try again.');
  }, PLAYBACK_TOTAL_TIMEOUT_MS);

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

  if (!animeId) { clearTimeout(playbackTimeout); showWatchError('Missing anime ID. Please go back and try again.'); return; }

  try {
    setLoadingStatus('Finding episode...');
    watchLog('anime request started', { animeId });

    const animeRes = await apiFetch('/api/anime/' + animeId, { timeout: API_TIMEOUT_MS });
    if (animeRes.timedOut) {
      console.error('[PLAYBACK] Anime fetch timed out', { animeId });
      clearTimeout(playbackTimeout);
      showWatchError('Timed out loading anime data. Please check your connection and try again.');
      return;
    }
    const animeData = animeRes.data;
    currentAnime = animeData;
    currentAnimeId = animeData && animeData.id ? String(animeData.id) : animeId;
    if (!animeData || !animeData.id) {
      console.error('[PLAYBACK] Invalid anime data', { animeId, ok: animeRes.ok, status: animeRes.status });
      clearTimeout(playbackTimeout);
      showWatchError('Could not load anime data.');
      return;
    }
    watchLog('anime request completed', { animeId, title: animeData.title });
    console.log('[PLAYBACK] Loaded anime', { animeId, title: animeData.title });

    currentAnimeTitle = window._escapeHTML(animeData.title);
    const loadingAnimeTitle = document.getElementById('loading-anime-title');
    const loadingEpisodeInfo = document.getElementById('loading-episode-info');
    if (loadingAnimeTitle) loadingAnimeTitle.textContent = currentAnimeTitle;
    if (loadingEpisodeInfo) loadingEpisodeInfo.textContent = 'Episode ' + currentEp;
    document.title = 'Ep ' + currentEp + ' - ' + window._escapeHTML(animeData.title) + ' | AniStrim';
    document.getElementById('watch-ep-title').textContent = 'Episode ' + currentEp;
    document.getElementById('watch-anime-title').textContent = currentAnimeTitle;

    // Populate sidebar title
    const sidebarTitleEl = document.getElementById('sidebar-anime-title');
    if (sidebarTitleEl) sidebarTitleEl.textContent = currentAnimeTitle;

    watchLog('episodes request started', { animeId });
    const episodesRes = await apiFetch('/api/anime/' + animeId + '/episodes', { timeout: API_TIMEOUT_MS });
    if (episodesRes.timedOut) {
      console.error('[PLAYBACK] Episodes fetch timed out', { animeId });
      clearTimeout(playbackTimeout);
      showWatchError('Timed out loading episode list. Please try again.');
      return;
    }
    const episodesData = episodesRes.data;
    const episodes = Array.isArray(episodesData) ? episodesData : [];
    watchLog('episodes request completed', { animeId, count: episodes.length });
    console.log('[PLAYBACK] Loaded episodes', { animeId, count: episodes.length });
    if (!episodes.length) console.warn('[PLAYBACK] No episodes found for anime', { animeId });

    // Store full episode list and build season list
    allEpisodes = episodes;
    seasonNumbers = Array.from(new Set(episodes.map(e => (e.season || 1)))).sort((a, b) => a - b);
    currentSeason = episodes.find(e => (e.number || e.episode_number) === currentEp)?.season || seasonNumbers[0] || 1;

    // Filter episodes for current season
    seasonEpisodes = allEpisodes.filter(e => (e.season || 1) === currentSeason);
    if (!seasonEpisodes.length && allEpisodes.length) {
      seasonEpisodes = allEpisodes;
    }

    // Resolve current, next, prev episodes from the full list
    let ep;
    if (params.get('epId')) {
      ep = episodes.find(function(e) { return String(e.id) === String(params.get('epId')); });
    }
    if (!ep) {
      ep = episodes.find(function(e) { return (e.number || e.episode_number) === currentEp; });
    }
    currentEpId = ep && ep.id ? ep.id : null;
    const epNum = (ep && (ep.number || ep.episode_number)) || currentEp;
    nextEpData = episodes.find(function(e) { return (e.number || e.episode_number) === epNum + 1; }) || null;
    prevEpData = episodes.find(function(e) { return (e.number || e.episode_number) === epNum - 1; }) || null;

    // ── Fetch batch progress and render episode sidebar ──────
    await loadBatchProgress(animeId);
    renderEpisodeSidebar(episodes, animeId);

    // Populate season navigation
    renderSeasonNav();

    // Update sidebar season label
    updateSidebarSeasonLabel();

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
        console.log('[PLAYBACK] Resolving stream', { animeTitle: animeData.title, episode: currentEp });
        await resolveAndPlayStream(animeData.title, currentEp, video);
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        watchLog('stream resolution completed', { episode: currentEp });
        console.log('[PLAYBACK] Stream resolved', { provider: currentProvider, quality: currentStreamQuality });
        setupPlayer(video);
        console.log('[PLAYBACK] Player initialization');
      } catch (err) {
        console.error('[PLAYBACK] Stream resolution failed', { episode: currentEp, error: err.message });
        clearTimeout(playbackTimeout);
        showWatchError(err.message || 'Stream resolution failed.');
      }
    }

    loadSkipTimes(animeId, epNum);
    loadSkipTimesForNext(nextEpData, animeId);

    if (!(State.isPremium || State.isAdmin)) {
      startMidRollAdTracker(video);
    }

    clearTimeout(playbackTimeout);

  } catch(e) {
    console.error('[PLAYBACK] Watch error', { error: e.message });
    clearTimeout(playbackTimeout);
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
  if (playerSetupDone) return;
  playerSetupDone = true;

  const wrap = document.getElementById('player-wrap');
  const skipBtn = document.getElementById('skip-intro-btn');
  const skipOutroBtn = document.getElementById('skip-outro-btn');
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

  if (currentEpId) loadProgress(video, currentAnimeId, currentEp);

  // ── Time / Progress updates ──────────────────────────────
  video.addEventListener('timeupdate', function() {
    updateProgressBarUI(video);
    updateTimeDisplay(video);

    // Skip intro
    if (isPremium && introRange && video.currentTime >= introRange.start && video.currentTime < introRange.end) {
      if (skipBtn) skipBtn.style.display = 'block';
    } else {
      if (skipBtn) skipBtn.style.display = 'none';
    }

    // Skip outro
    if (isPremium && outroRange && video.currentTime >= outroRange.start && video.currentTime < outroRange.end) {
      if (skipOutroBtn) skipOutroBtn.style.display = 'block';
    } else {
      if (skipOutroBtn) skipOutroBtn.style.display = 'none';
    }

    // Next-episode overlay near end (premium)
    if (isPremium && nextEpData && video.duration) {
      var remaining = video.duration - video.currentTime;
      if (remaining <= 30 && remaining > 0 && !cancelledNext) {
        showEndOverlay();
      } else if (remaining > 30) {
        hideEndOverlay();
      }
    }

    // Progress save (throttled — every 30 seconds)
    if (currentEpId && Math.floor(video.currentTime) % 30 === 0 && video.currentTime > 0) {
      saveProgress(currentEpId, Math.floor(video.currentTime), false, Math.floor(video.duration));
    }
  });

  // Save duration once metadata is available
  video.addEventListener('loadedmetadata', function() {
    if (currentEpId && video.duration && isFinite(video.duration) && video.duration > 0) {
      saveProgress(currentEpId, Math.floor(video.currentTime || 0), false, Math.floor(video.duration));
    }
  });

  // Buffered progress indicator
  video.addEventListener('progress', function() {
    updateBufferedUI(video);
  });

  video.addEventListener('ended', function() {
    if (currentEpId) saveProgress(currentEpId, Math.floor(video.duration || 0), true, Math.floor(video.duration || 0));
    wrap.classList.add('ended');
    cancelledNext = false;
    if (isPremium && nextEpData) {
      showEndOverlay();
      if (autoplayEnabled) {
        startAutoplayCountdown();
      }
    } else if (!isPremium && nextEpData) {
      showEndOverlay();
      const countdownBadge = document.getElementById('next-ep-countdown-badge');
      if (countdownBadge) countdownBadge.parentElement.style.display = 'none';
    } else {
      // No next episode — show overlay with just replay + episode list + exit
      showEndOverlay();
      hideAutoplayCountdown();
    }
  });

  video.addEventListener('play', function() {
    wrap.classList.remove('paused', 'ended');
    cancelledNext = false;
    hideEndOverlay();
    hideResumePrompt();
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
  if (skipOutroBtn) skipOutroBtn.addEventListener('click', skipOutro);

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
    renderEpisodeSidebar(allEpisodes, currentAnimeId);
    renderSeasonNav();
    updateSidebarSeasonLabel();
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
  document.getElementById('countdown-config-btn')?.addEventListener('click', () => {
    const presets = document.getElementById('countdown-presets');
    if (presets) presets.style.display = presets.style.display === 'block' ? 'none' : 'block';
  });
  document.querySelectorAll('[data-countdown]').forEach(btn => {
    btn.addEventListener('click', () => {
      autoplayCountdownSeconds = parseInt(btn.getAttribute('data-countdown'), 10);
      localStorage.setItem('anistrim_autoplay_seconds', String(autoplayCountdownSeconds));
      updateAutoplayUI();
      const presets = document.getElementById('countdown-presets');
      if (presets) presets.style.display = 'none';
      showControls();
    });
  });
  updateAutoplayUI();

  // Subtitle appearance & player preferences
  initSubtitlePrefsUI();
  initPlayerPrefsUI();
  applySubtitlePrefs();
  applyPlayerPrefs();

  // End-of-episode overlay controls
  document.getElementById('play-next-btn')?.addEventListener('click', playNextEp);
  document.getElementById('replay-btn')?.addEventListener('click', () => {
    hideEndOverlay();
    var v = document.getElementById('animePlayer');
    if (v) { v.currentTime = 0; v.play()['catch'](function(){}); }
  });
  document.getElementById('episode-list-btn')?.addEventListener('click', () => {
    hideEndOverlay();
    document.getElementById('episode-sidebar')?.classList.add('visible');
    renderEpisodeSidebar(allEpisodes, currentAnimeId);
    renderSeasonNav();
    updateSidebarSeasonLabel();
  });
  document.getElementById('exit-player-btn')?.addEventListener('click', () => {
    window.location.href = 'browse.html';
  });
  document.getElementById('cancel-next-btn')?.addEventListener('click', () => {
    cancelAutoplay();
    hideEndOverlay();
    cancelledNext = true;
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
  // Never hide when paused, ended, scrubbing or when metadata still loading,
  // or when the end-of-episode / resume overlay is visible.
  if (!video || video.paused || video.ended || isScrubbing) return;
  if (!isFinite(video.duration)) return;
  const endOverlay = document.getElementById('next-episode-overlay');
  const resumeOverlay = document.getElementById('resume-overlay');
  if (endOverlay && endOverlay.style.display === 'flex') return;
  if (resumeOverlay && resumeOverlay.style.display === 'flex') return;
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
        e.target.closest('.resume-prompt') ||
        e.target.closest('.progress-bar-container') ||
        e.target.closest('.player-sidebar') ||
        e.target.closest('.buffering-spinner')) return;
    var video = document.getElementById('animePlayer');
    if (!video) return;
    if (isTouchDevice()) {
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

// ── In-player episode navigation (no page reload) ──────────
async function switchToEpisode(epNum) {
  if (!currentAnimeId || !epNum) return;
  const epNumber = parseInt(epNum, 10);
  const ep = allEpisodes.find(function(e) { return (e.number || e.episode_number) === epNumber; });
  if (!ep) {
    // Fallback: reload the page with the episode in the URL
    window.location.href = 'watch.html?id=' + currentAnimeId + '&ep=' + epNumber;
    return;
  }

  // Update current episode state
  currentEp = epNumber;
  currentEpId = ep.id || null;

  // Update top bar title
  const epTitleEl = document.getElementById('watch-ep-title');
  if (epTitleEl) epTitleEl.textContent = 'Episode ' + epNumber;
  document.title = 'Ep ' + epNumber + ' - ' + window._escapeHTML(ep.title || (currentAnime && currentAnime.title)) + ' | AniStrim';

  // Resolve next/prev
  nextEpData = allEpisodes.find(function(e) { return (e.number || e.episode_number) === epNumber + 1; }) || null;
  prevEpData = allEpisodes.find(function(e) { return (e.number || e.episode_number) === epNumber - 1; }) || null;

  // Hide overlays
  hideEndOverlay();
  hideResumePrompt();
  cancelAutoplay();
  cancelledNext = false;

  // Show loading
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'flex';
  setLoadingStatus('Loading video...');

  const video = document.getElementById('animePlayer');
  if (!video) return;

  // Preserve play state
  const wasPlaying = !video.paused;
  const wasMuted = video.muted;

  // Destroy existing HLS instance
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
    playerSetupDone = false;
  }

  let sourceUrl = ep.video_url;
  if (!sourceUrl) {
    // Resolve stream from backend
    setLoadingStatus('Finding stream...');
    try {
      // Use the RAW anime title (not HTML-escaped) for the backend API call.
      const rawAnimeTitle = currentAnime && currentAnime.title ? currentAnime.title : currentAnimeTitle;
      const streamRes = await apiFetch('/api/stream/' + encodeURIComponent(rawAnimeTitle) + '/' + epNumber, { timeout: STREAM_TIMEOUT_MS });
      if (streamRes.timedOut || !streamRes.data || !streamRes.data.sources || !streamRes.data.sources.length) {
        throw new Error('No stream sources returned for this episode.');
      }
      const API_BASE_URL = window.getApiBaseUrl();
      const sourcesToTry = streamRes.data.sources.map(s => ({
        ...s,
        url: s.url.startsWith('http') ? s.url : API_BASE_URL + s.url
      }));
      currentStreamSources = sourcesToTry;
      sourceUrl = sourcesToTry[0].url;
      currentProvider = streamRes.data.provider || 'unknown';
      currentStreamQuality = sourcesToTry[0].quality || 'auto';
    } catch (err) {
      showWatchError(err.message || 'Stream resolution failed for this episode.');
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      return;
    }
  }

  try {
    await attachStreamSource(video, sourceUrl);
    if (loadingOverlay) loadingOverlay.style.display = 'none';

    // Re-setup player (event listeners are idempotent now)
    playerSetupDone = false;
    setupPlayer(video);

    // Wait for metadata then restore position
    const savedProgress = episodeProgressMap[String(epNumber)];
    let restorePos = 0;
    if (savedProgress && savedProgress.progressSec > 10 && savedProgress.durationSec > 0
        && savedProgress.progressSec < savedProgress.durationSec * 0.95) {
      restorePos = savedProgress.progressSec;
    }

    video.addEventListener('loadedmetadata', function() {
      video.volume = wasMuted ? 0 : 1;
      video.muted = wasMuted;
      updateVolumeIcon();
      updateVolumeSlider();
      if (restorePos > 0 && restorePos < (video.duration || Infinity)) {
        video.currentTime = restorePos;
      }
      if (wasPlaying) {
        video.play()['catch'](function(){});
      }
      // Re-fetch skip times for the new episode
      loadSkipTimes(currentAnimeId, epNumber);
    }, { once: true });

    // Update sidebar current-episode highlight
    updateSidebarHighlight(epNumber);

    // Update URL without reloading
    const newUrl = 'watch.html?id=' + currentAnimeId + '&ep=' + epNumber;
    window.history.replaceState({ path: newUrl }, '', newUrl);

    watchLog('episode switched in-player', { from: allEpisodes.find(e => (e.number||e.episode_number) === currentEp - 1)?.id || null, to: epNumber, episodeId: ep.id });
  } catch (err) {
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    showWatchError(err.message || 'Failed to load episode. Please try again.');
  }
}
window.switchToEpisode = switchToEpisode;

// ── Season navigation ──────────────────────────────────────
function renderSeasonNav() {
  const nav = document.getElementById('season-nav');
  if (!nav) return;

  if (seasonNumbers.length <= 1) {
    nav.style.display = 'none';
    return;
  }

  nav.style.display = 'flex';
  nav.innerHTML = seasonNumbers.map(function(seasonNum) {
    const isActive = seasonNum === currentSeason;
    const epCount = allEpisodes.filter(e => (e.season || 1) === seasonNum).length;
    return `<button class="season-btn${isActive ? ' active' : ''}" data-season="${seasonNum}">
      <span class="season-num">Season ${seasonNum}</span>
      <span class="season-count">${epCount} eps</span>
    </button>`;
  }).join('');

  nav.querySelectorAll('[data-season]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const seasonNum = parseInt(btn.getAttribute('data-season'), 10);
      switchSeason(seasonNum);
    });
  });
}

function switchSeason(seasonNum) {
  if (seasonNumbers.length <= 1) return;
  currentSeason = seasonNum;

  // Filter episodes for the selected season
  seasonEpisodes = allEpisodes.filter(e => (e.season || 1) === seasonNum);
  if (!seasonEpisodes.length) seasonEpisodes = allEpisodes;

  // Update season label
  updateSidebarSeasonLabel();

  // Re-render the episode list
  renderSeasonEpisodes();

  // Update season nav active state
  const seasonNav = document.getElementById('season-nav');
  if (seasonNav) {
    seasonNav.querySelectorAll('.season-btn').forEach(function(btn) {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-season'), 10) === seasonNum);
    });
  }

  watchLog('season switched', { season: seasonNum, epCount: seasonEpisodes.length });
}
window.switchSeason = switchSeason;

function updateSidebarSeasonLabel() {
  const labelEl = document.getElementById('sidebar-season-label');
  if (labelEl) labelEl.textContent = 'Season ' + currentSeason;

  const countEl = document.getElementById('sidebar-ep-count');
  if (countEl) {
    const count = seasonEpisodes.length || allEpisodes.length;
    countEl.textContent = count + ' Episodes';
  }
}

// ════════════════════════════════════════════════════════════
//  EPISODE SIDEBAR RENDERING
// ════════════════════════════════════════════════════════════
function renderEpisodeSidebar(episodes, animeId) {
  renderSeasonEpisodes();
}

function renderSeasonEpisodes() {
  var container = document.getElementById('sidebar-episode-list');
  if (!container) return;

  const eps = seasonEpisodes.length ? seasonEpisodes : allEpisodes;
  if (!eps.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No episodes available.</p>';
    return;
  }

  container.innerHTML = eps.map(function(e) {
    var isLocked = e.is_premium && !State.isPremium && !State.isAdmin;
    var displayNum = e.number || e.episode_number;
    var epTitle = e.title && e.title !== 'undefined' ? e.title : 'Episode ' + displayNum;
    var thumbSrc = e.thumbnail_url && e.thumbnail_url.trim() && e.thumbnail_url !== 'undefined' ? e.thumbnail_url : makeFallbackImg(epTitle);
    var lockIcon = isLocked ? '🔒' : '▶';
    var premiumTag = e.is_premium ? '<span class="ep-premium-badge">👑</span>' : '';

    // Progress data
    var prog = episodeProgressMap[String(displayNum)];
    var progressPct = 0;
    var isWatched = false;
    var epDuration = (e.duration_sec || e.duration || 0);
    if (prog) {
      isWatched = prog.watched;
      if (prog.durationSec > 0) {
        progressPct = Math.round((prog.progressSec / prog.durationSec) * 100);
      }
    }
    var watchedClass = isWatched ? 'watched' : (progressPct > 0 ? 'in-progress' : 'unwatched');
    if (isWatched) lockIcon = '✓';

    // Download availability
    var downloadBadge = '';
    if (typeof isEpisodeDownloaded === 'function' && isEpisodeDownloaded(currentAnimeTitle, displayNum)) {
      downloadBadge = '<span class="ep-download-badge" title="Downloaded">⬇</span>';
    }

    // Current episode
    var currentClass = displayNum === currentEp ? 'current' : '';

    var progressBar = progressPct > 0 ? `<div class="ep-progress-bar"><div class="ep-progress-fill" style="width:${Math.min(100, progressPct)}%"></div></div>` : '';
    var durationText = epDuration ? fmtTime(epDuration) : '';

    return `<div class="episode-item ${currentClass} ${watchedClass}" onclick="switchToEpisode(${displayNum})">
              <div class="ep-thumb-wrap">
                <img src="${thumbSrc}" alt="${epTitle.replace(/'/g,"\\'")}" loading="lazy" onerror="cardImgError(this,'${epTitle.replace(/'/g,"\\'")}')">
                <span class="ep-play-icon">${lockIcon}</span>
                ${progressBar}
              </div>
              <div class="ep-info">
                <div class="ep-title">${window._escapeHTML(epTitle)} ${premiumTag} ${downloadBadge}</div>
                <div class="ep-meta-row">
                  <span class="ep-duration">${durationText}</span>
                  <span class="ep-watched-state">${isWatched ? 'Watched' : (progressPct > 0 ? progressPct + '% watched' : 'Unwatched')}</span>
                </div>
              </div>
            </div>`;
  }).join('');
}

function updateSidebarHighlight(epNum) {
  const items = document.querySelectorAll('.episode-item');
  items.forEach(function(item) {
    item.classList.toggle('current', false);
  });
  // The re-render in switchToEpisode will set the current class
  // But if sidebar is open, re-render to update highlights
  const sidebar = document.getElementById('episode-sidebar');
  if (sidebar && sidebar.classList.contains('visible')) {
    renderEpisodeSidebar(allEpisodes, currentAnimeId);
  }
}

// ════════════════════════════════════════════════════════════
//  BATCH PROGRESS
// ════════════════════════════════════════════════════════════
async function loadBatchProgress(animeId) {
  try {
    watchLog('batch progress request started', { animeId });
    var { data, timedOut } = await apiFetch('/api/watch/progress/batch/' + animeId, { timeout: API_TIMEOUT_MS });
    if (timedOut) return;
    if (data && typeof data === 'object') {
      episodeProgressMap = data;
      watchLog('batch progress loaded', { count: Object.keys(data).length });

      // If sidebar is open, re-render to show updated progress
      const sidebar = document.getElementById('episode-sidebar');
      if (sidebar && sidebar.classList.contains('visible')) {
        renderEpisodeSidebar(allEpisodes, currentAnimeId);
      }
    }
  } catch (e) {
    console.debug('Could not fetch batch progress:', e.message);
  }
}
window.loadBatchProgress = loadBatchProgress;

// ════════════════════════════════════════════════════════════
//  END-OF-EPISODE OVERLAY
// ════════════════════════════════════════════════════════════
async function showEndOverlay() {
  const nextBanner = document.getElementById('next-episode-overlay');
  if (!nextBanner) return;

  // Resolve next episode data if not cached
  if (nextEpData) {
    document.getElementById('next-ep-title-overlay').textContent =
      (nextEpData.title && nextEpData.title !== 'undefined')
        ? nextEpData.title
        : 'Episode ' + (nextEpData.number || nextEpData.episode_number);
    document.getElementById('next-ep-time-meta').textContent = '';

    // Try to fetch next episode sources for immediate playback
    try {
      resolveNextEpisodeFromAPI();
    } catch (e) {
      console.debug('Could not pre-resolve next episode:', e.message);
    }
  }

  // Show countdown countdown badge if autoplay is enabled
  const countdownBadge = document.getElementById('next-ep-countdown-badge');
  if (countdownBadge) {
    if (autoplayEnabled) {
      countdownBadge.textContent = String(autoplayCountdownSeconds);
      countdownBadge.parentElement.style.display = 'flex';
    } else {
      countdownBadge.parentElement.style.display = 'none';
    }
  }

  nextBanner.style.display = 'flex';
}

function hideEndOverlay() {
  const nextBanner = document.getElementById('next-episode-overlay');
  if (nextBanner) nextBanner.style.display = 'none';
}

function hideAutoplayCountdown() {
  const countdownBadge = document.getElementById('next-ep-countdown-badge');
  if (countdownBadge) countdownBadge.parentElement.style.display = 'none';
}

// Pre-resolve next episode sources in the background (so playback is instant)
async function resolveNextEpisodeFromAPI() {
  try {
    if (!currentAnimeId || !nextEpData) return;
    const epNum = nextEpData.number || nextEpData.episode_number;
    var { data } = await apiFetch('/api/watch/next/' + currentAnimeId + '/' + epNum, { timeout: API_TIMEOUT_MS });
    if (data && data.success && data.hasNextEpisode) {
      // Store resolved sources for instant playback
      window.__nextEpisodeSources = data;
    }
  } catch (e) {
    console.debug('Next episode pre-resolution failed:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  RESUME / RESTART OVERLAY (near-end continue)
// ════════════════════════════════════════════════════════════
function showResumePrompt(progressData) {
  const overlay = document.getElementById('resume-overlay');
  if (!overlay) return;

  // Don't show if already playing or ended
  var video = document.getElementById('animePlayer');
  if (!video || !video.paused) return;

  const pct = progressData.totalDurationSeconds > 0
    ? Math.round((progressData.progressSeconds / progressData.totalDurationSeconds) * 100)
    : 0;

  document.getElementById('resume-progress-pct').textContent = pct + '%';
  document.getElementById('resume-saved-time').textContent =
    ' at ' + fmtTime(progressData.progressSeconds);

  document.getElementById('resume-continue-btn').onclick = function() {
    hideResumePrompt();
    // Seek will have been applied by loadProgress, just play
    video.play()['catch'](function(){});
  };

  document.getElementById('resume-restart-btn').onclick = function() {
    hideResumePrompt();
    if (video) { video.currentTime = 0; }
    video.play()['catch'](function(){});
  };

  overlay.style.display = 'flex';
}

function hideResumePrompt() {
  const overlay = document.getElementById('resume-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ════════════════════════════════════════════════════════════
//  AUTOPLAY COUNTDOWN
// ════════════════════════════════════════════════════════════
function startAutoplayCountdown() {
  if (!autoplayEnabled) return;

  const nextBanner = document.getElementById('next-episode-overlay');
  const countdownBadge = document.getElementById('next-ep-countdown-badge');
  if (nextBanner) nextBanner.style.display = 'flex';
  if (countdownBadge) {
    countdownBadge.parentElement.style.display = 'flex';
    countdownBadge.textContent = String(autoplayCountdownSeconds);
  }

  var sec = autoplayCountdownSeconds;
  if (countdownBadge) countdownBadge.textContent = sec;

  cancelAutoplay();
  autoplayCountdown = setInterval(function() {
    sec--;
    if (countdownBadge) countdownBadge.textContent = sec > 0 ? String(sec) : '';
    if (sec <= 0) {
      cancelAutoplay();
      playNextEp();
    }
  }, 1000);
}

function cancelAutoplay() {
  if (autoplayCountdown) { clearInterval(autoplayCountdown); autoplayCountdown = null; }
  const countdownBadge = document.getElementById('next-ep-countdown-badge');
  if (countdownBadge) countdownBadge.parentElement.style.display = 'none';
}
window.cancelAutoplay = cancelAutoplay;

// ════════════════════════════════════════════════════════════
//  PROGRESS SAVE / LOAD
// ════════════════════════════════════════════════════════════
async function loadProgress(video, animeId, episodeNumber) {
  try {
    var { data } = await apiFetch('/api/watch/progress/' + animeId + '/' + episodeNumber, { timeout: API_TIMEOUT_MS });
    if (data && data.progressSeconds > 10) {
      // Near-end detection: if 90%+ watched, offer Resume/Restart
      if (data.totalDurationSeconds > 0 && data.progressSeconds >= data.totalDurationSeconds * 0.9) {
        showResumePrompt(data);
      }
      video.addEventListener('loadedmetadata', function() {
        if (data.progressSeconds < (video.duration || Infinity)) {
          video.currentTime = data.progressSeconds;
        }
        // If near-end and user didn't choose, just resume from saved position
      }, { once: true });
    }
  } catch(e) {}
}

async function saveProgress(epId, sec, completed, durationSec) {
  try {
    await apiFetch('/api/watchlist/progress', {
      method: 'POST',
      body: JSON.stringify({
        episodeId: epId,
        progressSec: sec,
        completed: completed,
        durationSec: durationSec || 0
      })
    });
  } catch(e) {}
}
window.saveProgress = saveProgress;

// ════════════════════════════════════════════════════════════
//  SKIP INTRO / OUTRO  (preserved backend behaviour)
// ════════════════════════════════════════════════════════════
function skipIntro() {
  if (!State.isPremium && !State.isAdmin) return;
  var video = document.getElementById('animePlayer');
  if (introRange) video.currentTime = introRange.end;
  document.getElementById('skip-intro-btn').style.display = 'none';
}
window.skipIntro = skipIntro;

function skipOutro() {
  if (!State.isPremium && !State.isAdmin) return;
  var video = document.getElementById('animePlayer');
  if (outroRange) video.currentTime = outroRange.end;
  document.getElementById('skip-outro-btn').style.display = 'none';
}
window.skipOutro = skipOutro;

function loadSkipTimesForNext(nextEp, animeId) {
  if (!nextEp || !animeId) return;
  // Pre-fetch skip times for the next episode in the background
  loadSkipTimes(animeId, nextEp.number || nextEp.episode_number);
}

// ════════════════════════════════════════════════════════════
//  EPISODE NAVIGATION (in-player)
// ════════════════════════════════════════════════════════════
function goPrevEp() {
  if (!prevEpData || !currentAnime) return;
  switchToEpisode(prevEpData.number || prevEpData.episode_number);
}
window.goPrevEp = goPrevEp;

function goNextEp() {
  if (!nextEpData || !currentAnime) return;
  playNextEp();
}
window.goNextEp = goNextEp;

async function playNextEp() {
  cancelAutoplay();
  hideEndOverlay();

  if (!nextEpData || !currentAnime) return;
  const nextNum = nextEpData.number || nextEpData.episode_number;

  // If we have pre-resolved sources from the API, use them directly
  if (window.__nextEpisodeSources && window.__nextEpisodeSources.success) {
    try {
      const video = document.getElementById('animePlayer');
      const wasMuted = video ? video.muted : false;
      const wrap = document.getElementById('player-wrap');

      // Destroy existing HLS instance
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      playerSetupDone = false;

      const nextEpNum = window.__nextEpisodeSources.episode.number;
      currentEp = nextEpNum;
      currentEpId = window.__nextEpisodeSources.episode.id || null;
      nextEpData = allEpisodes.find(function(e) { return (e.number || e.episode_number) === nextEpNum + 1; }) || null;
      prevEpData = allEpisodes.find(function(e) { return (e.number || e.episode_number) === nextEpNum - 1; }) || null;

      // Update UI
      document.getElementById('watch-ep-title').textContent = 'Episode ' + nextEpNum;
      document.title = 'Ep ' + nextEpNum + ' - ' + window._escapeHTML(currentAnime.title) + ' | AniStrim';

      // Update sidebar highlight
      updateSidebarHighlight(nextEpNum);

      // Load the first source
      const API_BASE_URL = window.getApiBaseUrl();
      const sources = window.__nextEpisodeSources.sources.sources || [];
      let sourceUrl = null;
      if (sources.length > 0) {
        const src = sources[0];
        sourceUrl = src.url.startsWith('http') ? src.url : API_BASE_URL + src.url;
        currentStreamSources = sources.map(s => ({
          ...s,
          url: s.url.startsWith('http') ? s.url : API_BASE_URL + s.url
        }));
        currentProvider = 'animeheaven';
        currentStreamQuality = src.quality || 'auto';
      }

      if (!sourceUrl) {
        throw new Error('No stream URL in resolved next episode');
      }

      // Show loading
      const loadingOverlay = document.getElementById('loading-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      setLoadingStatus('Loading video...');

      await attachStreamSource(video, sourceUrl);
      if (loadingOverlay) loadingOverlay.style.display = 'none';

      // Re-setup player
      playerSetupDone = false;
      setupPlayer(video);

      if (wasMuted) {
        video.muted = true;
        video.volume = 0;
      }
      updateVolumeIcon();
      updateVolumeSlider();

      // Seek to saved position or 0
      const savedProgress = episodeProgressMap[String(nextEpNum)];
      video.addEventListener('loadedmetadata', function() {
        let restorePos = 0;
        if (savedProgress && savedProgress.progressSec > 10 && savedProgress.durationSec > 0
            && savedProgress.progressSec < savedProgress.durationSec * 0.95) {
          restorePos = savedProgress.progressSec;
        }
        if (restorePos > 0 && restorePos < (video.duration || Infinity)) {
          video.currentTime = restorePos;
        }
        video.play()['catch'](function(){});
      }, { once: true });

      // Update URL
      const newUrl = 'watch.html?id=' + currentAnimeId + '&ep=' + nextEpNum;
      window.history.replaceState({ path: newUrl }, '', newUrl);

      window.__nextEpisodeSources = null;
      watchLog('next episode played from pre-resolved sources', { episode: nextEpNum });
      return;
    } catch (err) {
      console.warn('Pre-resolved next episode playback failed, falling back to switchToEpisode:', err.message);
      window.__nextEpisodeSources = null;
    }
  }

  // Fallback: use switchToEpisode
  switchToEpisode(currentEp + 1);
}
window.playNextEp = playNextEp;

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

// ── Autoplay & countdown setting ───────────────────────────
function toggleAutoplaySetting() {
  autoplayEnabled = !autoplayEnabled;
  localStorage.setItem('anistrim_autoplay', autoplayEnabled ? 'on' : 'off');
  updateAutoplayUI();
  showControls();
}

function updateAutoplayUI() {
  const el = document.getElementById('autoplay-value');
  if (el) el.textContent = autoplayEnabled ? 'On' : 'Off';

  const summary = document.getElementById('autoplay-summary');
  if (summary) summary.textContent = autoplayEnabled ? 'On · ' + autoplayCountdownSeconds + 's' : 'Off';

  const countdownVal = document.getElementById('countdown-value');
  if (countdownVal) countdownVal.textContent = autoplayCountdownSeconds + 's';
}

// ════════════════════════════════════════════════════════════
//  SUBTITLE APPEARANCE PREFERENCES (persisted to localStorage)
// ════════════════════════════════════════════════════════════
const SUBTITLE_PREFS_KEY = 'anistrim_subtitle_prefs';
const SUBTITLE_PREFS_DEFAULT = {
  size: 'medium',      // small | medium | large | xlarge
  color: '#ffffff',    // hex color
  background: 'semi',  // semi | opaque | none
  outline: 'drop-shadow', // drop-shadow | outline | none
  position: 'bottom'   // top | bottom
};

let subtitlePrefs = loadSubtitlePrefs();

function loadSubtitlePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTITLE_PREFS_KEY) || '{}');
    return Object.assign({}, SUBTITLE_PREFS_DEFAULT, saved);
  } catch(e) {
    return Object.assign({}, SUBTITLE_PREFS_DEFAULT);
  }
}

function saveSubtitlePrefs() {
  try {
    localStorage.setItem(SUBTITLE_PREFS_KEY, JSON.stringify(subtitlePrefs));
  } catch(e) {}
}

// Apply current subtitle preferences to the video element via CSS
function applySubtitlePrefs() {
  const video = document.getElementById('animePlayer');
  if (!video) return;

  // Text size mapping
  const sizeMap = {
    small: '80%',
    medium: '100%',
    large: '130%',
    xlarge: '160%'
  };
  const fontSize = sizeMap[subtitlePrefs.size] || '100%';

  // Background
  let bgMap = {
    semi: 'rgba(0, 0, 0, 0.6)',
    opaque: '#000000',
    none: 'transparent'
  };
  const bg = bgMap[subtitlePrefs.background] || bgMap.semi;

  // Outline/Shadow
  let textShadow = '';
  if (subtitlePrefs.outline === 'drop-shadow') {
    textShadow = '2px 2px 4px rgba(0,0,0,0.9)';
  } else if (subtitlePrefs.outline === 'outline') {
    textShadow = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
  }

  // Position
  const positionCSS = subtitlePrefs.position === 'top' ? 'top: 8%; bottom: auto;' : 'bottom: 8%; top: auto;';

  // Apply via CSS custom properties on the video
  const style = video.style;
  style.setProperty('--sub-font-size', fontSize);
  style.setProperty('--sub-color', subtitlePrefs.color);
  style.setProperty('--sub-bg', bg);
  style.setProperty('--sub-text-shadow', textShadow);
  style.setProperty('--sub-position', positionCSS);

  // Also apply to ::cue via a dynamically-injected style tag
  applySubtitleCueStyles();
}

function applySubtitleCueStyles() {
  let styleEl = document.getElementById('anistrim-subtitle-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'anistrim-subtitle-styles';
    document.head.appendChild(styleEl);
  }

  const sizeMap = { small: '80%', medium: '100%', large: '130%', xlarge: '160%' };
  const fontSize = sizeMap[subtitlePrefs.size] || '100%';
  const bgMap = { semi: 'rgba(0,0,0,0.6)', opaque: '#000', none: 'transparent' };
  const bg = bgMap[subtitlePrefs.background] || bgMap.semi;
  let textShadow = '';
  if (subtitlePrefs.outline === 'drop-shadow') textShadow = '2px 2px 4px rgba(0,0,0,0.9)';
  else if (subtitlePrefs.outline === 'outline') textShadow = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
  const positionValue = subtitlePrefs.position === 'top' ? '10%' : '92%';

  styleEl.textContent = `
    video::cue {
      font-size: ${fontSize} !important;
      color: ${subtitlePrefs.color} !important;
      background: ${bg} !important;
      text-shadow: ${textShadow || 'none'} !important;
    }
    video::cue(.anistrim-subtitle) {
      position: ${positionValue} !important;
    }
  `;
}

function updateSubtitlePrefsUI() {
  // Size
  document.querySelectorAll('#subtitle-size-options [data-sub-size]').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sub-size') === subtitlePrefs.size);
  });
  // Color
  document.querySelectorAll('#subtitle-color-options [data-sub-color]').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sub-color').toLowerCase() === subtitlePrefs.color.toLowerCase());
  });
  // Background
  document.querySelectorAll('#subtitle-bg-options [data-sub-bg]').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sub-bg') === subtitlePrefs.background);
  });
  // Outline
  document.querySelectorAll('#subtitle-outline-options [data-sub-outline]').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sub-outline') === subtitlePrefs.outline);
  });
  // Position
  document.querySelectorAll('#subtitle-position-options [data-sub-pos]').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sub-pos') === subtitlePrefs.position);
  });

  // Summary value
  const summary = document.getElementById('subtitle-appearance-value');
  if (summary) {
    summary.textContent = subtitlePrefs.size.charAt(0).toUpperCase() + subtitlePrefs.size.slice(1) + ' · ' + subtitlePrefs.color;
  }
}

function initSubtitlePrefsUI() {
  const sizeOpts = document.getElementById('subtitle-size-options');
  if (sizeOpts) {
    sizeOpts.querySelectorAll('[data-sub-size]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        subtitlePrefs.size = btn.getAttribute('data-sub-size');
        saveSubtitlePrefs();
        applySubtitlePrefs();
        updateSubtitlePrefsUI();
        showControls();
      });
    });
  }

  const colorOpts = document.getElementById('subtitle-color-options');
  if (colorOpts) {
    colorOpts.querySelectorAll('[data-sub-color]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        subtitlePrefs.color = btn.getAttribute('data-sub-color');
        saveSubtitlePrefs();
        applySubtitlePrefs();
        updateSubtitlePrefsUI();
        showControls();
      });
    });
  }

  const bgOpts = document.getElementById('subtitle-bg-options');
  if (bgOpts) {
    bgOpts.querySelectorAll('[data-sub-bg]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        subtitlePrefs.background = btn.getAttribute('data-sub-bg');
        saveSubtitlePrefs();
        applySubtitlePrefs();
        updateSubtitlePrefsUI();
        showControls();
      });
    });
  }

  const outlineOpts = document.getElementById('subtitle-outline-options');
  if (outlineOpts) {
    outlineOpts.querySelectorAll('[data-sub-outline]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        subtitlePrefs.outline = btn.getAttribute('data-sub-outline');
        saveSubtitlePrefs();
        applySubtitlePrefs();
        updateSubtitlePrefsUI();
        showControls();
      });
    });
  }

  const posOpts = document.getElementById('subtitle-position-options');
  if (posOpts) {
    posOpts.querySelectorAll('[data-sub-pos]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        subtitlePrefs.position = btn.getAttribute('data-sub-pos');
        saveSubtitlePrefs();
        applySubtitlePrefs();
        updateSubtitlePrefsUI();
        showControls();
      });
    });
  }

  const resetBtn = document.getElementById('reset-subtitle-prefs-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      subtitlePrefs = Object.assign({}, SUBTITLE_PREFS_DEFAULT);
      saveSubtitlePrefs();
      applySubtitlePrefs();
      updateSubtitlePrefsUI();
      showControls();
    });
  }

  updateSubtitlePrefsUI();
}

// ════════════════════════════════════════════════════════════
//  PLAYER PREFERENCES (persisted to localStorage)
// ════════════════════════════════════════════════════════════
const PLAYER_PREFS_KEY = 'anistrim_player_prefs';
const PLAYER_PREFS_DEFAULT = {
  autoSkipIntro: false,
  autoSkipOutro: false,
  doubleTapSeek: true,
  autoFullscreen: false,
  rememberSpeed: true
};

let playerPrefs = loadPlayerPrefs();

function loadPlayerPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || '{}');
    return Object.assign({}, PLAYER_PREFS_DEFAULT, saved);
  } catch(e) {
    return Object.assign({}, PLAYER_PREFS_DEFAULT);
  }
}

function savePlayerPrefs() {
  try {
    localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(playerPrefs));
  } catch(e) {}
}

function updatePlayerPrefsUI() {
  const m = {
    'skip-intro-value': playerPrefs.autoSkipIntro ? 'On' : 'Off',
    'skip-outro-value': playerPrefs.autoSkipOutro ? 'On' : 'Off',
    'double-tap-seek-value': playerPrefs.doubleTapSeek ? 'On' : 'Off',
    'auto-fullscreen-value': playerPrefs.autoFullscreen ? 'On' : 'Off',
    'remember-speed-value': playerPrefs.rememberSpeed ? 'On' : 'Off'
  };
  Object.keys(m).forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.textContent = m[id];
  });
}

function initPlayerPrefsUI() {
  const bindings = [
    ['skip-intro-toggle-btn', 'autoSkipIntro', 'skip-intro-value'],
    ['skip-outro-toggle-btn', 'autoSkipOutro', 'skip-outro-value'],
    ['double-tap-seek-toggle-btn', 'doubleTapSeek', 'double-tap-seek-value'],
    ['auto-fullscreen-toggle-btn', 'autoFullscreen', 'auto-fullscreen-value'],
    ['remember-speed-toggle-btn', 'rememberSpeed', 'remember-speed-value']
  ];
  bindings.forEach(function(binding) {
    const btn = document.getElementById(binding[0]);
    if (!btn) return;
    btn.addEventListener('click', function() {
      playerPrefs[binding[1]] = !playerPrefs[binding[1]];
      savePlayerPrefs();
      updatePlayerPrefsUI();
      applyPlayerPrefs();
      showControls();
    });
  });
  updatePlayerPrefsUI();
}

function applyPlayerPrefs() {
  // Auto-skip intro/outro: if enabled, skip automatically when ranges detected
  // (handled in timeupdate via global flags)
  // Double-tap seek: handled in initTouchControls
  // Auto-fullscreen: if enabled and playing, enter fullscreen
  const video = document.getElementById('animePlayer');
  if (playerPrefs.autoFullscreen && video && !video.paused && !video.ended) {
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen()['catch'](function(){});
    }
  }
  // Remember speed: already handled by speedValue persistence
  // If rememberSpeed is off, reset to 1x on new episodes
  if (!playerPrefs.rememberSpeed) {
    // Don't force here; handled in switchToEpisode
  }
}

window.applySubtitlePrefs = applySubtitlePrefs;
window.saveSubtitlePrefs = saveSubtitlePrefs;
window.subtitlePrefs = subtitlePrefs;
window.applyPlayerPrefs = applyPlayerPrefs;
window.savePlayerPrefs = savePlayerPrefs;
window.playerPrefs = playerPrefs;

// ════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
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
        e.preventDefault();
        toggleMute();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        if (isPipSupported()) togglePip();
        break;
      case 'e':
      case 'E':
        e.preventDefault();
        const sidebar = document.getElementById('episode-sidebar');
        if (sidebar) {
          sidebar.classList.toggle('visible');
          if (sidebar.classList.contains('visible')) {
            renderEpisodeSidebar(allEpisodes, currentAnimeId);
            renderSeasonNav();
            updateSidebarSeasonLabel();
          }
        }
        showControls();
        break;
      case 's':
      case 'S':
        // Don't preventDefault so it doesn't interfere with typing in settings
        const settingsMenu = document.getElementById('settings-menu');
        if (settingsMenu) {
          if (settingsMenu.classList.contains('visible')) {
            closeSettingsMenu();
          } else {
            toggleSettingsMenu();
          }
        }
        break;
      case 'Escape':
        // Close any open overlay
        hideEndOverlay();
        hideResumePrompt();
        cancelAutoplay();
        const menu = document.getElementById('settings-menu');
        if (menu) menu.classList.remove('visible');
        const sb = document.getElementById('episode-sidebar');
        if (sb) sb.classList.remove('visible');
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
async function loadSkipTimes(animeId, episodeNumber) {
  introRange = null;
  outroRange = null;
  try {
    var { data } = await apiFetch('/api/watch/skip-times/' + encodeURIComponent(animeId) + '/' + encodeURIComponent(episodeNumber), { timeout: API_TIMEOUT_MS });
    if (data) {
      if (data.op && Number.isFinite(Number(data.op.start)) && Number.isFinite(Number(data.op.end))) {
        introRange = { start: Number(data.op.start), end: Number(data.op.end) };
      }
      if (data.ed && Number.isFinite(Number(data.ed.start)) && Number.isFinite(Number(data.ed.end))) {
        outroRange = { start: Number(data.ed.start), end: Number(data.ed.end) };
      }
    }
  } catch (error) {
    console.debug('No skip-intro marker available:', error.message);
  }
}

// ════════════════════════════════════════════════════════════
//  EPISODE SIDEBAR COMPATIBILITY
// ════════════════════════════════════════════════════════════
function renderMoreEpisodes(episodes, animeId) {
  renderEpisodeSidebar(episodes, animeId);
}

function makeFallbackImg(title) {
  if (window.makeFallbackImg) return window.makeFallbackImg(title);
  // Generate a colored placeholder based on title hash
  var hash = 0;
  for (var i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  var color = '#' + (hash & 0x00FFFFFF).toString(16).padStart(6, '0');
  return 'https://ui-avatars.com/api/?background=' + color.substring(1) + '&color=ffffff&bold=true&name=' + encodeURIComponent(title || 'Anime');
}

function cardImgError(img, title) {
  if (img && title) {
    img.src = makeFallbackImg(title);
  }
}

// ════════════════════════════════════════════════════════════
//  ERROR OVERLAY  (preserved recovery actions)
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

// ════════════════════════════════════════════════════════════
//  HLS / Stream Source Attacher
// ════════════════════════════════════════════════════════════
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
  const container = document.getElementById('quality-options');
  if (!container) return;
  populateQualityOptions();
}

// ── Volume slider sync ──────────────────────────────────────
function updateVolumeSlider() {
  const video = document.getElementById('animePlayer');
  const slider = document.getElementById('volume-slider');
  if (video && slider) {
    const val = video.muted ? 0 : (video.volume || 1);
    slider.value = String(val);
  }
}

// ════════════════════════════════════════════════════════════
//  OFFLINE DOWNLOADS (preserved)
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
//  SEASON GROUPS & SIDEBAR TOGGLE (named exports)
// ════════════════════════════════════════════════════════════

/**
 * Build a map of season number → episode array from allEpisodes.
 * Returns an object like { 1: [...eps], 2: [...eps], ... }
 */
function buildSeasonGroups(episodes) {
  var groups = {};
  if (!episodes || !episodes.length) return groups;
  episodes.forEach(function(ep) {
    var s = ep.season || ep.season_number || 1;
    if (!groups[s]) groups[s] = [];
    groups[s].push(ep);
  });
  // Sort each group by episode number
  Object.keys(groups).forEach(function(s) {
    groups[s].sort(function(a, b) {
      return (a.number || a.episode_number || 0) - (b.number || b.episode_number || 0);
    });
  });
  return groups;
}

/** Cached season groups – rebuilt whenever allEpisodes changes */
var seasonGroups = {};

/**
 * Toggle the episode sidebar drawer open/closed.
 * @param {boolean} [force] – true = open, false = close, undefined = toggle
 */
function toggleEpisodeSidebar(force) {
  var sidebar = document.getElementById('episode-sidebar');
  if (!sidebar) return;
  if (typeof force === 'boolean') {
    sidebar.classList.toggle('visible', force);
  } else {
    sidebar.classList.toggle('visible');
  }
  // Pause video when sidebar opens (optional UX)
  var video = document.getElementById('animePlayer');
  if (sidebar.classList.contains('visible') && video && !video.paused) {
    // Don't auto-pause; just let user browse
  }
}

/**
 * Exit the player and return to browse/details page.
 */
function exitPlayer() {
  // Save progress before leaving
  var video = document.getElementById('animePlayer');
  if (video && currentAnimeTitle && currentEp) {
    var progressSec = Math.floor(video.currentTime || 0);
    var durationSec = Math.floor(video.duration || 0);
    if (progressSec > 0 && durationSec > 0) {
      // Fire-and-forget save
      apiFetch('/api/watch/progress', {
        method: 'POST',
        body: JSON.stringify({
          animeTitle: currentAnimeTitle,
          episodeNumber: currentEp,
          progressSec: progressSec,
          durationSec: durationSec,
          episodeId: currentEpisodeId || null
        })
      }).catch(function() {});
    }
  }
  // Navigate back
  var params = new URLSearchParams(window.location.search);
  var animeId = params.get('id');
  if (animeId) {
    window.location.href = 'details.html?id=' + animeId;
  } else {
    window.location.href = 'browse.html';
  }
}

// Expose to global scope for HTML onclick handlers
window.buildSeasonGroups = buildSeasonGroups;
window.seasonGroups = seasonGroups;
window.toggleEpisodeSidebar = toggleEpisodeSidebar;
window.exitPlayer = exitPlayer;

// ── INITIALIZE THE PLAYER ────────────────────────────────
// The watch page must kick off playback resolution on load. Without this,
// loadWatch() is never invoked and the player stays stuck on
// "Preparing player..." with NO backend request being made.
document.addEventListener('DOMContentLoaded', loadWatch);


