// watch.js — Premium skip intro + autoplay next episode + Multi-API streaming
// ── Episode Identity ────────────────────────────────────────
// Key distinction:
//   episodeId   = Database record ID (used for progress saving, DB lookups)
//   episodeNumber = Sequential episode number (1, 2, 3...) (used for streaming)
//
// The URL now supports TWO params:
//   ?epId=123   → Database ID (for progress/DB operations)
//   ?ep=5       → Episode NUMBER (for stream resolution)
//   (backward compat: if only epId is present and no ep, we still try to
//    resolve episode number from the database on the backend)

// ── Request-ID for traceability ─────────────────────────────
// One playback attempt can be traced from browser → API → provider →
// source → browser using this ID in every [WATCH] / [STREAM] log.
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

// ── Ad Mid-Roll Tracking ────────────────────────────────────
let adPlayInterval = null;
let lastAdPlayedAt = 0;
const AD_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ── Playback stage timeouts (ms) ────────────────────────────
// Every critical request must have a bounded timeout so the player can
// never remain stuck on a spinning "Loading stream..." overlay.
const API_TIMEOUT_MS = 30000;      // generic API requests
const STREAM_TIMEOUT_MS = 60000;   // stream resolution can take longer (AnimeHeaven)
const SOURCE_ATTACH_TIMEOUT_MS = 30000; // video source attachment / HLS manifest

async function loadWatch() {
  watchLog('page initialized', { url: window.location.href });

  const params = new URLSearchParams(window.location.search);

  // ── CANONICAL URL PARAMS ──────────────────────────────────
  const animeId = params.get('id') || params.get('animeId');
  const epNumRaw = params.get('ep');                        // Canonical: episode NUMBER
  const epIdRaw = params.get('epId');                       // Legacy: DB record ID (for progress only)

  if (params.get('animeId')) console.warn('[Watch] Legacy param "animeId" detected — use "id" instead');
  if (params.get('epId') && !params.get('ep')) console.warn('[Watch] Legacy param "epId" detected — use "ep" with episode NUMBER instead');

  // Set episode number: CANONICAL ?ep= takes priority, then legacy fallback
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
      // ── Single-pass stream resolution ─────────────────────
      // FIX (duplicate resolution): Previously this performed
      //   await fetchAvailableProviders(...)   ← full AnimeHeaven scrape #1
      //   await resolveAndPlayStream(...)      ← full AnimeHeaven scrape #2
      // The provider-list call was REMOVED from the playback path.
      // The provider selector is now populated lazily by the stream result.
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
// The provider list endpoint is metadata/capability information ONLY.
// It must NEVER force an expensive provider scrape before playback.
// The actual stream is resolved only by resolveAndPlayStream().
async function fetchAvailableProviders(animeTitle, episodeNumber) {
  try {
    watchLog('provider request started', { animeTitle, episodeNumber });
    var { data, timedOut } = await apiFetch('/api/stream/providers/' + encodeURIComponent(animeTitle) + '/' + episodeNumber, { timeout: 8000 });
    if (timedOut) {
      watchLog('provider request timed out (non-fatal)', { animeTitle, episodeNumber });
      return;
    }
    if (data && data.providers && data.providers.length > 0) {
      availableProviders = data.providers;
      populateServerSwitcher();
      watchLog('provider request completed', { animeTitle, episodeNumber, count: data.providers.length });
    }
  } catch (e) {
    console.debug('Could not fetch provider list:', e.message);
  }
}

// ── Multi-API: Populate server switcher dropdown ─────────────
function populateServerSwitcher() {
  // DORMANT: No #serverSwitcher element in new HTML. The new UI has a quality selector.
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
            console.log("[PLAYER] Successfully attached stream:", currentStreamUrl);
            watchLog('video source attached', { provider: currentProvider, quality: source.quality });

            // Update quality value in settings menu
            const qualityValue = document.getElementById('quality-value');
            if (qualityValue && source.quality) { qualityValue.textContent = source.quality; }

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

// ── Player Setup ───────────────────────────────────────────
function setupPlayer(video) {
  const wrap = document.getElementById('player-wrap');
  const progressBar = document.getElementById('progress-bar');
  const timeDisplay = document.getElementById('time-display');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const playIcon = document.getElementById('play-icon');
  const bottomControls = document.querySelector('.controls-overlay.bottom');
  const topControls = document.querySelector('.controls-overlay.top');
  const allControls = [bottomControls, topControls];
  const skipBtn = document.getElementById('skip-intro-btn');
  const nextBanner = document.getElementById('next-episode-overlay');
  var isPremium = State.isPremium || State.isAdmin;
  
  // ── Instrumented playback events (Finding 7: prevent silent failures) ──
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error'].forEach(eventName => {
    video.addEventListener(eventName, () => {
      watchLog(eventName, {
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
      });
      // Surface buffering / stall states in the loading overlay.
      const loadingOverlay = document.getElementById('loading-overlay');
      if (eventName === 'waiting' || eventName === 'stalled') {
        setLoadingStatus('Buffering...');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
      } else if (eventName === 'playing') {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
      } else if (eventName === 'error') {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
      }
    });
  });

  if (currentEpId) loadProgress(video, currentEpId);

  video.addEventListener('timeupdate', function() {
    if (progressBar && video.duration) {
      progressBar.value = video.currentTime;
      progressBar.max = video.duration;
    }
    timeDisplay.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration);

    if (isPremium && introRange && video.currentTime >= introRange.start && video.currentTime < introRange.end) {
      if(skipBtn) skipBtn.style.display = 'block';
    } else {
      if(skipBtn) skipBtn.style.display = 'none';
    }

    if (isPremium && nextEpData && video.duration) {
      var remaining = video.duration - video.currentTime;
      if (remaining <= 30 && remaining > 0) {
        if (nextBanner) nextBanner.style.display = 'flex';
        const secEl = document.getElementById('next-ep-countdown');
        if (secEl) secEl.textContent = `Playing next in ${Math.ceil(remaining)}s`;
      } else if (remaining > 30) {
        if (nextBanner) nextBanner.style.display = 'none';
      }
    }

    if (currentEpId && Math.floor(video.currentTime) % 10 === 0 && video.currentTime > 0) {
      saveProgress(currentEpId, Math.floor(video.currentTime), false);
    }
  });

  video.addEventListener('ended', function() {
    if (currentEpId) saveProgress(currentEpId, Math.floor(video.duration || 0), true);
    if (isPremium && nextEpData) {
      startAutoplayCountdown();
    } else if (!isPremium && nextEpData) {
      if (nextBanner) {
        nextBanner.style.display = 'flex';
        const countdownEl = document.getElementById('next-ep-countdown');
        if(countdownEl) countdownEl.style.display = 'none';
      }
    }
  });

  video.addEventListener('play', function() {
    if (playIcon) playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'; // Pause icon
    wrap.classList.remove('paused');
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
    showControls(allControls);
  });
  video.addEventListener('pause', function() {
    if (playIcon) playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>'; // Play icon
    wrap.classList.add('paused');
    showControls(allControls);
    cancelAutoplay();
  });

  // NEW: Wire up new controls
  document.getElementById('play-pause-btn')?.addEventListener('click', togglePlay);
  document.getElementById('seek-backward-btn')?.addEventListener('click', skipBack);
  document.getElementById('seek-forward-btn')?.addEventListener('click', skipForward);
  document.getElementById('fullscreen-btn')?.addEventListener('click', toggleFullscreen);
  document.getElementById('back-btn')?.addEventListener('click', () => window.history.back());
  
  const volumeSlider = document.getElementById('volume-slider');
  if(volumeSlider) volumeSlider.addEventListener('input', (e) => setVolume(e.target.value));

  if(progressBar) progressBar.addEventListener('input', (e) => seekVideo(e));

  document.getElementById('episodes-btn')?.addEventListener('click', () => {
    document.getElementById('episode-sidebar')?.classList.add('visible');
  });
  document.getElementById('close-sidebar-btn')?.addEventListener('click', () => {
    document.getElementById('episode-sidebar')?.classList.remove('visible');
  });

  setupControlsAutoHide(wrap, allControls);
  video.play()['catch'](function() { wrap.classList.add('paused'); });
}

function setupControlsAutoHide(wrap, allControls) {
  const controls = Array.isArray(allControls) ? allControls : [allControls];
  function resetControlsTimer() {
    showControls(controls);
    if (controlsTimer) clearTimeout(controlsTimer);
    controlsTimer = setTimeout(function() {
      var video = document.getElementById('animePlayer');
      if (video && !video.paused) hideControls(controls);
    }, 3000);
  }
  wrap.addEventListener('mousemove', resetControlsTimer);
  wrap.addEventListener('touchstart', resetControlsTimer);
  wrap.addEventListener('mouseenter', resetControlsTimer);
  wrap.addEventListener('click', function(e) {
    if (e.target.closest('.controls-overlay') || e.target.closest('.skip-btn') || e.target.closest('.next-ep')) return;
    var video = document.getElementById('animePlayer');
    if (video) togglePlay();
  });
}

function showControls(controlsArray) {
  controlsArray.forEach(controls => {
    if (controls) controls.classList.remove('hidden');
  });
}

function hideControls(controlsArray) {
  controlsArray.forEach(controls => {
    if (controls) controls.classList.add('hidden');
  });
}

function startAutoplayCountdown() {
  const nextBanner = document.getElementById('next-episode-overlay');
  const countEl = document.getElementById('next-ep-countdown');
  const playNextBtn = document.getElementById('play-next-btn');
  if (playNextBtn) playNextBtn.onclick = playNextEp;
  if (nextBanner) nextBanner.style.display = 'flex';
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

function togglePlay() { var v = document.getElementById('animePlayer'); v.paused ? v.play() : v.pause(); }
window.togglePlay = togglePlay;
function skipBack() { var v = document.getElementById('animePlayer'); if (!isFinite(v.duration)) return; v.currentTime = Math.max(0, v.currentTime - 10); }
function skipForward() { var v = document.getElementById('animePlayer'); if (!isFinite(v.duration)) return; v.currentTime = Math.min(v.duration - 0.5, v.currentTime + 10); }
function setVolume(v) { 
  const video = document.getElementById('animePlayer');
  if(video) video.volume = parseFloat(v); 
}
window.skipBack = skipBack; window.skipForward = skipForward; window.setVolume = setVolume;
function seekVideo(e) { 
  const video = document.getElementById('animePlayer');
  if (!video || !isFinite(video.duration)) return;
  const progressBar = e.currentTarget;
  video.currentTime = (progressBar.value / progressBar.max) * video.duration;
}
window.seekVideo = seekVideo;
function toggleFullscreen() {
  var wrap = document.getElementById('player-wrap');
  if (!document.fullscreenElement) { (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap); }
  else { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
}
window.toggleFullscreen = toggleFullscreen;
function skipIntro() { if (!State.isPremium && !State.isAdmin) return; var video = document.getElementById('animePlayer'); if (introRange) video.currentTime = introRange.end; document.getElementById('skip-intro-btn').style.display = 'none'; }
window.skipIntro = skipIntro;
function playNextEp() { cancelAutoplay(); if (!nextEpData || !currentAnime) return; var nextNum = nextEpData.number || nextEpData.episode_number; location.href = 'watch.html?id=' + currentAnime.id + '&ep=' + nextNum; }
window.playNextEp = playNextEp;
function fmtTime(s) { if (!s || isNaN(s)) return '0:00'; return Math.floor(s/60) + ':' + Math.floor(s%60).toString().padStart(2,'0'); }

function renderMoreEpisodes(episodes, animeId) {
  var container = document.getElementById('sidebar-episode-list');
  if (!container) return;
  var epNum = currentEp;
  var others = episodes.filter(function(e) { return (e.number || e.episode_number) !== epNum; }).slice(0, 12);
  if (!others.length) { container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No other episodes available.</p>'; return; }
  container.innerHTML = others.map(function(e) {
    var isLocked = e.is_premium && !State.isPremium && !State.isAdmin;
    var displayNum = e.number || e.episode_number;
    var epTitle = e.title && e.title !== 'undefined' ? e.title : 'Episode ' + displayNum;
    var thumbSrc = e.thumbnail_url && e.thumbnail_url.trim() && e.thumbnail_url !== 'undefined' ? e.thumbnail_url : makeFallbackImg(epTitle);
    var lockIcon = isLocked ? '🔒' : displayNum;
    var lockColor = isLocked ? 'color:var(--orange)' : '';
    var premiumTag = e.is_premium ? '<span style="color:var(--orange);font-size:0.72rem;">👑 Premium</span>' : '';
    var playSvg = isLocked ? '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' : '<polygon points="5 3 19 12 5 21 5 3"/>';
    var playColor = isLocked ? 'var(--orange)' : 'var(--text-muted)';
    const targetEpNum = e.number || e.episode_number;
    const currentClass = targetEpNum === epNum ? 'current' : '';
    return `<div class="episode-item ${currentClass}" onclick="location.href='watch.html?id=${animeId}&ep=${targetEpNum}'">
              <div class="ep-thumb-wrap"><img src="${thumbSrc}" alt="${epTitle.replace(/'/g,"\\'")}" loading="lazy" onerror="cardImgError(this,'${epTitle.replace(/'/g,"\\'")}')"></div>
              <div class="ep-info">
                <div class="ep-title">${window._escapeHTML(epTitle)} ${premiumTag}</div>
                <div class="ep-duration">${fmtTime(e.duration_sec || 1440)}</div>
              </div>
              <span class="ep-play-icon">${isLocked ? '🔒' : '▶'}</span>
            </div>`;
  }).join('');
}

function showWatchError(msg) {
  watchLog('error shown', { message: msg });
  const loadingOverlay = document.getElementById('loading-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const errorMessage = document.getElementById('error-message');

  if (loadingOverlay) loadingOverlay.style.display = 'none';
  if (errorOverlay) errorOverlay.style.display = 'flex';
  if (errorMessage) errorMessage.textContent = msg;

  // ── Recovery actions (Finding 8: never hide errors) ──────
  const retryBtn = document.getElementById('retry-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const changeSourceBtn = document.getElementById('change-source-btn');
  const prevEpBtn = document.getElementById('prev-ep-btn-error');
  const nextEpBtn = document.getElementById('next-ep-btn-error');

  if (retryBtn) {
    retryBtn.onclick = () => location.reload();
  }
  if (reloadBtn) {
    reloadBtn.onclick = () => location.reload();
  }
  if (changeSourceBtn) {
    changeSourceBtn.onclick = () => {
      // Force a fresh stream resolution attempt with a nonce to bypass cache.
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
  if (isEpisodeDownloaded(currentAnimeTitle, currentEp)) {
    alert('Already downloaded.');
    return;
  }
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
    // ── Hard timeout for source attachment ─────────────────
    // If the HLS manifest or video source never loads, reject so the
    // player can show an error instead of spinning forever.
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
        resolve();
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
      resolve();
    }, { once: true });
    video.addEventListener('error', function() {
      cleanup();
      reject(new Error('Video source could not be loaded.'));
    }, { once: true });
    video.load();
  });
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