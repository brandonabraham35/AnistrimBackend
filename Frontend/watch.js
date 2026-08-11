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

// ── Ad Mid-Roll Tracking ────────────────────────────────────
let adPlayInterval = null;
let lastAdPlayedAt = 0;
const AD_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function loadWatch() {
  console.log('[PLAYER DEBUG] Episode clicked', {
    anime: new URLSearchParams(window.location.search).get('id'),
    episode: new URLSearchParams(window.location.search).get('ep'),
    timestamp: new Date().toISOString()
  });

  const params = new URLSearchParams(window.location.search);

  // ── CANONICAL URL PARAMS ──────────────────────────────────
  // Primary:   ?id=<animeId>&ep=<episodeNumber>
  // Legacy:    ?animeId=<animeId>&epId=<episodeDbId>
  // NEVER pass database IDs as episode numbers to the player.
  const animeId = params.get('id') || params.get('animeId');
  const epNumRaw = params.get('ep');                        // Canonical: episode NUMBER
  const epIdRaw = params.get('epId');                       // Legacy: DB record ID (for progress only)

  // Warn if legacy params are used (helps migration)
  if (params.get('animeId')) console.warn('[Watch] Legacy param "animeId" detected — use "id" instead');
  if (params.get('epId') && !params.get('ep')) console.warn('[Watch] Legacy param "epId" detected — use "ep" with episode NUMBER instead');

  // Set episode number: CANONICAL ?ep= takes priority, then legacy fallback
  if (epNumRaw) {
    currentEp = parseInt(epNumRaw, 10) || 1;
  } else {
    // Legacy fallback: if only epId (DB ID) is provided, we still use it as episode number
    // but this is only for backward compatibility — the backend will try to map it
    currentEp = parseInt(epIdRaw, 10) || 1;
  }

  if (!animeId) { showWatchError('Missing anime ID. Please go back and try again.'); return; }

  try {
    const { data: animeData } = await apiFetch('/api/anime/' + animeId);
    currentAnime = animeData;
    if (!animeData || !animeData.id) { showWatchError('Could not load anime data.'); return; }

    currentAnimeTitle = window._escapeHTML(animeData.title); // Escape anime title
    // NEW: Populate loading overlay titles
    const loadingAnimeTitle = document.getElementById('loading-anime-title');
    const loadingEpisodeInfo = document.getElementById('loading-episode-info');
    if (loadingAnimeTitle) loadingAnimeTitle.textContent = currentAnimeTitle;
    if (loadingEpisodeInfo) loadingEpisodeInfo.textContent = 'Episode ' + currentEp;
    document.title = 'Ep ' + currentEp + ' - ' + window._escapeHTML(animeData.title) + ' | AniStrim'; // Escape anime title for document title
    document.getElementById('watch-ep-title').textContent = 'Episode ' + currentEp;
    document.getElementById('watch-anime-title').textContent = currentAnimeTitle;

    const { data: episodesData } = await apiFetch('/api/anime/' + animeId + '/episodes');
    const episodes = Array.isArray(episodesData) ? episodesData : [];

    let ep;
    if (params.get('epId')) {
      ep = episodes.find(function(e) { return String(e.id) === String(params.get('epId')); });
    }
    if (!ep) {
      ep = episodes.find(function(e) { return (e.number || e.episode_number) === currentEp; });
    }
    currentEpId  = ep && ep.id ? ep.id : null;
    nextEpData   = episodes.find(function(e) { return (e.number || e.episode_number) === ((ep && (ep.number || ep.episode_number)) || currentEp) + 1; }) || null;

    // NEW: Target the new next episode overlay title element
    if (nextEpData) {
      const nextEpTitleOverlay = document.getElementById('next-ep-title-overlay');
      if (nextEpTitleOverlay) nextEpTitleOverlay.textContent = 'Episode ' + (nextEpData.number || nextEpData.episode_number);
    }

    // DORMANT: No #premium-lock element in new HTML
    /*
    if (ep && ep.is_premium && !State.isPremium && !State.isAdmin) {
      document.getElementById('premium-lock').style.display = 'flex';
      document.getElementById('video-placeholder').style.display = 'none';
      renderMoreEpisodes(episodes, animeId);
      return;
    }
    */

    var video = document.getElementById('animePlayer');
    const loadingOverlay = document.getElementById('loading-overlay');

    if (ep && ep.video_url) {
      await attachStreamSource(video, ep.video_url);
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      setupPlayer(video);
    } else {
      // NEW: Use the new loading/error overlays
      const errorOverlay = document.getElementById('error-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      if (errorOverlay) errorOverlay.style.display = 'none';

      try {
        console.log('[PLAYER DEBUG] Starting pre-stream operations (fetchAvailableProviders)', { timestamp: new Date().toISOString() });
        await fetchAvailableProviders(animeData.title, currentEp);
        console.log('[PLAYER DEBUG] Finished fetchAvailableProviders', { timestamp: new Date().toISOString() });
        await resolveAndPlayStream(animeData.title, currentEp, video);
        console.log('[PLAYER DEBUG] Finished resolveAndPlayStream, hiding loading overlay.', { timestamp: new Date().toISOString() });
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        setupPlayer(video);
      } catch (err) {
        showWatchError(err.message || 'Stream resolution failed.');
      }
    }

    loadSkipTimes(animeId, (ep && (ep.number || ep.episode_number)) || currentEp);
    renderMoreEpisodes(episodes, animeId);

    if (State.isPremium || State.isAdmin) {
      // DORMANT: No #download-btn element in new HTML
      // document.getElementById('download-btn').style.display = 'flex';
    } else {
      // DORMANT: No #premium-feature-hint element in new HTML
      // showPremiumFeatureBanner();
      startMidRollAdTracker(video);
    }

  } catch(e) {
    console.error('Watch error:', e);
    showWatchError('Network error. Please check your connection and try again.');
  }
}

// ── Multi-API: Fetch available providers ─────────────────────
async function fetchAvailableProviders(animeTitle, episodeNumber) {
  try {
    var { data } = await apiFetch('/api/stream/providers/' + encodeURIComponent(animeTitle) + '/' + episodeNumber);
    if (data && data.providers && data.providers.length > 0) {
      availableProviders = data.providers;
      populateServerSwitcher();
    }
  } catch (e) {
    console.debug('Could not fetch provider list:', e.message);
  }
}

// ── Multi-API: Populate server switcher dropdown ─────────────
function populateServerSwitcher() {
  // DORMANT: No #serverSwitcher element in new HTML. The new UI has a quality selector.
  // This function can be repurposed if quality selection logic is added.
  /* var select = document.getElementById('serverSwitcher');
  if (!select || !availableProviders.length) {
    if (select) select.style.display = 'none';
    return;
  }
  
  select.style.display = 'inline-block';
  select.innerHTML = '<option value="">Auto</option>';
  availableProviders.forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.provider;
    var name = p.provider.charAt(0).toUpperCase() + p.provider.slice(1).replace('-', ' ');
    if (p.bestQuality) name += ' (' + p.bestQuality + ')';
    opt.textContent = name;
    select.appendChild(opt);
  }); */
}

// ── Multi-API: Resolve and play stream ──────────────────────
async function resolveAndPlayStream(animeTitle, episodeNumber, video, preferredProvider) {
  var url = '/api/stream/' + encodeURIComponent(animeTitle) + '/' + episodeNumber;
  if (preferredProvider) {
    url += '?preferredProvider=' + preferredProvider;
  }

  const requestStart = Date.now();
  console.log('[PLAYER DEBUG] STREAM REQUEST START', { url, method: 'GET', timestamp: new Date(requestStart).toISOString() });

  console.log("[PLAYER] Requesting stream from:", url);
  var { data, status } = await apiFetch(url);
  const responseReceived = Date.now();
  console.log('[PLAYER DEBUG] STREAM RESPONSE RECEIVED', { status, elapsedMs: responseReceived - requestStart, timestamp: new Date(responseReceived).toISOString() });

  console.log("[PLAYER] Stream API response", data);

  if (data && data.sources && data.sources.length > 0) {
    const parsedTime = Date.now();
    console.log('[PLAYER DEBUG] STREAM RESPONSE PARSED', { sources: data.sources.length, elapsedMs: parsedTime - requestStart, timestamp: new Date(parsedTime).toISOString() });

    const API_BASE_URL = window.getApiBaseUrl();
    const sourcesToTry = data.sources.map(source => ({
        ...source,
        url: source.url.startsWith('http') ? source.url : API_BASE_URL + source.url
    }));

    for (const source of sourcesToTry) {
        try {
            console.log(`[PLAYER] Attempting to attach source: ${source.url} (Quality: ${source.quality})`);
            console.log('[PLAYER DEBUG] SETTING VIDEO SOURCE', { source: source.url, timestamp: new Date().toISOString() });
            await attachStreamSource(video, source.url);

            currentStreamUrl = source.url;
            currentProvider = data.provider || 'unknown';
            console.log("[PLAYER] Successfully attached stream:", currentStreamUrl);

            // NEW: Update quality value in settings menu
            const qualityValue = document.getElementById('quality-value');
            if (qualityValue && source.quality) { qualityValue.textContent = source.quality; }
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

  // NEW: Use new loading/error overlays
  const loadingOverlay = document.getElementById('loading-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'flex';
  if (errorOverlay) errorOverlay.style.display = 'none';

  try {
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
  /*
  var overlay = document.getElementById('adOverlay');
  if (!overlay) return;

  var wasPlaying = !video.paused;
  if (wasPlaying) video.pause();

  overlay.style.display = 'flex';
  lastAdPlayedAt = Date.now();

  var sec = 15;
  var cdEl = document.getElementById('adCountdownNum');
  var skipBtn = document.getElementById('adSkipBtn');
  if (skipBtn) {
    skipBtn.disabled = true;
    skipBtn.textContent = 'Skip in 15s';
  }

  var tick = setInterval(function() {
    sec--;
    if (cdEl) cdEl.textContent = Math.max(0, sec);
    if (skipBtn) skipBtn.textContent = sec > 0 ? 'Skip in ' + sec + 's' : 'Skip Ad';
    if (sec <= 0) {
      clearInterval(tick);
      if (skipBtn) { skipBtn.disabled = false; skipBtn.onclick = function() { closeAd(); }; }
    }
  }, 1000);

  function closeAd() {
    clearInterval(tick);
    overlay.style.display = 'none';
    if (wasPlaying) video.play()['catch'](function() {});
  } */
}

// ── Player Setup ───────────────────────────────────────────
function setupPlayer(video) {
  // NEW: Get new player elements
  const wrap = document.getElementById('player-wrap');
  const progressBar = document.getElementById('progress-bar');
  const timeDisplay = document.getElementById('time-display');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const playIcon = document.getElementById('play-icon'); // This is inside the button
  const bottomControls = document.querySelector('.controls-overlay.bottom');
  const topControls = document.querySelector('.controls-overlay.top');
  const allControls = [bottomControls, topControls];
  const skipBtn = document.getElementById('skip-intro-btn');
  const nextBanner = document.getElementById('next-episode-overlay');
  var isPremium = State.isPremium || State.isAdmin;
  
  // Temporary debug listeners
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error'].forEach(eventName => {
    video.addEventListener(eventName, () => {
      console.log(`[VIDEO DEBUG] event=${eventName}`, {
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error,
        timestamp: new Date().toISOString()
      });
    });
  });

  if (currentEpId) loadProgress(video, currentEpId);

  video.addEventListener('timeupdate', function() {
    // NEW: Update range input for progress
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
        // NEW: Use new next episode overlay
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
      // NEW: Show next episode banner for manual click
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

    // Log video started event for performance monitoring, but only once.
    if (!window._videoStartedLogged) {
        window._videoStartedLogged = true;
        const payload = {
            event: 'videoStarted',
            animeTitle: currentAnimeTitle,
            episode: currentEp,
            provider: currentProvider,
            sourceUrl: currentStreamUrl,
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
  // NEW: Toggle play on video click, but not if controls are clicked
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
  // NEW: Use new next episode overlay elements
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
    var { data } = await apiFetch('/api/watchlist/progress/' + epId);
    if (data && data.progress_sec > 10 && !data.completed) {
      video.addEventListener('loadedmetadata', function() {
        video.currentTime = data.progress_sec;
        // DORMANT: No #resume-badge element in new HTML
        // var badge = document.getElementById('resume-badge');
        // if (badge) { badge.style.display = 'block'; setTimeout(function() { badge.style.display = 'none'; }, 4000); }
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
  // NEW: Logic for range input
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
  // NEW: Target the new sidebar list
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
    // CANONICAL URL: watch.html?id=<animeId>&ep=<episodeNumber> — NEVER use database IDs
    const targetEpNum = e.number || e.episode_number;
    const currentClass = targetEpNum === epNum ? 'current' : '';
    // NEW: Markup to match new sidebar design if needed (assuming .episode-item is styled in watch.css)
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
  // NEW: Use the new error overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const errorMessage = document.getElementById('error-message');

  if (loadingOverlay) loadingOverlay.style.display = 'none';
  if (errorOverlay) errorOverlay.style.display = 'flex';
  if (errorMessage) errorMessage.textContent = msg;

  document.getElementById('retry-btn')?.addEventListener('click', () => location.reload());
}
window.showWatchError = showWatchError;

document.addEventListener('DOMContentLoaded', loadWatch);

// ── Sandboxed Offline Download via IndexedDB ──────────────────
var OFFLINE_STORAGE_KEY = 'anistrim_offline_episodes';
function getOfflineList() { try { return JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) || '[]'); } catch(e) { return []; } }
function saveOfflineList(list) { localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(list)); }
function isEpisodeDownloaded(animeTitle, epNum) { return getOfflineList().some(function(e) { return e.animeTitle === animeTitle && e.episodeNumber === epNum; }); }

async function handleDownload() {
  // DORMANT: No download UI in new HTML
  if (!State.isPremium && !State.isAdmin) { if (confirm('Offline downloads are for premium users only. Upgrade now?')) location.href = 'upgrade.html'; return; }
  if (!currentAnimeTitle || !currentEp) { alert('Cannot download this episode.'); return; }
  if (isEpisodeDownloaded(currentAnimeTitle, currentEp)) {
    document.getElementById('offlineDeleteBtn').style.display = 'inline-block'; // This is a UI element, not user input
    document.getElementById('offlineStatus').textContent = '✅ Already downloaded.';
    document.getElementById('offlineStartBtn').textContent = 'Re-download';
    document.getElementById('offlineModal').style.display = 'flex';
    return;
  }
  document.getElementById('offlineDeleteBtn').style.display = 'none';
  document.getElementById('offlineStartBtn').textContent = 'Start Download';
  try {
    var { data } = await apiFetch('/api/stream/offline-download', { method: 'POST', body: JSON.stringify({ animeTitle: currentAnimeTitle, episodeNumber: currentEp, provider: currentProvider || undefined }) }); // currentAnimeTitle is already escaped
    if (!data || !data.authorized || !data.streamUrl) { alert(window._escapeHTML('Download authorization failed.')); return; }
    var downloadInfo = { animeTitle: currentAnimeTitle, episodeNumber: currentEp, streamUrl: data.streamUrl, quality: data.quality || 'auto', provider: data.provider || currentProvider };
    document.getElementById('offlineMeta').textContent = window._escapeHTML(currentAnimeTitle + ' - Ep ' + currentEp + ' (' + downloadInfo.quality + ')'); // Escape dynamic content
    document.getElementById('offlineStatus').textContent = 'Ready to start download.';
    document.getElementById('offlineModal').style.display = 'flex';
    window.__pendingDownload = downloadInfo;
  } catch (e) { console.error('Download error:', e); alert('Download failed: ' + e.message); }
}
window.handleDownload = handleDownload;

function closeOfflineModal() { document.getElementById('offlineModal').style.display = 'none'; document.getElementById('offlineProgress').style.width = '0%'; window.__pendingDownload = null; }

window.closeOfflineModal = closeOfflineModal;

async function startOfflineDownload() {
  var info = window.__pendingDownload;
  if (!info) return;
  var progressFill = document.getElementById('offlineProgress');
  var statusEl = document.getElementById('offlineStatus');
  var startBtn = document.getElementById('offlineStartBtn');
  startBtn.disabled = true;
    startBtn.textContent = window._escapeHTML('Downloading...');
  statusEl.textContent = 'Downloading episode (sandboxed)...';
  try {
    var response = await fetch(info.streamUrl);
    var contentLength = response.headers.get('content-length');
    var total = contentLength ? parseInt(contentLength, 10) : 0;
    var reader = response.body.getReader();
    var chunks = [];
    var received = 0;
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.length;
      if (total > 0) { var pct = Math.min(100, Math.round((received / total) * 100)); progressFill.style.width = pct + '%'; statusEl.textContent = 'Downloading... ' + pct + '% (' + (received / 1024 / 1024).toFixed(1) + ' MB)'; }
      else { progressFill.style.width = '50%'; statusEl.textContent = 'Downloading... ' + (received / 1024 / 1024).toFixed(1) + ' MB'; }
    }
    var blob = new Blob(chunks, { type: 'video/mp4' });
    var offlineList = getOfflineList();
    offlineList.push({ animeTitle: info.animeTitle, episodeNumber: info.episodeNumber, quality: info.quality, provider: info.provider, downloadedAt: new Date().toISOString(), blobSize: blob.size, blobType: blob.type });
    saveOfflineList(offlineList);
    await storeBlobInIndexedDB(info.animeTitle, info.episodeNumber, blob);
    progressFill.style.width = '100%';
    statusEl.textContent = '✅ Download complete! (Sandboxed storage)';
    startBtn.textContent = 'Downloaded ✓';
    startBtn.disabled = false;
    setTimeout(closeOfflineModal, 2000);
  } catch (e) { console.error('Offline download failed:', e); statusEl.textContent = '❌ Download failed: ' + window._escapeHTML(e.message); startBtn.textContent = 'Retry'; startBtn.disabled = false; }
}
window.startOfflineDownload = startOfflineDownload;

function deleteOfflineDownload() {
  // DORMANT: No download UI in new HTML
  var list = getOfflineList();
  var filtered = list.filter(function(e) { return !(e.animeTitle === currentAnimeTitle && e.episodeNumber === currentEp); });
  saveOfflineList(filtered);
  deleteBlobFromIndexedDB(currentAnimeTitle, currentEp); // currentAnimeTitle is already escaped
  document.getElementById('offlineStatus').textContent = '🗑️ Deleted from offline storage.';
  document.getElementById('offlineDeleteBtn').style.display = 'none';
  document.getElementById('offlineStartBtn').textContent = 'Start Download';
  document.getElementById('offlineProgress').style.width = '0%';
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
  // DORMANT: No download UI in new HTML
  if (!State.isPremium && !State.isAdmin) { if (confirm('Offline downloads are available for premium users only. Upgrade now?')) location.href = 'upgrade.html'; return; }
  if (!ep || !ep.id) { alert('Cannot download this episode.'); return; }
  var dlBtn = document.getElementById('download-btn');
  if (dlBtn) { dlBtn.textContent = 'Starting download...'; dlBtn.disabled = true; }
  try {
    // Use fetch with Authorization header instead of token in URL
    var token = State.token || localStorage.getItem('token') || '';
    var response = await fetch(API + '/api/download/' + ep.id, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!response.ok) {
      var errData = await response.json().catch(function() { return {}; });
      throw new Error(errData.message || 'Download failed (status ' + response.status + ')');
    }
    // Get the blob from the response
    var blob = await response.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (currentAnime && currentAnime.title || 'anime') + '_ep' + currentEp + '.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (dlBtn) { dlBtn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download'; dlBtn.disabled = false; }
  } catch(e) {
    console.error('Download error:', e);
    if (dlBtn) { dlBtn.disabled = false; dlBtn.innerHTML = 'Download'; }
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
    if (isHlsStream && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(source);
      hlsInstance.attachMedia(video);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, function() { resolve(); });
      hlsInstance.on(window.Hls.Events.ERROR, function(_event, data) {
        if (data.fatal) reject(new Error('HLS playback could not start.'));
      });
      return;
    }

    video.src = source;
    video.addEventListener('loadedmetadata', function() { resolve(); }, { once: true });
    video.addEventListener('error', function() { reject(new Error('Video source could not be loaded.')); }, { once: true });
    video.load();
  });
}

async function loadSkipTimes(animeId, episodeNumber) {
  introRange = null;
  try {
    var { data } = await apiFetch('/api/watch/skip-times/' + encodeURIComponent(animeId) + '/' + encodeURIComponent(episodeNumber));
    if (data && data.op && Number.isFinite(Number(data.op.start)) && Number.isFinite(Number(data.op.end))) {
      introRange = { start: Number(data.op.start), end: Number(data.op.end) };
    }
  } catch (error) {
    console.debug('No skip-intro marker available:', error.message);
  }
}
