// watch.js — Premium skip intro + autoplay next episode
let currentAnime = null;
let currentEp    = 1;
let nextEpData   = null;
let currentEpId  = null;
let autoplayCountdown = null;

async function loadWatch() {
  const params   = new URLSearchParams(window.location.search);
  // Support both new (animeId / epId) and legacy (id / ep) param names
  const animeId  = params.get('animeId') || params.get('id');
  const epIdRaw  = params.get('epId') || params.get('ep');
  currentEp      = parseInt(epIdRaw) || 1;
  if (!animeId) { showWatchError('Missing anime ID. Please go back and try again.'); return; }

  try {
    // Fetch anime metadata
    const { data: animeData } = await apiFetch(`/api/anime/${animeId}`);
    currentAnime = animeData;
    if (!animeData || !animeData.id) { showWatchError('Could not load anime data. It may have been removed.'); return; }

    document.title = `Ep ${currentEp} - ${animeData.title} | AniStrim`;
    document.getElementById('watch-ep-title').textContent   = `Episode ${currentEp}`;
    document.getElementById('watch-anime-title').textContent = animeData.title;

    // Fetch episodes from the dedicated endpoint
    const { data: episodesData } = await apiFetch(`/api/anime/${animeId}/episodes`);
    const episodes = Array.isArray(episodesData) ? episodesData : [];

    // Find the target episode — by epId (DB id) or by episode_number fallback
    let ep;
    if (params.get('epId')) {
      // New format: epId is the DB primary key
      ep = episodes.find(e => String(e.id) === String(params.get('epId')));
    }
    if (!ep) {
      // Legacy fallback: match by episode number
      ep = episodes.find(e => (e.number || e.episode_number) === currentEp);
    }
    currentEpId  = ep?.id || null;
    nextEpData   = episodes.find(e => (e.number || e.episode_number) === ((ep?.number || ep?.episode_number || currentEp) + 1)) || null;

    // Premium content lock — free users can't watch premium episodes
    if (ep?.is_premium && !State.isPremium && !State.isAdmin) {
      document.getElementById('premium-lock').style.display     = 'flex';
      document.getElementById('video-placeholder').style.display = 'none';
      renderMoreEpisodes(episodes, animeId);
      return;
    }

    const video = document.getElementById('main-video');
    if (ep?.video_url) {
      // Static video URL (e.g. Cloudinary) — play directly
      video.src = ep.video_url;
      document.getElementById('video-placeholder').style.display = 'none';
      setupPlayer(video);
    } else {
      // No static URL — resolve a fresh streaming link on demand
      const placeholder = document.getElementById('video-placeholder');
      const spinner = document.getElementById('stream-spinner');
      const errorDiv = document.getElementById('stream-error');
      placeholder.style.display = 'flex';
      if (spinner) spinner.style.display = 'block';
      if (errorDiv) errorDiv.style.display = 'none';

      // Fetch the stream URL from our Consumet-powered endpoint
      try {
        const title = encodeURIComponent(currentAnime.title);
        const epNum = currentEp;
        const { data: streamData } = await apiFetch(`/api/anime/resolve/stream?animeTitle=${title}&episodeNumber=${epNum}`);

        if (streamData?.streamUrl) {
          placeholder.style.display = 'none';  // hide placeholder since video will play

          // If HLS.js is available and the stream is .m3u8, use HLS for better playback
          if (typeof Hls !== 'undefined' && streamData.streamUrl.includes('.m3u8')) {
            const hls = new Hls();
            hls.loadSource(streamData.streamUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              video.play().catch(() => {});
            });
          } else {
            // Fallback: native HTML5 with direct URL
            video.src = streamData.streamUrl;
          }

          setupPlayer(video);
        } else {
          throw new Error(streamData?.error || 'No stream URL returned');
        }
      } catch (err) {
        console.error('Stream resolution failed:', err.message);
        if (spinner) spinner.style.display = 'none';
        if (errorDiv) errorDiv.style.display = 'block';
      }
    }

    renderMoreEpisodes(episodes, animeId);

    // Show premium feature banner for free users
    if (!State.isPremium && !State.isAdmin) {
      showPremiumFeatureBanner();
    }

  } catch(e) {
    console.error('Watch error:', e);
    showWatchError('Network error. Please check your connection and try again.');
  }
}

function setupPlayer(video) {
  const wrap        = document.getElementById('player-wrap');
  const fill        = document.getElementById('progress-fill');
  const timeDisplay = document.getElementById('time-display');
  const playIcon    = document.getElementById('play-icon');
  const skipBtn     = document.getElementById('skip-intro-btn');
  const nextBanner  = document.getElementById('next-ep-banner');
  const isPremium   = State.isPremium || State.isAdmin;

  // Resume from saved position
  if (currentEpId) loadProgress(video, currentEpId);

  video.addEventListener('timeupdate', () => {
    const pct = (video.currentTime / (video.duration || 1)) * 100;
    fill.style.width = pct + '%';
    timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;

    // ── PREMIUM ONLY: Skip Intro button (shows 5s – 90s) ──────────────
    if (isPremium) {
      skipBtn.style.display = (video.currentTime > 5 && video.currentTime < 90) ? 'block' : 'none';
    } else {
      skipBtn.style.display = 'none'; // Free users never see skip intro
    }

    // ── PREMIUM ONLY: Autoplay next episode countdown ─────────────────
    if (isPremium && nextEpData && video.duration) {
      const remaining = video.duration - video.currentTime;
      if (remaining <= 30 && remaining > 0) {
        nextBanner.style.display = 'block';
        // Update countdown seconds
        const secEl = document.getElementById('next-ep-countdown');
        if (secEl) secEl.textContent = Math.ceil(remaining);
      } else if (remaining > 30) {
        nextBanner.style.display = 'none';
      }
    }

    // Save progress every 10 seconds
    if (currentEpId && Math.floor(video.currentTime) % 10 === 0 && video.currentTime > 0) {
      saveProgress(currentEpId, Math.floor(video.currentTime), false);
    }
  });

  // When video ends
  video.addEventListener('ended', () => {
    if (currentEpId) saveProgress(currentEpId, Math.floor(video.duration || 0), true);

    if (isPremium && nextEpData) {
      // Premium: auto-play next episode after 5 seconds
      startAutoplayCountdown();
    } else if (!isPremium && nextEpData) {
      // Free users: show "next episode" but require them to click
      nextBanner.style.display = 'block';
      document.getElementById('next-ep-auto-label').style.display = 'none';
      document.getElementById('next-ep-manual-label').style.display = 'block';
    }
  });

  video.addEventListener('play', () => {
    playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    wrap.classList.remove('paused');
  });
  video.addEventListener('pause', () => {
    playIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    wrap.classList.add('paused');
    // If user pauses, cancel any autoplay countdown
    cancelAutoplay();
  });

  video.play().catch(() => wrap.classList.add('paused'));
}

// ── PREMIUM: 5-second autoplay countdown ─────────────────────────────
function startAutoplayCountdown() {
  const nextBanner = document.getElementById('next-ep-banner');
  const countEl    = document.getElementById('autoplay-countdown-num');
  nextBanner.style.display = 'block';
  document.getElementById('next-ep-auto-label').style.display  = 'block';
  document.getElementById('next-ep-manual-label').style.display = 'none';

  let sec = 5;
  if (countEl) countEl.textContent = sec;

  autoplayCountdown = setInterval(() => {
    sec--;
    if (countEl) countEl.textContent = sec;
    if (sec <= 0) {
      cancelAutoplay();
      playNextEp();
    }
  }, 1000);
}

function cancelAutoplay() {
  if (autoplayCountdown) { clearInterval(autoplayCountdown); autoplayCountdown = null; }
}
window.cancelAutoplay = cancelAutoplay;

// ── FREE USER: Show a teaser banner about premium features ───────────
function showPremiumFeatureBanner() {
  const existing = document.getElementById('premium-feature-hint');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'premium-feature-hint';
  banner.style.cssText = `
    background: linear-gradient(135deg, rgba(139,92,246,0.15), rgba(249,115,22,0.1));
    border: 1px solid rgba(139,92,246,0.3);
    border-radius: 10px; padding: 12px 16px; margin: 12px 20px;
    display: flex; align-items: center; gap: 12px;
  `;
  banner.innerHTML = `
    <span style="font-size:1.4rem;">👑</span>
    <div style="flex:1;">
      <div style="font-size:0.88rem;font-weight:600;margin-bottom:2px;">Upgrade for Skip Intro &amp; Autoplay</div>
      <div style="font-size:0.78rem;color:var(--text-muted);">Premium members skip ads, auto-play next episodes and more.</div>
    </div>
    <a href="upgrade.html" style="background:var(--purple);color:#fff;padding:7px 14px;border-radius:6px;font-size:0.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">Upgrade</a>
  `;
  const watchInfo = document.querySelector('.watch-info');
  if (watchInfo) watchInfo.after(banner);
}

// ── Progress helpers ──────────────────────────────────────────────────
async function loadProgress(video, epId) {
  try {
    const { data } = await apiFetch(`/api/watchlist/progress/${epId}`);
    if (data?.progress_sec > 10 && !data.completed) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = data.progress_sec;
        const badge = document.getElementById('resume-badge');
        if (badge) {
          badge.style.display = 'block';
          setTimeout(() => badge.style.display = 'none', 4000);
        }
      }, { once: true });
    }
  } catch(e) {}
}

async function saveProgress(epId, sec, completed) {
  try {
    await apiFetch('/api/watchlist/progress', {
      method: 'POST',
      body: JSON.stringify({ episodeId: epId, progressSec: sec, completed })
    });
  } catch(e) {}
}

// ── Player controls ───────────────────────────────────────────────────
function togglePlay() {
  const v = document.getElementById('main-video');
  v.paused ? v.play() : v.pause();
}
window.togglePlay = togglePlay;

function skipBack() {
  const v = document.getElementById('main-video');
  if (!isFinite(v.duration)) return;
  v.currentTime = Math.max(0, v.currentTime - 10);
}
function skipForward() {
  const v = document.getElementById('main-video');
  if (!isFinite(v.duration)) return;
  v.currentTime = Math.min(v.duration - 0.5, v.currentTime + 10);
}
function setVolume(v)  { document.getElementById('main-video').volume = parseFloat(v); }
window.skipBack    = skipBack;
window.skipForward = skipForward;
window.setVolume   = setVolume;

function seekVideo(e) {
  const v    = document.getElementById('main-video');
  const rect = e.currentTarget.getBoundingClientRect();
  v.currentTime = ((e.clientX - rect.left) / rect.width) * (v.duration || 0);
}
window.seekVideo = seekVideo;

function toggleFullscreen() {
  const wrap = document.getElementById('player-wrap');
  if (!document.fullscreenElement) {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}
window.toggleFullscreen = toggleFullscreen;

function skipIntro() {
  // Only works for premium — button is hidden for free users anyway
  if (!State.isPremium && !State.isAdmin) return;
  document.getElementById('main-video').currentTime = 90;
  document.getElementById('skip-intro-btn').style.display = 'none';
}
window.skipIntro = skipIntro;

function playNextEp() {
  cancelAutoplay();
  if (!nextEpData || !currentAnime) return;
  location.href = `watch.html?animeId=${currentAnime.id}&epId=${nextEpData.id}`;
}
window.playNextEp = playNextEp;

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

function renderMoreEpisodes(episodes, animeId) {
  const container = document.getElementById('more-episodes');
  if (!container) return;
  const epNum = currentEp;
  const others = episodes.filter(e => (e.number || e.episode_number) !== epNum).slice(0, 12);
  if (!others.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No other episodes available.</p>';
    return;
  }
  container.innerHTML = others.map(e => {
    const isLocked = e.is_premium && !State.isPremium && !State.isAdmin;
    const displayNum = e.number || e.episode_number;
    return `
      <div class="episode-item" onclick="location.href='watch.html?animeId=${animeId}&epId=${e.id}'">
        <div class="ep-num" style="${isLocked ? 'color:var(--orange)' : ''}">${isLocked ? '🔒' : displayNum}</div>
        <div class="ep-info">
          <div class="ep-title">${e.title || 'Episode ' + displayNum} ${e.is_premium ? '<span style="color:var(--orange);font-size:0.72rem;">👑 Premium</span>' : ''}</div>
          <div class="ep-duration">${fmtTime(e.duration_sec || 1440)}</div>
        </div>
        <span class="ep-play" style="color:${isLocked ? 'var(--orange)' : 'var(--text-muted)'}">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            ${isLocked
              ? '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
              : '<polygon points="5 3 19 12 5 21 5 3"/>'}
          </svg>
        </span>
      </div>`;
  }).join('');
}

// ── Error state (replaces redirect to browse) ─────────────────────────
function showWatchError(msg) {
  const wrap = document.getElementById('player-wrap');
  const info = document.querySelector('.watch-info');
  const moreEp = document.getElementById('more-episodes');
  if (wrap) wrap.style.display = 'none';
  if (info) info.style.display = 'none';
  if (moreEp) moreEp.style.display = 'none';

  let errEl = document.getElementById('watch-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.id = 'watch-error';
    errEl.style.cssText = `
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:60px 20px; text-align:center; min-height:50vh;
    `;
    const main = document.querySelector('.player-wrap + .watch-info')?.parentNode || document.body;
    // Insert after the navbar
    const nav = document.querySelector('.navbar');
    if (nav && nav.parentNode) {
      nav.parentNode.insertBefore(errEl, nav.nextSibling);
    } else {
      document.body.prepend(errEl);
    }
  }
  errEl.style.display = 'flex';

  // Get animeId from URL for the detail link
  const urlParams = new URLSearchParams(window.location.search);
  const animeId = urlParams.get('animeId') || urlParams.get('id');
  errEl.innerHTML = `
    <div style="font-size:3rem;margin-bottom:12px;">⚠️</div>
    <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:8px;">Something went wrong</h3>
    <p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:20px;max-width:360px;">${msg}</p>
    <div style="display:flex;gap:10px;">
      <button class="btn-primary" onclick="location.reload()">↺ Retry</button>
      ${animeId ? `<button class="btn-secondary" onclick="location.href='details.html?id=${animeId}'">← Back to Details</button>` : ''}
      <button class="btn-secondary" onclick="location.href='browse.html'">🔍 Browse Anime</button>
    </div>
  `;
}
window.showWatchError = showWatchError;

document.addEventListener('DOMContentLoaded', loadWatch);

async function downloadEpisode(ep) {
  if (!State.isPremium && !State.isAdmin) {
    if (confirm('Offline downloads are available for premium users only. Upgrade now?')) {
      location.href = 'upgrade.html';
    }
    return;
  }

  if (!ep?.id) {
    alert('Cannot download this episode.');
    return;
  }

  const dlBtn = document.getElementById('download-btn');
  if (dlBtn) { dlBtn.textContent = 'Starting download...'; dlBtn.disabled = true; }

  try {
    // Use server-side proxy — avoids CORS, streams with auth
    const token = State.token || localStorage.getItem('token') || '';
    const a     = document.createElement('a');
    a.href      = `${BACKEND}/api/download/${ep.id}?token=${encodeURIComponent(token)}`;
    a.download  = `${currentAnime?.title || 'anime'}_ep${currentEp}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    saveDownloadRecord(ep);

    if (dlBtn) {
      dlBtn.innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download`;
      dlBtn.disabled = false;
    }

  } catch(e) {
    console.error('Download error:', e);
    if (dlBtn) { dlBtn.disabled = false; dlBtn.innerHTML = 'Download'; }
    alert('Download failed. Please try again.');
  }
}