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

    if (nextEpData) {
      document.getElementById('next-ep-title').textContent = 'Episode ' + (nextEpData.number || nextEpData.episode_number);
    }

    if (ep && ep.is_premium && !State.isPremium && !State.isAdmin) {
      document.getElementById('premium-lock').style.display = 'flex';
      document.getElementById('video-placeholder').style.display = 'none';
      renderMoreEpisodes(episodes, animeId);
      return;
    }

    var video = document.getElementById('animePlayer');

    if (ep && ep.video_url) {
      await attachStreamSource(video, ep.video_url);
      document.getElementById('video-placeholder').style.display = 'none';
      setupPlayer(video);
    } else {
      var placeholder = document.getElementById('video-placeholder');
      var spinner = document.getElementById('stream-spinner');
      var errorDiv = document.getElementById('stream-error');
      placeholder.style.display = 'flex';
      if (spinner) spinner.style.display = 'block';
      if (errorDiv) errorDiv.style.display = 'none';

      try {
        await fetchAvailableProviders(animeData.title, currentEp);
        await resolveAndPlayStream(animeData.title, currentEp, video);
        placeholder.style.display = 'none';
        setupPlayer(video);
      } catch (err) {
        console.error('Stream resolution failed:', err.message);
        if (spinner) spinner.style.display = 'none';
        if (errorDiv) errorDiv.style.display = 'block';
      }
    }

    loadSkipTimes(animeId, (ep && (ep.number || ep.episode_number)) || currentEp);
    renderMoreEpisodes(episodes, animeId);

    if (State.isPremium || State.isAdmin) {
      document.getElementById('download-btn').style.display = 'flex';
    } else {
      showPremiumFeatureBanner();
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
  var select = document.getElementById('serverSwitcher');
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
  });
}

// ── Multi-API: Resolve and play stream ──────────────────────
async function resolveAndPlayStream(animeTitle, episodeNumber, video, preferredProvider) {
  var url = '/api/stream/' + encodeURIComponent(animeTitle) + '/' + episodeNumber;
  if (preferredProvider) {
    url += '?preferredProvider=' + preferredProvider;
  }

  console.log("[PLAYER] Requesting stream from:", url);
  var { data } = await apiFetch(url);
  console.log("[PLAYER] Stream API response", data);

  if (data && data.sources && data.sources.length > 0) {
    const API_BASE_URL = window.getApiBaseUrl();
    const sourcesToTry = data.sources.map(source => ({
        ...source,
        url: source.url.startsWith('http') ? source.url : API_BASE_URL + source.url
    }));

    for (const source of sourcesToTry) {
        try {
            console.log(`[PLAYER] Attempting to attach source: ${source.url} (Quality: ${source.quality})`);
            await attachStreamSource(video, source.url);

            currentStreamUrl = source.url;
            currentProvider = data.provider || 'unknown';
            console.log("[PLAYER] Successfully attached stream:", currentStreamUrl);

            var badge = document.getElementById('qualityBadge');
            if (badge && source.quality) { badge.textContent = source.quality; badge.style.display = 'inline-block'; }
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

  var placeholder = document.getElementById('video-placeholder');
  var spinner = document.getElementById('stream-spinner');
  placeholder.style.display = 'flex';
  if (spinner) spinner.style.display = 'block';

  try {
    await resolveAndPlayStream(currentAnimeTitle, currentEp, video, providerName || undefined);

    video.addEventListener('loadedmetadata', function() {
      if (currentTime > 5 && currentTime < (video.duration || Infinity)) {
        video.currentTime = currentTime;
      }
      if (wasPlaying) video.play()['catch'](function() {});
    }, { once: true });

    placeholder.style.display = 'none';
  } catch (err) {
    console.error('Provider switch failed:', err.message);
    if (spinner) spinner.style.display = 'none';
    document.getElementById('stream-error').style.display = 'block';
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
  }
}

// ── Player Setup ───────────────────────────────────────────
function setupPlayer(video) {
  var wrap = document.getElementById('player-wrap');
  var fill = document.getElementById('progress-fill');
  var timeDisplay = document.getElementById('time-display');
  var playIcon = document.getElementById('play-icon');
  var controls = document.getElementById('videoControls');
  var skipBtn = document.getElementById('skipIntroBtn');
  var nextBanner = document.getElementById('nextEpisodeBtn');
  var isPremium = State.isPremium || State.isAdmin;

  // Diagnostic Listeners
  video.addEventListener("loadstart", () => console.log("[PLAYER] Event: loadstart"));
  video.addEventListener("loadedmetadata", () => console.log("[PLAYER] Event: loadedmetadata - duration:", video.duration));
  video.addEventListener("canplay", () => console.log("[PLAYER] Event: canplay"));
  video.addEventListener("playing", () => console.log("[PLAYER] Event: playing"));
  video.addEventListener("error", () => console.error("[PLAYER] Event: error", { code: video.error.code, message: video.error.message, networkState: video.networkState, readyState: video.readyState, currentSrc: video.currentSrc }));

  if (currentEpId) loadProgress(video, currentEpId);

  video.addEventListener('timeupdate', function() {
    var pct = (video.currentTime / (video.duration || 1)) * 100;
    fill.style.width = pct + '%';
    timeDisplay.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration);

    if (isPremium && introRange && video.currentTime >= introRange.start && video.currentTime < introRange.end) {
      skipBtn.style.display = 'block';
      skipBtn.classList.remove('hidden');
    } else {
      skipBtn.style.display = 'none';
      skipBtn.classList.add('hidden');
    }

    if (isPremium && nextEpData && video.duration) {
      var remaining = video.duration - video.currentTime;
      if (remaining <= 30 && remaining > 0) {
        nextBanner.style.display = 'block';
        var secEl = document.getElementById('autoplay-countdown-num');
        if (secEl) secEl.textContent = Math.ceil(remaining);
      } else if (remaining > 30) {
        nextBanner.style.display = 'none';
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
      nextBanner.style.display = 'block';
      document.getElementById('next-ep-auto-label').style.display = 'none';
      document.getElementById('next-ep-manual-label').style.display = 'block';
    }
  });

  video.addEventListener('play', function() {
    playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
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
    showControls(controls);
  });
  video.addEventListener('pause', function() {
    playIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    wrap.classList.add('paused');
    showControls(controls);
    cancelAutoplay();
  });

  setupControlsAutoHide(wrap, controls);
  video.play()['catch'](function() { wrap.classList.add('paused'); });
}

function setupControlsAutoHide(wrap, controls) {
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
    if (e.target.closest('#videoControls') || e.target.closest('.skip-intro-btn') || e.target.closest('.next-ep-banner')) return;
    var video = document.getElementById('animePlayer');
    if (video) togglePlay();
  });
}

function showControls(controls) {
  if (!controls) controls = document.getElementById('videoControls');
  if (controls) controls.classList.remove('hidden');
}

function hideControls(controls) {
  if (!controls) controls = document.getElementById('videoControls');
  if (controls) controls.classList.add('hidden');
}

function startAutoplayCountdown() {
  var nextBanner = document.getElementById('nextEpisodeBtn');
  var countEl = document.getElementById('autoplay-countdown-num');
  nextBanner.style.display = 'block';
  document.getElementById('next-ep-auto-label').style.display = 'block';
  document.getElementById('next-ep-manual-label').style.display = 'none';
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

function showPremiumFeatureBanner() {
  var existing = document.getElementById('premium-feature-hint');
  if (existing) return;
  var banner = document.createElement('div');
  banner.id = 'premium-feature-hint';


  var watchInfo = document.querySelector('.watch-info');
  if (watchInfo) watchInfo.after(banner);
}

async function loadProgress(video, epId) {
  try {
    var { data } = await apiFetch('/api/watchlist/progress/' + epId);
    if (data && data.progress_sec > 10 && !data.completed) {
      video.addEventListener('loadedmetadata', function() {
        video.currentTime = data.progress_sec;
        var badge = document.getElementById('resume-badge');
        if (badge) { badge.style.display = 'block'; setTimeout(function() { badge.style.display = 'none'; }, 4000); }
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
function setVolume(v) { document.getElementById('animePlayer').volume = parseFloat(v); }
window.skipBack = skipBack; window.skipForward = skipForward; window.setVolume = setVolume;
function seekVideo(e) { var v = document.getElementById('animePlayer'); var rect = e.currentTarget.getBoundingClientRect(); v.currentTime = ((e.clientX - rect.left) / rect.width) * (v.duration || 0); }
window.seekVideo = seekVideo;
function toggleFullscreen() {
  var wrap = document.getElementById('player-wrap');
  if (!document.fullscreenElement) { (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap); }
  else { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
}
window.toggleFullscreen = toggleFullscreen;
function skipIntro() { if (!State.isPremium && !State.isAdmin) return; var video = document.getElementById('animePlayer'); if (introRange) video.currentTime = introRange.end; document.getElementById('skipIntroBtn').classList.add('hidden'); }
window.skipIntro = skipIntro;
function playNextEp() { cancelAutoplay(); if (!nextEpData || !currentAnime) return; var nextNum = nextEpData.number || nextEpData.episode_number; location.href = 'watch.html?id=' + currentAnime.id + '&ep=' + nextNum; }
window.playNextEp = playNextEp;
function fmtTime(s) { if (!s || isNaN(s)) return '0:00'; return Math.floor(s/60) + ':' + Math.floor(s%60).toString().padStart(2,'0'); }

function renderMoreEpisodes(episodes, animeId) {
  var container = document.getElementById('more-episodes');
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
    var targetEpNum = e.number || e.episode_number;
    return '<div class="episode-item" onclick="location.href=\'watch.html?id=' + animeId + '&ep=' + targetEpNum + '\'"><div class="ep-thumb-wrap"><img src="' + thumbSrc + '" alt="' + epTitle.replace(/'/g,"\\'") + '" loading="lazy" onerror="cardImgError(this,\'' + epTitle.replace(/'/g,"\\'") + '\')" style="width:60px;height:40px;object-fit:cover;border-radius:4px;"></div><div class="ep-num" style="' + lockColor + '">' + lockIcon + '</div><div class="ep-info"><div class="ep-title">' + window._escapeHTML(epTitle) + premiumTag + '</div><div class="ep-duration">' + fmtTime(e.duration_sec || 1440) + '</div><span class="ep-play" style="color:' + playColor + '"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' + playSvg + '</svg></span></div></div>';
  }).join('');
}

function showWatchError(msg) {
  var wrap = document.getElementById('player-wrap');
  var info = document.querySelector('.watch-info');
  var moreEp = document.getElementById('more-episodes');
  if (wrap) wrap.style.display = 'none';
  if (info) info.style.display = 'none';
  if (moreEp) moreEp.style.display = 'none';
  var errEl = document.getElementById('watch-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.id = 'watch-error';
    errEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;min-height:50vh;';
    var nav = document.querySelector('.navbar');
    if (nav && nav.parentNode) nav.parentNode.insertBefore(errEl, nav.nextSibling);
    else document.body.prepend(errEl);
  }
  errEl.style.display = 'flex';
  var urlParams = new URLSearchParams(window.location.search);
  var animeId = urlParams.get('animeId') || urlParams.get('id');
  var backBtn = animeId ? '<button class="btn-secondary" onclick="location.href=\'details.html?id=' + animeId + '\'">&#8592; Back to Details</button>' : '';
  errEl.innerHTML = '<div style="font-size:3rem;margin-bottom:12px;">&#9888;&#65039;</div><h3 style="font-size:1.1rem;font-weight:700;margin-bottom:8px;">Something went wrong</h3><p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:20px;max-width:360px;">' + msg + '</p><div style="display:flex;gap:10px;"><button class="btn-primary" onclick="location.reload()">&#8635; Retry</button>' + backBtn + '<button class="btn-secondary" onclick="location.href=\'browse.html\'">&#128269; Browse Anime</button></div>';
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
