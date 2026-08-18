// watch.js — AniStrim Premium Watch Experience
// ─────────────────────────────────────────────────────────────
// TEMPORARY DEBUG: Log script evaluation + catch any errors that
// would prevent loadWatch() from being registered.
console.log('[WATCH DEBUG] watch.js script evaluating');
window.addEventListener('error', function(e) {
  console.error('[WATCH DEBUG] Global JS error:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', function(e) {
  console.error('[WATCH DEBUG] Unhandled promise rejection:', e.reason);
});

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

// ── Access-state helpers (server-authoritative) ──────────
// Prompt 6: frontend gating is COSMETIC ONLY. The server is the boundary.
// The frontend reads ONLY the server-emitted fields effectiveTier / locked /
// availableAt / accessState — never is_premium, never localStorage, never a
// JWT claim.
function episodeIsLocked(ep) {
  // Server says locked — trust it. Fall back to effectiveTier for safety.
  if (ep && typeof ep.locked === 'boolean') return ep.locked;
  return !!(ep && ep.effectiveTier === 'premium');
}

function episodeAccessLabel(ep) {
  const state = (ep && ep.accessState) || (ep && ep.effectiveTier === 'premium' ? 'premium_required' : 'free');
  switch (state) {
    case 'free':            return 'Free';
    case 'premium':         return 'Premium';
    case 'in_grace':        return 'In grace period';
    case 'subscription_expired': return 'Subscription expired';
    case 'scheduled': {
      const d = ep && ep.availableAt ? new Date(ep.availableAt) : null;
      if (d && !isNaN(d.getTime())) {
        return 'Free on ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      }
      return 'Scheduled release';
    }
    case 'premium_required':
    default:                return 'Premium required';
  }
}

function episodeAccessClass(ep) {
  const state = (ep && ep.accessState) || (ep && ep.effectiveTier === 'premium' ? 'premium_required' : 'free');
  return 'access-' + state;
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

// ── Phase 10 / Prompt 2: Stream authorization state ─────────
// The hardened playback path requires a short-lived HMAC token minted by
// POST /api/stream/authorize (120s TTL). We cache the token + streamId and
// refresh it before expiry so long episodes never break mid-playback.
let streamAuth = { token: null, streamId: null, expiresAt: 0, episodeId: null };
let streamAuthRefreshTimer = null;
const STREAM_TOKEN_TTL_MS = 120 * 1000; // must match utils/streamToken.js
const STREAM_TOKEN_REFRESH_MS = 100 * 1000; // refresh 20s before expiry

/**
 * Authorize playback for an episode via POST /api/stream/authorize.
 * Returns { token, streamId, expiresIn } or throws on denial.
 * Handles 403 PREMIUM_REQUIRED by rendering the premium-required state.
 */
async function authorizeStream(episodeId) {
  if (!episodeId) throw new Error('episodeId is required for stream authorization.');
  // Reuse a still-valid token for the same episode.
  if (streamAuth.token && streamAuth.episodeId === String(episodeId) && Date.now() < streamAuth.expiresAt) {
    return streamAuth;
  }
  const { ok, status, data } = await apiFetch('/api/stream/authorize', {
    method: 'POST',
    body: JSON.stringify({ episodeId: String(episodeId) }),
  });
  // ── FIX 8 (P1): plans.max_devices enforcement ─────────────────
  // The backend returns 403 DEVICE_LIMIT_REACHED with the active-device list
  // when the user's active sessions exceed their plan's max_devices. Surface
  // it as a DISTINCT player state (DEVICE_LIMIT_REQUIRED) — not the generic
  // PREMIUM_REQUIRED gate, and not a generic playback failure.
  if (status === 403 || (data && data.code === 'DEVICE_LIMIT_REACHED')) {
    setPlayerState(PLAYER_STATES.DEVICE_LIMIT_REQUIRED, {
      maxDevices: data.maxDevices,
      activeDevices: data.activeDevices,
    });
    showDeviceLimitGate(data);
    const err = new Error('Device limit reached.');
    err.deviceLimit = true;
    throw err;
  }
  if (status === 403 || (data && data.code === 'PREMIUM_REQUIRED')) {
    setPlayerState(PLAYER_STATES.PREMIUM_REQUIRED, {
      requiredTier: data.requiredTier,
      availableAt: data.availableAt,
    });
    showPremiumGate(currentEp ? ('Episode ' + currentEp) : 'This episode', data.requiredTier, data.availableAt);
    const err = new Error('Premium subscription required.');
    err.premiumRequired = true;
    throw err;
  }
  if (!ok) {
    throw new Error((data && data.message) || 'Stream authorization failed.');
  }
  if (!data || !data.token || !data.streamId) {
    throw new Error('Stream authorization failed: no token returned.');
  }
  // FIX 3: the backend now returns concrete proxy URLs (each streamId → token)
  // so the client never has to guess. Capture the first stream's proxy URL.
  const firstStream = Array.isArray(data.streams) && data.streams.length ? data.streams[0] : null;
  streamAuth = {
    token: data.token,
    streamId: data.streamId,
    // Concrete same-origin proxy URL (already includes ?token=) when provided.
    proxyUrl: firstStream && firstStream.url ? firstStream.url : null,
    streams: Array.isArray(data.streams) ? data.streams : [],
    expiresAt: Date.now() + (data.expiresIn || 120) * 1000,
    episodeId: String(episodeId),
  };
  scheduleStreamTokenRefresh(episodeId);
  return streamAuth;
}

/**
 * Schedule a token refresh before the current token expires.
 * Long episodes (>120s) need a fresh token to keep the proxy playable.
 */
function scheduleStreamTokenRefresh(episodeId) {
  if (streamAuthRefreshTimer) clearTimeout(streamAuthRefreshTimer);
  const delay = Math.max(1000, streamAuth.expiresAt - Date.now() - STREAM_TOKEN_REFRESH_MS);
  streamAuthRefreshTimer = setTimeout(function() {
    authorizeStream(episodeId).catch(function(err) {
      if (!err || !err.premiumRequired) {
        console.warn('[WATCH] Stream token refresh failed (non-fatal):', err && err.message);
      }
    });
  }, delay);
}

/**
 * Append the current stream token to a hardened proxy URL.
 * FIX 4: /api/stream/proxy (the un-gated query route) is DELETED. The ONLY
 * proxy is /api/stream-proxy/:streamId, which verifies { userId, episodeId,
 * streamId, ip } against the store context. So we only ever token-realize
 * /api/stream-proxy/ URLs here.
 */
function appendStreamToken(url) {
  if (!url || !streamAuth.token) return url;
  if (url.includes('/api/stream-proxy/')) {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'token=' + encodeURIComponent(streamAuth.token);
  }
  return url;
}

// FIX 3: Prefer a concrete authorized proxy URL (returned by authorize) when
// the resolved source's URL is a proxy path. This is the hardened
// /api/stream-proxy/:streamId?token= path — no guessing needed.
function preferAuthorizedProxyUrl(url) {
  if (!url) return url;
  // Only rewrite proxy-relative URLs (not absolute external CDN links).
  if (url.includes('/api/stream-proxy/')) {
    // Extract the path streamId from the resolved source to find its token.
    const m = url.match(/\/api\/stream-proxy\/([^/?]+)/);
    const streamId = m && m[1] ? m[1] : null;
    // ── FIX: NEVER fall back to streams[0].url for a streamId not in the
    // authorized list. That would attach a token minted for a DIFFERENT
    // source, which the proxy rejects with STREAM_MISMATCH. Only replace the
    // URL when we have an exact match in streamAuth.streams.
    if (streamId && Array.isArray(streamAuth.streams)) {
      const match = streamAuth.streams.find(s => String(s.streamId) === String(streamId));
      if (match && match.url) return match.url;
      // No exact match → the resolved streamId is not authorized. Do NOT guess.
      console.warn('[WATCH] Resolved streamId not in authorized streams — returning token-less URL (will 401/403):', streamId);
      return appendStreamToken(url);
    }
  }
  return appendStreamToken(url);
}

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

// ── Phase 8: PlayerAds wiring ───────────────────────────────
// The watch page fetches the player policy ONCE per episode, caches it, and
// passes it into PlayerAds.init({ policy }) so preRoll/midRoll/shouldServe never
// re-fetch (previously they issued 3 separate /api/ads/policy calls).
let adsPolicyFetched = false;      // one fetch per episode load
let adsInstance = null;            // window.PlayerAds.init() result for the episode
let currentPreRollAd = null;       // last served pre-roll ad (for skip/click emission)
let preRollOverlayEl = null;       // lightweight pre-roll ad overlay (created on demand)

// ── Playback stage timeouts (ms) ────────────────────────────
const API_TIMEOUT_MS = 30000;
// Cold AnimeHeaven resolutions can take a while (3 attempts + fallbacks).
// Keep the stream request timeout generous so a slow cold resolve isn't
// mistaken for a hard failure — the backend caches the result afterwards,
// so a retry (or Change Server) returns instantly.
const STREAM_TIMEOUT_MS = 90000;
const SOURCE_ATTACH_TIMEOUT_MS = 30000;

// ── Playback health object (debug-friendly) ────────────────
window.__aniStrimPlaybackDebug = {
  pageInitialized: false,
  animeId: null,
  episodeNumber: null,
  streamRequestStarted: false,
  streamResponseReceived: false,
  sourceCount: 0,
  selectedSource: null,
  videoElementFound: false,
  sourceAttached: false,
  metadataLoaded: false,
  canPlay: false,
  playAttempted: false,
  playSucceeded: false,
  playError: null,
};

function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches);
}

// ── PLAYBACK STATE MACHINE ────────────────────────────────
// Granular, deterministic watch-page states that distinguish source
// resolution from real playback. The page must NEVER treat
// "still loading / no source yet" or "sources: 1" as success.
// Only TIME_ADVANCING (currentTime > 0) is PLAYBACK_SUCCESS.
//
// State transitions:
//   INITIALIZING → AUTH_CHECK → PREMIUM_CHECK → STREAM_LOADING
//   STREAM_LOADING → SOURCE_RESOLVED (backend returned sources)
//   SOURCE_RESOLVED → STREAM_AUTHORIZED (token minted)
//   STREAM_AUTHORIZED → MANIFEST_REQUESTED (hls.js loadSource called)
//   MANIFEST_REQUESTED → MANIFEST_LOADED (MANIFEST_PARSED)
//   MANIFEST_LOADED → LEVEL_LOADED (variant playlist loaded)
//   LEVEL_LOADED → FRAGMENT_LOADED (first media segment loaded)
//   FRAGMENT_LOADED → BUFFER_READY (enough buffer)
//   BUFFER_READY → CANPLAY (canplay event)
//   CANPLAY → PLAY_REQUESTED (play() called)
//   PLAY_REQUESTED → PLAYING (playing event)
//   PLAYING → TIME_ADVANCING (currentTime > 0 confirmed)
//   TIME_ADVANCING → PLAYBACK_SUCCESS
//
// Any state can transition to PLAYBACK_FAILED on fatal error.
const PLAYER_STATES = {
  // ── Pre-resolution ──────────────────────────────────────
  INITIALIZING: 'INITIALIZING',
  AUTH_CHECK: 'AUTH_CHECK',
  PREMIUM_CHECK: 'PREMIUM_CHECK',

  // ── Backend resolution ──────────────────────────────────
  STREAM_LOADING: 'STREAM_LOADING',       // waiting for /api/stream response
  SOURCE_RESOLVED: 'SOURCE_RESOLVED',     // backend returned sources (NOT playback success!)
  STREAM_AUTHORIZED: 'STREAM_AUTHORIZED', // /api/stream/authorize succeeded

  // ── HLS / media loading ─────────────────────────────────
  MANIFEST_REQUESTED: 'MANIFEST_REQUESTED', // hls.js loadSource() called
  MANIFEST_LOADED: 'MANIFEST_LOADED',       // MANIFEST_PARSED fired
  LEVEL_LOADED: 'LEVEL_LOADED',             // variant playlist loaded
  FRAGMENT_LOADED: 'FRAGMENT_LOADED',       // first media segment loaded
  BUFFER_READY: 'BUFFER_READY',             // enough buffer to start

  // ── Playback ────────────────────────────────────────────
  CANPLAY: 'CANPLAY',                       // canplay event
  PLAY_REQUESTED: 'PLAY_REQUESTED',         // play() called
  PLAYING: 'PLAYING',                       // playing event
  TIME_ADVANCING: 'TIME_ADVANCING',         // currentTime > 0 confirmed
  PLAYBACK_SUCCESS: 'PLAYBACK_SUCCESS',     // all criteria met

  // ── Terminal / UI states ────────────────────────────────
  PAUSED: 'PAUSED',
  BUFFERING: 'BUFFERING',
  ENDED: 'ENDED',
  AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED',
  PLAYBACK_FAILED: 'PLAYBACK_FAILED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',
  DEVICE_LIMIT_REQUIRED: 'DEVICE_LIMIT_REQUIRED',
};
let playerState = PLAYER_STATES.INITIALIZING;

// ── Playback trace: records every state transition with safe metadata ──
window.__playbackTrace = {
  requestId: requestId,
  startedAt: new Date().toISOString(),
  transitions: [],
  hlsEvents: [],
  videoEvents: [],
  errors: [],
  success: false,
};

function recordPlaybackTrace(category, event, meta) {
  var entry = {
    ts: Date.now(),
    elapsedMs: Date.now() - new Date(window.__playbackTrace.startedAt).getTime(),
    category: category,
    event: event,
    state: playerState,
  };
  // Only include safe metadata — never tokens, JWTs, cookies, or signed URLs.
  if (meta) {
    var safe = {};
    var allowed = ['animeId', 'episodeId', 'provider', 'streamId', 'requestId',
      'status', 'contentType', 'latencyMs', 'readyState', 'networkState',
      'code', 'type', 'fatal', 'level', 'height', 'bandwidth', 'fragSn',
      'fragType', 'bufferLen', 'currentTime', 'duration', 'reason', 'mode',
      'sourceType', 'quality', 'sourceCount', 'playableSourceCount',
      'directVideo', 'hls', 'via', 'fallback', 'elapsedMs', 'timedOut',
      'isPremium', 'isAdmin', 'isLoggedIn', 'tier', 'bestQuality',
      'subtitleCount', 'episode', 'state', 'message'];
    Object.keys(meta).forEach(function(k) {
      if (allowed.indexOf(k) !== -1) safe[k] = meta[k];
    });
    entry.meta = safe;
  }
  window.__playbackTrace[category === 'state' ? 'transitions' :
    (category === 'hls' ? 'hlsEvents' :
    (category === 'video' ? 'videoEvents' :
    (category === 'error' ? 'errors' : 'transitions')))].push(entry);
}

function setPlayerState(state, meta) {
  if (!meta) meta = {};
  var prevState = playerState;
  playerState = state;
  recordPlaybackTrace('state', state, meta);
  watchLog('stateChange', { from: prevState, to: state, elapsedMs: Date.now() - new Date(window.__playbackTrace.startedAt).getTime() });
  if (window.__aniStrimPlaybackDebug) {
    window.__aniStrimPlaybackDebug.state = state;
  }
  // Update the loading-status text to reflect the current state.
  var statusText = {};
  statusText[PLAYER_STATES.INITIALIZING] = 'Preparing player...';
  statusText[PLAYER_STATES.AUTH_CHECK] = 'Checking account...';
  statusText[PLAYER_STATES.PREMIUM_CHECK] = 'Checking access...';
  statusText[PLAYER_STATES.STREAM_LOADING] = 'Finding stream...';
  statusText[PLAYER_STATES.SOURCE_RESOLVED] = 'Stream found';
  statusText[PLAYER_STATES.STREAM_AUTHORIZED] = 'Stream authorized';
  statusText[PLAYER_STATES.MANIFEST_REQUESTED] = 'Loading manifest...';
  statusText[PLAYER_STATES.MANIFEST_LOADED] = 'Manifest loaded';
  statusText[PLAYER_STATES.LEVEL_LOADED] = 'Quality loaded';
  statusText[PLAYER_STATES.FRAGMENT_LOADED] = 'Loading video...';
  statusText[PLAYER_STATES.BUFFER_READY] = 'Ready';
  statusText[PLAYER_STATES.CANPLAY] = 'Ready to play';
  statusText[PLAYER_STATES.PLAY_REQUESTED] = 'Starting playback...';
  statusText[PLAYER_STATES.PLAYING] = 'Playing';
  statusText[PLAYER_STATES.TIME_ADVANCING] = 'Playing';
  statusText[PLAYER_STATES.PLAYBACK_SUCCESS] = 'Playing';
  statusText[PLAYER_STATES.PAUSED] = 'Paused';
  statusText[PLAYER_STATES.BUFFERING] = 'Buffering...';
  statusText[PLAYER_STATES.ENDED] = 'Ended';
  statusText[PLAYER_STATES.AUTOPLAY_BLOCKED] = 'Ready to play';
  statusText[PLAYER_STATES.PLAYBACK_FAILED] = 'Playback failed';
  statusText[PLAYER_STATES.AUTH_REQUIRED] = 'Sign in required';
  statusText[PLAYER_STATES.PREMIUM_REQUIRED] = 'Premium required';
  statusText[PLAYER_STATES.DEVICE_LIMIT_REQUIRED] = 'Device limit reached';
  var statusEl = document.getElementById('loading-status');
  if (statusEl && statusText[state]) setLoadingStatus(statusText[state]);
}

// ════════════════════════════════════════════════════════════
//  PAGE LOAD / STREAM RESOLUTION  (unchanged backend contract)
// ════════════════════════════════════════════════════════════
async function loadWatch() {
  console.log('[WATCH DEBUG] loadWatch() invoked');
  watchLog('page initialized', { url: window.location.href });
  console.log('[PLAYBACK] Requested episode', { url: window.location.href });
  console.log('[WATCH DEBUG] URL =', window.location.href);
  console.log('[WATCH DEBUG] search =', window.location.search);
  console.log('[WATCH DEBUG] pathname =', window.location.pathname);
  console.log('[WATCH DEBUG] State.isLoggedIn =', State?.isLoggedIn);
  console.log('[WATCH DEBUG] State.token =', State?.token ? 'present' : 'missing');
  console.log('[WATCH DEBUG] apiFetch type =', typeof window.apiFetch);
  console.log('[WATCH DEBUG] getApiBaseUrl type =', typeof window.getApiBaseUrl);
  console.log('[WATCH DEBUG] API base =', typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : 'N/A');

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
  console.log('[WATCH DEBUG] Parsed params:', { animeId, epNumRaw, epIdRaw });
  console.log('[WATCH DEBUG] episodeId =', epIdRaw);
  console.log('[WATCH DEBUG] animeId =', animeId);
  console.log('[WATCH DEBUG] providerEpisodeId =', epIdRaw);

  if (params.get('animeId')) console.warn('[Watch] Legacy param "animeId" detected — use "id" instead');
  if (params.get('epId') && !params.get('ep')) console.warn('[Watch] Legacy param "epId" detected — use "ep" with episode NUMBER instead');

  if (epNumRaw) {
    currentEp = parseInt(epNumRaw, 10) || 1;
  } else {
    currentEp = parseInt(epIdRaw, 10) || 1;
  }

  if (!animeId) { clearTimeout(playbackTimeout); showWatchError('Missing anime ID. Please go back and try again.'); return; }

  try {
    console.log('[WATCH DEBUG] starting playback initialization');
    setLoadingStatus('Finding episode...');
    watchLog('anime request started', { animeId });
    console.log('[WATCH DEBUG] calling playback API: /api/anime/' + animeId);

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

    // ── Poster image (displayed before playback) ────────────
    // Use the anime cover image or episode thumbnail as the video poster.
    const posterUrl = (animeData.cover_image && animeData.cover_image.trim() && animeData.cover_image !== 'undefined')
      ? animeData.cover_image
      : (animeData.poster_path || '');
    const videoEl = document.getElementById('animePlayer');
    if (videoEl && posterUrl) {
      videoEl.poster = posterUrl;
    }

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
    // CRITICAL FIX: loadBatchProgress must NOT block stream resolution.
    // If the /api/watch/progress/batch/ request hangs (protected endpoint,
    // slow response), the stream request would never fire and the player
    // would stay stuck on "Preparing player...". Fire-and-forget instead.
    loadBatchProgress(animeId).catch(() => {});
    // Sidebar rendering is isolated so a UI failure never blocks stream resolution.
    try {
      renderEpisodeSidebar(episodes, animeId);
      renderSeasonNav();
      updateSidebarSeasonLabel();
    } catch (uiErr) {
      console.error('[WATCH] Sidebar render error (non-fatal, playback continues)', uiErr);
    }

    var video = document.getElementById('animePlayer');
    const loadingOverlay = document.getElementById('loading-overlay');

    // ── CANONICAL PLAYBACK PATH ─────────────────────────────
    // Both direct video_url and backend-resolved streams go through
    // initializePlayerWithSource() — the SAME function Change Server uses.
    const errorOverlay = document.getElementById('error-overlay');
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    if (errorOverlay) errorOverlay.style.display = 'none';

    // ── PREMIUM GATE (frontend, before stream resolution) ──
    // Prompt 6: gate on the server-emitted `locked` / `accessState` fields —
    // NEVER is_premium, NEVER localStorage, NEVER a JWT claim. The backend
    // ALSO enforces this server-side (403), so this is a UX improvement, not
    // the authority. Frontend gating is cosmetic only; the server is the boundary.
    if (ep && episodeIsLocked(ep)) {
      clearTimeout(playbackTimeout);
      showPremiumGate(ep.title || ('Episode ' + epNum), ep.effectiveTier, ep.availableAt, ep.accessState);
      return;
    }

    // ── Phase 8: Initialise PlayerAds (single policy fetch per episode) ──
    // Fetches /api/ads/policy once, caches it, and passes it into init() so
    // preRoll/midRoll/shouldServe never re-fetch. Premium/admin never inits.
    // Never blocks playback — failures are non-fatal and content plays anyway.
    try {
      await initAdsForEpisode();
    } catch (adsErr) {
      console.warn('[ADS] initAdsForEpisode failed (non-fatal):', adsErr && adsErr.message);
    }

    try {
      // ── PREMIUM/AUTH CHECK (informational; server enforces for real) ──
      // The backend performs the authoritative premium check. Here we only
      // log the client's known state so the page can show the correct UI.
      setPlayerState(PLAYER_STATES.PREMIUM_CHECK, {
        isPremium: State.isPremium || false,
        isAdmin: State.isAdmin || false,
        isLoggedIn: State.isLoggedIn || false,
      });

      if (ep && ep.video_url) {
        setPlayerState(PLAYER_STATES.STREAM_LOADING, { mode: 'direct' });
        setLoadingStatus('Loading video...');
        await initializePlayerWithSource(video, { url: ep.video_url, quality: 'auto' }, {
          provider: 'direct',
          sources: [{ url: ep.video_url, quality: 'auto' }],
          subtitles: []
        });
        setPlayerState(PLAYER_STATES.SOURCE_READY, { directVideo: true });
        watchLog('source selected', { directVideo: true });
      } else {
        setPlayerState(PLAYER_STATES.STREAM_LOADING, { mode: 'backend' });
        setLoadingStatus('Finding stream...');
        console.log('[PLAYBACK] Resolving stream', { animeTitle: currentAnimeTitle, episode: currentEp });
        // IMPORTANT: Use the EXACT same arguments as the "Change Server"
        // button (currentAnimeTitle + preferredProvider='animeheaven') so the
        // initial load and Change Server follow an identical, proven path.
        await resolveAndPlayStream(currentAnimeTitle, currentEp, video, 'animeheaven');
        setPlayerState(PLAYER_STATES.SOURCE_READY, { episode: currentEp });
        watchLog('stream resolution completed', { episode: currentEp });
        console.log('[PLAYBACK] Player initialization');
      }
    } catch (err) {
      console.error('[PLAYBACK] Stream resolution failed', { episode: currentEp, error: err.message });
      clearTimeout(playbackTimeout);
      setPlayerState(PLAYER_STATES.PLAYBACK_ERROR, { message: err.message });
      showWatchError(err.message || 'Stream resolution failed.');
    }

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

// ── CANONICAL PLAYER INITIALIZATION ─────────────────────────
// The single function that INITIAL page load, Change Server, Retry,
// Next episode, and Previous episode all use to attach a resolved source
// and bring up the player UI. This consolidates the previously-divergent
// paths so there is exactly ONE way playback begins.
function initializePlayerWithSource(video, source, metadata) {
  console.log('[WATCH PLAYER] Player initialization started', {
    sourceType: source && source.sourceType || 'mp4',
    quality: source && source.quality || 'auto'
  });

  // Hide the loading overlay — the player is about to become visible.
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'none';

  // Set playback metadata BEFORE source attachment (needed by setupPlayer).
  currentStreamUrl = source.url;
  currentProvider = metadata.provider || 'unknown';
  currentStreamQuality = source.quality || 'auto';
  if (metadata.sources) currentStreamSources = metadata.sources;

  // Attach subtitles if returned.
  if (metadata.subtitles && metadata.subtitles.length) {
    attachSubtitles(video, metadata.subtitles);
  }

  // Update quality display.
  const qualityValue = document.getElementById('quality-value');
  if (qualityValue) qualityValue.textContent = currentStreamQuality;

  // ── Initialize PlayerCore ONCE before source attachment ──
  // PlayerCore is the SINGLE HLS owner. It must be initialized before
  // attachStreamSource() which delegates HLS loading to it.
  ensurePlayerCoreInitialized(video);

  // Attach the source to the video element (HLS or MP4).
  return attachStreamSource(video, source.url).then(function() {
    console.log('[WATCH PLAYER] Player initialized');

    // Set up the player controls (idempotent).
    setupPlayer(video);

    console.log('[PLAYBACK] Stream resolved', { provider: currentProvider, quality: currentStreamQuality });
    return true;
  });
}

// ── Ensure PlayerCore is initialized (once per session) ─────
// Called before any source attachment. Re-initializes if the video
// element changed or if switching episodes.
function ensurePlayerCoreInitialized(video) {
  if (window.__playerCore) {
    // Re-initialize for episode switches — destroy old, create new.
    try { window.__playerCore.destroy(); } catch (e) {}
    window.__playerCore = null;
    window.__hls = null;
    hlsInstance = null;
  }

  if (!window.PlayerCore) {
    console.warn('[WATCH] PlayerCore module not loaded — HLS playback will use native only');
    return;
  }

  window.__playerCore = window.PlayerCore.init({
    video: video,
    onSourceLoaded: function () {},
    onError: function (err) {
      // ── MP4 fallback: if hls.js fails to parse the manifest for a proxy URL,
      // the source is actually an MP4. Re-attach directly via video.src (and
      // re-run setupPlayer) so the browser plays the MP4 natively. This only
      // fires when hls.js MANIFEST_PARSE_ERROR — a genuine HLS source would
      // not hit this.
      if (err && err.data && err.data.type === 'manifestError' && currentStreamUrl && /\/api\/stream-proxy\//.test(currentStreamUrl)) {
        console.warn('[WATCH] hls.js failed to parse manifest — falling back to MP4 for proxy URL');
        var v = document.getElementById('animePlayer');
        if (v && window.__playerCore) {
          try { window.__playerCore.destroy(); } catch (e) {}
          window.__playerCore = null;
          window.__hls = null;
          hlsInstance = null;
          v.removeAttribute('src');
          v.src = currentStreamUrl;
          v.load();
          // Re-run setup for the MP4 path
          playerSetupDone = false;
          setupPlayer(v);
          return;
        }
      }
      if (window.__playerResilience && window.__playerResilience.onError) {
        window.__playerResilience.onError(null, { type: 'mediaError', fatal: true, data: err });
      }
    },
    onLevels: function (levels) {
      if (levels && levels.length) {
        hlsQualityOptions = [{ label: 'Auto', value: -1 }];
        levels.forEach(function (l, i) { hlsQualityOptions.push({ label: l.height + 'p', value: i }); });
        refreshHlsQualityOptions();
      }
    },
    onManifestParsed: function () {
      setPlayerState(PLAYER_STATES.MANIFEST_LOADED, { hls: true, via: 'PlayerCore' });
      watchLog('loadedmetadata', { hls: true, via: 'PlayerCore' });
      // Populate adaptive quality selector from HLS levels.
      hlsQualityOptions = [{ label: 'Auto', value: -1 }];
      currentQualityIndex = -1;
      var qv = document.getElementById('quality-value');
      if (qv) qv.textContent = 'Auto';
      refreshHlsQualityOptions();
      refreshAudioTracks();
      populateAudioOptions();
      refreshSubtitleTracks();
      populateSubtitleOptions();
    },
    onLevelSwitched: function (level) {
      if (level >= 0) {
        var qv = document.getElementById('quality-value');
        if (qv && currentQualityIndex === -1) {
          var hls = window.__playerCore ? window.__playerCore.getHls() : null;
          var lvl = hls && hls.levels ? hls.levels[level] : null;
          if (lvl && lvl.height) qv.textContent = lvl.height + 'p';
        }
      }
    },
    onLevelLoaded: function (info) {
      recordPlaybackTrace('hls', 'LEVEL_LOADED', { level: info.level });
      if (playerState === PLAYER_STATES.MANIFEST_LOADED) {
        setPlayerState(PLAYER_STATES.LEVEL_LOADED, { level: info.level });
      }
    },
    onFragmentLoaded: function (info) {
      recordPlaybackTrace('hls', 'FRAG_LOADED', { fragSn: info.fragSn, fragType: info.type });
      if (playerState === PLAYER_STATES.LEVEL_LOADED || playerState === PLAYER_STATES.MANIFEST_LOADED) {
        setPlayerState(PLAYER_STATES.FRAGMENT_LOADED, { fragSn: info.fragSn, fragType: info.type });
      }
    }
  });

  window.__hls = window.__playerCore ? window.__playerCore.getHls() : null;
  if (window.__hls) hlsInstance = window.__hls;
}

// ── Multi-API: Resolve and play stream ──────────────────────
// Requests the stream from the backend, then uses
// initializePlayerWithSource() to attach and play it.
 async function resolveAndPlayStream(animeTitle, episodeNumber, video, preferredProvider) {
  // ── Prompt 2: Authorize playback AFTER resolving the stream ──
  // The hardened path requires a valid HMAC token from POST /api/stream/authorize.
  // IMPORTANT: authorization MUST run AFTER /api/stream is fetched. Only then are
  // the stream contexts registered server-side (via rewriteResultToProxy), so
  // authorizeStream() mints tokens bound to the EXACT streamIds the frontend will
  // play. Authorizing BEFORE the fetch mints tokens for a DIFFERENT set of
  // streamIds, so the proxy URLs returned by /api/stream can't be token-authorized
  // → the video never loads ("Unable to Play").
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

  // ── Authorize NOW (contexts are registered) ──────────────────
  // This also serves as the authoritative premium gate — a 403 PREMIUM_REQUIRED
  // renders the premium-required state and aborts playback.
  if (data && data.sources && data.sources.length > 0 && currentEpId) {
    try {
      await authorizeStream(currentEpId);
    } catch (err) {
      if (err && err.premiumRequired) throw err; // premium gate already shown
      if (err && err.deviceLimit) throw err;     // device limit gate already shown (FIX 8)
      // ── FIX: do NOT swallow authorize failures ─────────────
      // A token-less /api/stream-proxy/... URL can only 401/403 at the proxy —
      // the <video> never plays. Surface a real player error and abort.
      console.error('[WATCH] Stream authorization failed — aborting to avoid token-less playback:', err && err.message);
      setPlayerState(PLAYER_STATES.PLAYBACK_ERROR, { message: err && err.message });
      throw new Error((err && err.message) || 'Stream authorization failed. Please try again.');
    }
  }

  if (data && data.sources && data.sources.length > 0) {
    const parsedTime = Date.now();
    setPlayerState(PLAYER_STATES.SOURCE_RESOLVED, {
      provider: data.provider,
      sourceCount: data.sources.length,
      elapsedMs: parsedTime - requestStart
    });
    watchLog('stream response parsed', { sources: data.sources.length, elapsedMs: parsedTime - requestStart });

    const API_BASE_URL = window.getApiBaseUrl();
    const sourcesToTry = data.sources
      .map(source => ({
        ...source,
        // Prompt 2 + FIX 3: Prefer the concrete authorized /api/stream-proxy
        // URL (with ?token=) returned by /api/stream/authorize; fall back to
        // appending the token to the resolved proxy URL. The hardened
        // /api/stream-proxy/:streamId path is used when available.
        url: preferAuthorizedProxyUrl(source.url.startsWith('http') ? source.url : API_BASE_URL + source.url)
      }))
      // ── SOURCE SELECTION ─────────────────────────────────
      // Prefer sources that are actually suitable for browser playback and
      // drop "download-only" sources. The backend proxies AnimeHeaven via
      // /api/stream-proxy/:streamId — those are the browser-playable ones.
      // `.m3u8` (HLS) and `.mp4` (direct/proxy) are the playable formats.
      .filter(source => {
        const st = (source.sourceType || '').toLowerCase();
        const type = (source.type || '').toLowerCase();
        const url = source.url || '';
        const isProxy = url.includes('/api/stream-proxy/') || url.includes('/proxy/');
        const isPlayableFormat = /\.(m3u8|mp4)(?:$|\?)/i.test(url) || isProxy;
        // Explicitly exclude download-only sources.
        if (st === 'download' || st === 'download-link' || type === 'download') return false;
        // If we can't tell, keep it (the loop still tries and recovers).
        return isPlayableFormat || !st && !type;
      })
      // Order: proxy/HLS first, then direct MP4, then the rest.
      .sort((a, b) => {
        const aProxy = (a.url || '').includes('/api/stream-proxy/') || /\.m3u8/i.test(a.url);
        const bProxy = (b.url || '').includes('/api/stream-proxy/') || /\.m3u8/i.test(b.url);
        return (bProxy ? 1 : 0) - (aProxy ? 1 : 0);
      });
        currentStreamSources = sourcesToTry;

        // ── DOWNLOAD-BUTTON SOURCES ──────────────────────────
        // The backend separates genuine playback sources from "Download
        // Episode N" links (downloadSources, tagged forDownload:true). Keep
        // those for the premium Download button so they're never treated as
        // in-browser playable sources.
        let downloadSourcesForButton = [];
        if (Array.isArray(data.downloadSources) && data.downloadSources.length) {
          downloadSourcesForButton = data.downloadSources
            .map(s => ({
              ...s,
              url: preferAuthorizedProxyUrl(s.url.startsWith('http') ? s.url : API_BASE_URL + s.url)
            }))
            .filter(s => s && s.url);
        }
        // Fallback: if the backend didn't split them out, detect download-only
        // sources among the raw response sources (legacy/anonymous providers).
        if (!downloadSourcesForButton.length) {
          downloadSourcesForButton = (data.sources || [])
            .filter(s => {
              const st = ((s && s.sourceType) || '').toLowerCase();
              const quality = ((s && s.quality) || '').toLowerCase();
              return st === 'link' || st === 'download' || st === 'download-link' || quality.startsWith('download');
            })
            .map(s => ({ ...s, forDownload: true, url: preferAuthorizedProxyUrl(s.url.startsWith('http') ? s.url : API_BASE_URL + s.url) }))
            .filter(s => s && s.url);
        }
        window.__aniStrimDownloadSources = downloadSourcesForButton;
        if (downloadSourcesForButton.length) {
          console.log('[WATCH] Download-only sources captured for Download button', { count: downloadSourcesForButton.length });
        }

    // Log the response structure for debugging (safe fields only).
    console.log('[WATCH PLAYER] Stream response received', {
      provider: data.provider,
      sourceCount: data.sources.length,
      playableSourceCount: sourcesToTry.length,
      bestQuality: data.bestQuality,
      tier: data.tier,
      subtitleCount: (data.subtitles || []).length
    });

    if (sourcesToTry.length === 0) {
      throw new Error('No browser-playable stream source returned.');
    }

    // Try each source through the canonical player initialization.
    for (const source of sourcesToTry) {
        try {
            console.log(`[PLAYER] Attempting to attach source: ${source.url} (Quality: ${source.quality})`);
            setLoadingStatus('Connecting to server...');
            watchLog('source selected', { url: source.url, quality: source.quality });

            await initializePlayerWithSource(video, source, {
              provider: data.provider,
              sources: sourcesToTry,
              subtitles: data.subtitles || []
            });

            console.log("[PLAYER] Successfully attached stream:", currentStreamUrl);
            watchLog('video source attached', { provider: currentProvider, quality: source.quality });

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

// ── Phase 8: PlayerAds bootstrap (single policy fetch per episode) ──
// Fetches the player policy ONCE, caches it, and initialises PlayerAds with
// that cached policy so preRoll/midRoll/shouldServe never re-fetch.
// Premium/admin users never initialise the ad module (policy is empty anyway).
async function initAdsForEpisode() {
  if (!window.PlayerAds) return null;
  if (State.isPremium || State.isAdmin) return null; // premium never initialises
  try {
    const video = document.getElementById('animePlayer');
    const policy = await window.PlayerAds.fetchPolicy('player'); // ONE fetch per episode
    adsPolicyFetched = true;
    adsInstance = window.PlayerAds.init({
      context: 'player',
      video: video,
      $: window.__adSdkShowFn || null, // ad SDK show fn, if any (null → never blocks content)
      policy: policy,                  // reuse the cached policy — no re-fetch
    });
    return adsInstance;
  } catch (e) {
    console.warn('[ADS] Policy init failed (non-fatal):', e && e.message);
    return null;
  }
}

// Lightweight pre-roll overlay so a served ad has a real surface for
// skip/click emission. Created on demand; never pauses the video.
function showPreRollAd(ad, ads) {
  if (!ad || !ads) return;
  hidePreRollAd();
  const wrap = document.getElementById('player-wrap');
  if (!wrap) return;

  const overlay = document.createElement('div');
  overlay.id = 'anistrim-pre-roll-overlay';
  overlay.style.cssText = 'position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);flex-direction:column;gap:16px;';

  const label = document.createElement('div');
  label.textContent = 'Advertisement';
  label.style.cssText = 'color:rgba(255,255,255,0.7);font-size:0.85rem;letter-spacing:2px;text-transform:uppercase;';

  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip Ad';
  skipBtn.style.cssText = 'padding:10px 22px;border-radius:8px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.12);color:#fff;cursor:pointer;font-size:0.9rem;';

  // Ad click → emit 'click'.
  overlay.addEventListener('click', function(ev) {
    if (ev.target === skipBtn) return;
    ads.logEvent(ad.provider, 'pre_roll', 'click', 'player');
  });
  // Skip → emit 'skip' and dismiss.
  skipBtn.addEventListener('click', function() {
    ads.logEvent(ad.provider, 'pre_roll', 'skip', 'player');
    hidePreRollAd();
  });

  overlay.appendChild(label);
  overlay.appendChild(skipBtn);
  wrap.appendChild(overlay);
  preRollOverlayEl = overlay;
}

function hidePreRollAd() {
  if (preRollOverlayEl && preRollOverlayEl.parentNode) {
    preRollOverlayEl.parentNode.removeChild(preRollOverlayEl);
  }
  preRollOverlayEl = null;
}

// ════════════════════════════════════════════════════════════
//  PREMIUM PLAYER SETUP
// ════════════════════════════════════════════════════════════
function setupPlayer(video) {
  if (playerSetupDone) return;

  const wrap = document.getElementById('player-wrap');
  const skipBtn = document.getElementById('skip-intro-btn');
  const skipOutroBtn = document.getElementById('skip-outro-btn');
  const nextBanner = document.getElementById('next-episode-overlay');
  var isPremium = State.isPremium || State.isAdmin;

  // ── Instrumented playback events (prevent silent failures) ──
  const VIDEO_EVENT_LABELS = {
    loadstart: 'MEDIA_LOAD_START',
    loadedmetadata: 'MEDIA_METADATA_LOADED',
    loadeddata: 'MEDIA_DATA_LOADED',
    canplay: 'CANPLAY',
    playing: 'PLAYING',
    waiting: 'WAITING',
    stalled: 'STALLED',
    error: 'VIDEO_ERROR',
  };
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error'].forEach(eventName => {
    video.addEventListener(eventName, () => {
      // ── SAFE DIAGNOSTIC (no token/secret/signed-URL values) ──
      if (VIDEO_EVENT_LABELS[eventName]) {
        console.log('[PLAYER_EVENT]', VIDEO_EVENT_LABELS[eventName], {
          currentTime: video.currentTime,
          readyState: video.readyState,
          networkState: video.networkState,
          duration: video.duration || null,
        });
      }
      watchLog(eventName, {
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
      });
      const loadingOverlay = document.getElementById('loading-overlay');
      const bufferingEl = document.getElementById('buffering-spinner');
      if (eventName === 'waiting' || eventName === 'stalled') {
        setPlayerState(PLAYER_STATES.BUFFERING, { readyState: video.readyState });
        setLoadingStatus('Buffering...');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        if (bufferingEl) bufferingEl.classList.add('visible');
      } else if (eventName === 'playing') {
        setPlayerState(PLAYER_STATES.PLAYING, { readyState: video.readyState });
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (bufferingEl) bufferingEl.classList.remove('visible');
      } else if (eventName === 'canplay') {
        setPlayerState(PLAYER_STATES.SOURCE_READY, { readyState: video.readyState });
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (bufferingEl) bufferingEl.classList.remove('visible');
      } else if (eventName === 'loadedmetadata') {
        setPlayerState(PLAYER_STATES.PLAYER_LOADING, { readyState: video.readyState });
      } else if (eventName === 'error') {
        setPlayerState(PLAYER_STATES.PLAYBACK_ERROR, {
          code: video.error ? video.error.code : null,
          message: video.error ? video.error.message : null
        });
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (bufferingEl) bufferingEl.classList.remove('visible');
      }
    });
  });

  if (currentEpId) loadProgress(video, currentAnimeId, currentEp);

  // ── FIX A: Wire js/progress.js (offline queue, visibility/pagehide flush) ──
  // The module is loaded but was never initialized. Initialize it here with a
  // getState callback so IndexedDB offline queuing, visibilitychange→hidden
  // flush, and online-reconnect flush actually work.
  if (window.Progress) {
    const getProgressState = () => ({
      episodeId:   currentEpId,
      positionSec: Math.floor(video.currentTime || 0),
      durationSec: Math.floor(video.duration || 0)
    });
    window.Progress.init(getProgressState);
    window.Progress.startAutoSave(getProgressState);
  }

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
    // FIX A: route through Progress.ended() when available
    if (currentEpId) {
      if (window.Progress && typeof window.Progress.ended === 'function') {
        window.Progress.ended(currentEpId, Math.floor(video.duration || 0), Math.floor(video.duration || 0));
      } else {
        saveProgress(currentEpId, Math.floor(video.duration || 0), true, Math.floor(video.duration || 0));
      }
    }
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
    // FIX A: route through Progress.pause() when available
    if (currentEpId && window.Progress && typeof window.Progress.pause === 'function') {
      window.Progress.pause(currentEpId, Math.floor(video.currentTime || 0), Math.floor(video.duration || 0));
    }
    // Phase 8: user-initiated pause → offer mid-roll (never pauses content itself).
    if (adsInstance && typeof adsInstance.midRoll === 'function') {
      adsInstance.midRoll().catch(function() {});
    }
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

  // ── Player control initialization (defensive) ────────────
  // Each subsystem is wrapped so a failure in one optional feature (e.g. PiP,
  // progress UI) never prevents playback or permanently marks the player as
  // initialized. playerSetupDone is set ONLY after all init succeeds.
  try {
    initProgressBar(video);
    initControlsAutoHide(wrap);
    initKeyboardShortcuts();

    // ── Phase 4: Player module bootstrap (single init order) ──
    // PlayerCore is already initialized by ensurePlayerCoreInitialized()
    // (called in initializePlayerWithSource before source attachment).
    // DO NOT re-initialize PlayerCore here — it is the SINGLE HLS owner.
    // Progress → PlayerGestures → PlayerResilience → PlayerMarkers
    // Each init() receives the PlayerCore instance/event bus rather than globals.
    // A second call tears down the previous instance (episode changes must not
    // stack listeners or HLS instances).

    // Progress.init() — already wired above via window.Progress.init()

    // PlayerGestures — single Pointer Events pipeline.
    if (window.PlayerGestures) {
      if (window.__playerGestures) { try { window.__playerGestures.destroy(); } catch(e) {} }
      window.__playerGestures = window.PlayerGestures.init({
        surface: wrap,
        controlsEl: document.querySelector('.controls-overlay'),
        onShowControls: showControls,
        onHideControls: hideControls,
        onSeek: function(delta) {
          if (delta < 0) skipBack(); else skipForward();
        },
        onTap: function() {}
      });
    }

    // PlayerResilience — the only recovery ladder.
    if (window.PlayerResilience) {
      if (window.__playerResilience) { try { window.__playerResilience.reset(); } catch(e) {} }
      window.__playerResilience = window.PlayerResilience.init({
        video: video,
        hls: window.__hls || null,
        getCurrentTime: function() { return video.currentTime; },
        getEpisodeId: function() { return currentEpId; },
        resolveStreamUrl: function(episodeId, force) {
          // Prompt 2: The old /api/stream/resolve route does not exist.
          // Re-authorize to mint a fresh token, then return the current
          // stream URL with the token appended. If authorization fails,
          // return null so the resilience ladder can escalate.
          var base = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : '';
          if (episodeId) {
            authorizeStream(episodeId).then(function() {
              if (currentStreamUrl) {
                return appendStreamToken(currentStreamUrl);
              }
              return null;
            }).catch(function() {
              return null;
            });
            // Return the current URL immediately (token refresh happens async).
            return currentStreamUrl ? appendStreamToken(currentStreamUrl) : null;
          }
          return currentStreamUrl ? appendStreamToken(currentStreamUrl) : null;
        },
        onReconnect: function(level) {
          setLoadingStatus(level >= 4 ? 'Playback failed' : 'Reconnecting…');
        },
        onErrorCard: function() {
          showWatchError('Playback could not be recovered. Please try again.');
        },
        logEscalation: function(payload) {
          apiFetch('/api/reports/stream-escalation', {
            method: 'POST',
            body: JSON.stringify(payload)
          }).catch(function() {});
        }
      });
    }

    // PlayerMarkers — skip intro/outro from /api/watch/markers/:episodeId.
    if (window.PlayerMarkers && currentEpId) {
      if (window.__playerMarkers) { try { window.__playerMarkers.refresh(); } catch(e) {} }
      window.__playerMarkers = window.PlayerMarkers.init({
        video: video,
        episodeId: currentEpId,
        getToken: function() { return State.token || localStorage.getItem('token') || ''; },
        skipButtonEl: skipBtn,
        onSkip: function(marker) { watchLog('skip marker used', { kind: marker.kind }); },
        skipIntroAuto: !!(playerPrefs && playerPrefs.autoSkipIntro)
      });
    }

    // Restore saved playback speed / volume
    video.playbackRate = speedValue;
    updateSpeedUI();
    updateVolumeIcon();

    // fmtTime displays
    updateTimeDisplay(video);
  } catch (controlErr) {
    console.error('[WATCH] Player control init error (non-fatal)', controlErr);
  }

  // Mark as initialized only after the control systems are set up.
  playerSetupDone = true;

  // ── AUTOPLAY with muted fallback ──────────────────────────
  // Attempt unmuted autoplay first. If the browser's autoplay policy blocks
  // it (NotAllowedError), retry MUTED (which is generally allowed). If muted
  // autoplay also fails, show a "Tap to Play" button. This is NEVER treated
  // as a stream failure and NEVER shows "Unable to Play".
  window.__aniStrimPlaybackDebug.playAttempted = true;
  const attemptPlay = function(preserveUnmuted) {
    return video.play().then(function() {
      window.__aniStrimPlaybackDebug.playSucceeded = true;
      setPlayerState(PLAYER_STATES.PLAYING, { source: 'autoplay' });
    }).catch(function(err) {
      window.__aniStrimPlaybackDebug.playError = err.name || err.message;
      console.warn('[WATCH PLAYER] autoplay blocked or playback failed', {
        name: err.name,
        message: err.message,
        code: video.error?.code,
        readyState: video.readyState,
        networkState: video.networkState,
        currentSrc: video.currentSrc
      });
      // If unmuted was blocked, try muted (autoplay policies allow muted).
      if (preserveUnmuted && !video.muted) {
        video.muted = true;
        video.volume = 0;
        return attemptPlay(false);
      }
      // Muted autoplay also blocked (or a real error) — show Play button.
      wrap.classList.add('paused');
      setPlayIcon(false);
      setPlayerState(PLAYER_STATES.AUTOPLAY_BLOCKED, {
        reason: err.name || err.message,
        readyState: video.readyState
      });
      // Hide the loading overlay — the player is READY, just not playing.
      const loadingOverlay = document.getElementById('loading-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      // Ensure the controls (incl. the Play button) are visible.
      showControls();
    });
  };
  attemptPlay(true);
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
  const autoHideDelay = isTouchDevice() ? 5000 : 4000;
  controlsTimer = setTimeout(hideControls, autoHideDelay);
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
  // Never hide while still in a loading/buffering/preparing state.
  if (playerState === PLAYER_STATES.INITIALIZING ||
      playerState === PLAYER_STATES.STREAM_LOADING ||
      playerState === PLAYER_STATES.PLAYER_LOADING ||
      playerState === PLAYER_STATES.BUFFERING ||
      playerState === PLAYER_STATES.AUTOPLAY_BLOCKED) return;
  const endOverlay = document.getElementById('next-episode-overlay');
  const resumeOverlay = document.getElementById('resume-overlay');
  if (endOverlay && endOverlay.style.display === 'flex') return;
  if (resumeOverlay && resumeOverlay.style.display === 'flex') return;
  wrap.classList.remove('controls-visible', 'controls-visible-mobile');
}

function initControlsAutoHide(wrap) {
  wrap.addEventListener('mousemove', showControls);
  wrap.addEventListener('mouseenter', showControls);
  // Keyboard interaction reveals controls
  document.addEventListener('keydown', function() {
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') showControls();
  });
  // Re-show controls on fullscreen change — never leave them stuck hidden.
  document.addEventListener('fullscreenchange', showControls);
  document.addEventListener('webkitfullscreenchange', showControls);
  document.addEventListener('mozfullscreenchange', showControls);
  document.addEventListener('MSFullscreenChange', showControls);
  // Re-show controls when the window regains focus.
  window.addEventListener('focus', showControls);
  wrap.addEventListener('dblclick', showControls);
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

  // Prompt 6: gate on the server-emitted `locked` field — NEVER is_premium,
  // NEVER localStorage, NEVER a JWT claim. Frontend gating is cosmetic only;
  // the server is the boundary.
  if (episodeIsLocked(ep)) {
    showPremiumGate(ep.title || ('Episode ' + epNumber), ep.effectiveTier, ep.availableAt, ep.accessState);
    return;
  }

  // Update current episode state
  currentEp = epNumber;
  currentEpId = ep.id || null;

  // FIX A: stop auto-save for the old episode so episodeId is never stale.
  if (window.Progress && typeof window.Progress.stopAutoSave === 'function') {
    window.Progress.stopAutoSave();
  }

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

  // Use the canonical stream resolution + player initialization path.
  // This ensures episode navigation uses the SAME pipeline as initial load
  // and Change Server — no divergent playback logic.
  try {
    if (ep.video_url) {
      // Direct video URL — attach directly.
      await initializePlayerWithSource(video, { url: ep.video_url, quality: 'auto' }, {
        provider: 'direct',
        sources: [{ url: ep.video_url, quality: 'auto' }],
        subtitles: []
      });
    } else {
      // Resolve stream from backend via the canonical path.
      const rawAnimeTitle = currentAnime && currentAnime.title ? currentAnime.title : currentAnimeTitle;
      await resolveAndPlayStream(rawAnimeTitle, epNumber, video);
    }
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
      // PlayerMarkers re-initializes on setupPlayer() with the new episodeId
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
    // Prompt 6: gate on the server-emitted `locked` / `accessState` fields —
    // NEVER is_premium, NEVER localStorage, NEVER a JWT claim.
    var isLocked = episodeIsLocked(e);
    var displayNum = e.number || e.episode_number;
    var epTitle = e.title && e.title !== 'undefined' ? e.title : 'Episode ' + displayNum;
    var thumbSrc = e.thumbnail_url && e.thumbnail_url.trim() && e.thumbnail_url !== 'undefined' ? e.thumbnail_url : makeFallbackImg(epTitle);
    var lockIcon = isLocked ? '🔒' : '▶';
    var premiumTag = e.effectiveTier === 'premium' ? '<span class="ep-premium-badge">👑</span>' : '';
    var accessLabel = episodeAccessLabel(e);
    var accessClass = episodeAccessClass(e);
    var accessBadge = isLocked ? '<span class="ep-access-badge ' + accessClass + '">' + window._escapeHTML(accessLabel) + '</span>' : '';

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
                ${accessBadge}
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

  // FIX 2 (Phase 3): canonical field names are positionSec/durationSec
  const pos = progressData.positionSec ?? progressData.progressSeconds ?? 0;
  const dur = progressData.durationSec ?? progressData.totalDurationSeconds ?? 0;

  const pct = dur > 0
    ? Math.round((pos / dur) * 100)
    : 0;

  document.getElementById('resume-progress-pct').textContent = pct + '%';
  document.getElementById('resume-saved-time').textContent =
    ' at ' + fmtTime(pos);

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
// FIX 2 (Phase 3): loadProgress must call GET /api/watch/progress/:episodeId
// (the real route) with the episode's database ID, not the legacy
// /:animeId/:episodeNumber path which 404s.
async function loadProgress(video, animeId, episodeNumber) {
  if (!currentEpId) return;
  try {
    var { data } = await apiFetch('/api/watch/progress/' + currentEpId, { timeout: API_TIMEOUT_MS });
    if (data && data.positionSec > 10) {
      // Near-end detection: if 90%+ watched, offer Resume/Restart
      if (data.durationSec > 0 && data.positionSec >= data.durationSec * 0.9) {
        showResumePrompt(data);
      }
      video.addEventListener('loadedmetadata', function() {
        if (data.positionSec < (video.duration || Infinity)) {
          video.currentTime = data.positionSec;
        }
        // If near-end and user didn't choose, just resume from saved position
      }, { once: true });
    }
  } catch(e) {}
}

// FIX 1 + FIX 3 (Phase 3): saveProgress must call PUT /api/watch/progress
// with positionSec/durationSec (the canonical field names). The legacy
// POST /api/watchlist/progress alias is kept server-side for compatibility
// but the frontend now uses the canonical route directly.
// FIX A: delegate to window.Progress.save() when available (offline queue,
// visibility/pagehide flush, online-reconnect flush). Keep the inline PUT as
// the fallback when progress.js is not loaded.
async function saveProgress(epId, sec, completed, durationSec) {
  if (window.Progress && typeof window.Progress.save === 'function') {
    window.Progress.save({
      episodeId: epId,
      positionSec: sec,
      durationSec: durationSec || 0,
      event: completed ? 'ended' : 'heartbeat'
    });
    return;
  }
  try {
    await apiFetch('/api/watch/progress', {
      method: 'PUT',
      body: JSON.stringify({
        episodeId: epId,
        positionSec: sec,
        durationSec: durationSec || 0,
        event: completed ? 'ended' : 'heartbeat'
      })
    });
  } catch(e) {}
}
window.saveProgress = saveProgress;

// ════════════════════════════════════════════════════════════
//  SKIP INTRO / OUTRO  (preserved backend behaviour)
// ════════════════════════════════════════════════════════════
function skipIntro() {
  var video = document.getElementById('animePlayer');
  if (introRange) video.currentTime = introRange.end;
  document.getElementById('skip-intro-btn').style.display = 'none';
}
window.skipIntro = skipIntro;

function skipOutro() {
  var video = document.getElementById('animePlayer');
  if (outroRange) video.currentTime = outroRange.end;
  document.getElementById('skip-outro-btn').style.display = 'none';
  // Phase 8: outro marker handler → offer mid-roll (never pauses content itself).
  if (adsInstance && typeof adsInstance.midRoll === 'function') {
    adsInstance.midRoll().catch(function() {});
  }
}
window.skipOutro = skipOutro;

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

      // Prompt 2: Authorize the next episode before playing pre-resolved sources.
      if (currentEpId) {
        try {
          await authorizeStream(currentEpId);
        } catch (err) {
          if (err && err.premiumRequired) throw err;
          console.warn('[WATCH] Next-episode authorization failed (non-fatal):', err.message);
        }
      }

      // Load the first source
      const API_BASE_URL = window.getApiBaseUrl();
      const sources = window.__nextEpisodeSources.sources.sources || [];
      let sourceUrl = null;
      if (sources.length > 0) {
        const src = sources[0];
        // Prompt 2 + FIX 3: prefer the concrete authorized proxy URL.
        sourceUrl = preferAuthorizedProxyUrl(src.url.startsWith('http') ? src.url : API_BASE_URL + src.url);
        currentStreamSources = sources.map(s => ({
          ...s,
          url: preferAuthorizedProxyUrl(s.url.startsWith('http') ? s.url : API_BASE_URL + s.url)
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

      // Ensure PlayerCore is initialized before source attachment.
      ensurePlayerCoreInitialized(video);

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
//  AUTOPLAY NEXT + SKIP INTRO  (Phase 4 — PlayerMarkers handles this)
// ════════════════════════════════════════════════════════════
// The legacy loadSkipTimes/loadSkipTimesForNext and initTouchControls are
// removed — PlayerMarkers fetches /api/watch/markers/:episodeId and
// PlayerGestures owns the single Pointer Events pipeline.

// ════════════════════════════════════════════════════════════
//  EPISODE SIDEBAR COMPATIBILITY
// ════════════════════════════════════════════════════════════
function renderMoreEpisodes(episodes, animeId) {
  renderEpisodeSidebar(episodes, animeId);
}

// FIXED: renamed local helper to watchFallbackImg to avoid infinite recursion.
// Previously it called window.makeFallbackImg which (due to browser
// global-function naming) pointed back to this same local function, causing
// "Maximum call stack size exceeded" and crashing thumbnail rendering.
function watchFallbackImg(title) {
  // Prefer the shared namespaced helper from config.js (no recursion).
  if (window.AniStrimShared && typeof window.AniStrimShared.makeFallbackImg === 'function') {
    return window.AniStrimShared.makeFallbackImg(title);
  }
  // Fallback local implementation (only used if shared helper missing).
  var hash = 0;
  for (var i = 0; i < (title || '').length; i++) hash = (title || '').charCodeAt(i) + ((hash << 5) - hash);
  var color = '#' + (hash & 0x00FFFFFF).toString(16).padStart(6, '0');
  return 'https://ui-avatars.com/api/?background=' + color.substring(1) + '&color=ffffff&bold=true&name=' + encodeURIComponent(title || 'Anime');
}

function makeFallbackImg(title) {
  return watchFallbackImg(title);
}

function cardImgError(img, title) {
  if (img && title) {
    img.src = watchFallbackImg(title);
  }
}

// ════════════════════════════════════════════════════════════
//  PREMIUM GATE
// ════════════════════════════════════════════════════════════
// Shown BEFORE any stream resolution when the episode requires Premium and
// the user is not authorized. The backend enforces this server-side too
// (returns 403), but we gate on the frontend first for a better UX and to
// avoid wasting a stream request.
function showPremiumGate(epTitle, requiredTier, availableAt, accessState) {
  watchLog('premium gate shown', { episode: epTitle, requiredTier, availableAt, accessState });
  setPlayerState(PLAYER_STATES.PREMIUM_REQUIRED, { episode: epTitle, requiredTier, availableAt, accessState });
  const loadingOverlay = document.getElementById('loading-overlay');
  const premiumOverlay = document.getElementById('premium-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const resumeOverlay = document.getElementById('resume-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'none';
  if (errorOverlay) errorOverlay.style.display = 'none';
  if (resumeOverlay) resumeOverlay.style.display = 'none';
  if (premiumOverlay) {
    premiumOverlay.style.display = 'flex';
    premiumOverlay.style.opacity = '1';
    premiumOverlay.style.visibility = 'visible';
  }

  const titleEl = document.getElementById('premium-gate-title');
  if (titleEl) titleEl.textContent = 'Premium Episode';
  const msgEl = document.getElementById('premium-gate-message');
  if (msgEl) {
    // Prompt 6: distinguish the access states the server emitted.
    if (accessState === 'subscription_expired') {
      msgEl.textContent = 'Your subscription has expired. Renew to keep watching premium episodes.';
    } else if (accessState === 'scheduled' && availableAt) {
      const d = new Date(availableAt);
      if (!isNaN(d.getTime())) {
        msgEl.textContent = 'This episode becomes free on ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + '.';
      } else {
        msgEl.textContent = 'This episode is scheduled for a future free release.';
      }
    } else {
      msgEl.textContent = State.isLoggedIn
        ? 'This episode requires a Premium subscription. Upgrade to watch.'
        : 'This episode requires a Premium subscription. Sign in and upgrade to watch.';
    }
  }

  const upgradeBtn = document.getElementById('premium-gate-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.onclick = function() {
      if (State.isLoggedIn) {
        // Remember where to return after upgrade
        try { localStorage.setItem('anistrim_redirect_after_auth', window.location.href); } catch(e) {}
        window.location.href = 'upgrade.html';
      } else {
        // Not logged in — go to login, then return to this episode
        try { localStorage.setItem('anistrim_redirect_after_auth', window.location.href); } catch(e) {}
        window.location.href = 'login.html';
      }
    };
  }
  const backBtn = document.getElementById('premium-gate-back-btn');
  if (backBtn) {
    backBtn.onclick = function() { window.history.back(); };
  }
}
window.showPremiumGate = showPremiumGate;

// ════════════════════════════════════════════════════════════
//  DEVICE LIMIT GATE (FIX 8 — plans.max_devices enforcement)
// ════════════════════════════════════════════════════════════
// Shown when POST /api/stream/authorize returns 403 DEVICE_LIMIT_REACHED. The
// user's active sessions (devices) exceed their plan's max_devices, so new
// playback is blocked. It is a DISTINCT player state (DEVICE_LIMIT_REQUIRED)
// with the active-device list so the UI is not a generic failure.
function showDeviceLimitGate(data) {
  const info = data || {};
  const max = info.maxDevices;
  const active = info.activeDevices;
  const devices = Array.isArray(info.devices) ? info.devices : [];
  watchLog('device limit gate shown', { maxDevices: max, activeDevices: active, deviceCount: devices.length });
  setPlayerState(PLAYER_STATES.DEVICE_LIMIT_REQUIRED, { maxDevices: max, activeDevices: active });

  const loadingOverlay = document.getElementById('loading-overlay');
  const premiumOverlay = document.getElementById('premium-overlay');
  const errorOverlay = document.getElementById('error-overlay');
  const deviceOverlay = document.getElementById('device-limit-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'none';
  if (premiumOverlay) premiumOverlay.style.display = 'none';
  if (errorOverlay) errorOverlay.style.display = 'none';
  if (deviceOverlay) {
    deviceOverlay.style.display = 'flex';
    deviceOverlay.style.opacity = '1';
    deviceOverlay.style.visibility = 'visible';
  }

  const titleEl = document.getElementById('device-limit-title');
  if (titleEl) titleEl.textContent = 'Too many devices streaming';
  const msgEl = document.getElementById('device-limit-message');
  if (msgEl) {
    msgEl.textContent = 'Your plan allows ' + (max || 'a limited number of') + ' active device' + ((max === 1) ? '' : 's') + ' at a time. You currently have ' + (active || 0) + ' device' + ((active === 1) ? '' : 's') + ' streaming. Remove a device to continue watching here.';
  }

  // Render the active device list.
  const listEl = document.getElementById('device-limit-list');
  if (listEl) {
    listEl.innerHTML = '';
    if (devices.length) {
      devices.forEach(function(d) {
        const li = document.createElement('li');
        const platform = d && d.platform ? d.platform : 'device';
        const name = (d && d.device_name) ? d.device_name : (platform.charAt(0).toUpperCase() + platform.slice(1));
        const lastSeen = d && d.last_seen_at ? (new Date(d.last_seen_at)).toLocaleString() : 'Active now';
        const dot = document.createElement('span');
        dot.className = 'device-limit-dot';
        li.appendChild(dot);
        li.appendChild(document.createTextNode(' ' + name + ' — ' + lastSeen));
        listEl.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'Another device is currently streaming on this account.';
      listEl.appendChild(li);
    }
  }

  const manageBtn = document.getElementById('device-limit-manage-btn');
  if (manageBtn) {
    manageBtn.onclick = function() {
      // Remember where to return after managing devices.
      try { localStorage.setItem('anistrim_redirect_after_auth', window.location.href); } catch(e) {}
      window.location.href = 'profile.html';
    };
  }
  const backBtn = document.getElementById('device-limit-back-btn');
  if (backBtn) {
    backBtn.onclick = function() { window.history.back(); };
  }
}
window.showDeviceLimitGate = showDeviceLimitGate;

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

  if (retryBtn) {
    retryBtn.onclick = () => {
      const errorOverlay = document.getElementById('error-overlay');
      if (errorOverlay) errorOverlay.style.display = 'none';
      const loadingOverlay = document.getElementById('loading-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      setLoadingStatus('Reconnecting…');
      if (window.__playerResilience && typeof window.__playerResilience.restart === 'function') {
        window.__playerResilience.restart();
      } else {
        location.reload();
      }
    };
  }
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
// Delegates ALL HLS lifecycle to PlayerCore (the SINGLE HLS owner).
// watch.js NEVER creates `new window.Hls()` — PlayerCore owns hls.js.
// Phase 8: Before attaching ANY source, resolve the pre-roll ad. It NEVER
// blocks content — if it times out, fails, or no ad is configured, content
// attaches anyway.
function attachStreamSource(video, source) {
  console.log('[WATCH] attachStreamSource', {
    hasToken: typeof source === 'string' && !!streamAuth && !!streamAuth.token,
    isProxy: typeof source === 'string' && /\/api\/stream-proxy\//.test(source),
    url: typeof source === 'string' ? String(source).slice(0, 120) : String(source),
  });

  return Promise.resolve().then(function() {
    // Resolve pre-roll BEFORE setting the source. Never throws.
    if (adsInstance && typeof adsInstance.preRoll === 'function') {
      return adsInstance.preRoll().then(function(r) {
        currentPreRollAd = (r && r.served) ? r.ad : null;
        return currentPreRollAd;
      }).catch(function() {
        currentPreRollAd = null;
        return null;
      });
    }
    return null;
  }).then(function(servedAd) {
    // If an ad was actually served, show the skip/click surface.
    if (servedAd && adsInstance) {
      showPreRollAd(servedAd, adsInstance);
    }

    var isHlsStream = /\.m3u8(?:$|\?)/i.test(source);
    var isProxyUrl = /\/api\/stream-proxy\//.test(source);
    var isDirectMedia = /\/index\.(mp4|webm|ogg)(?:$|\?)|\.(mp4|webm|ogg)(?:$|\?)/i.test(source);
    return new Promise(function(resolve, reject) {
      var timeout = setTimeout(function() {
        reject(new Error('Timed out loading video source.'));
      }, SOURCE_ATTACH_TIMEOUT_MS);

      function cleanup() {
        clearTimeout(timeout);
      }

      // ── HLS path: delegate to PlayerCore (the SINGLE HLS owner) ──
      // For a `.m3u8` URL OR any proxy URL that COULD be HLS (extension-less
      // AnimeHeaven manifests), delegate to PlayerCore. PlayerCore uses
      // hls.js when native HLS is absent; hls.js auto-detects HLS by the
      // returned Content-Type even when the URL has no `.m3u8` hint.
      // This is the FIX for the 0:00 stall where an extension-less proxy URL
      // was wrongly treated as MP4 → video.src → MEDIA_ERR_SRC_NOT_SUPPORTED.
      // An MP4-suffixed proxy URL (/index.mp4) is a DIRECT media target — play
      // it natively, never route it through hls.js (hls.js would fetch the MP4
      // bytes and fail MANIFEST_PARSE_ERROR, stalling the native recovery).
      if ((isHlsStream || (isProxyUrl && !isDirectMedia)) && window.Hls && window.Hls.isSupported()) {
        if (!window.__playerCore) {
          reject(new Error('PlayerCore not initialized.'));
          return;
        }
        try {
          window.__playerCore.loadSource(source);
          cleanup();
          watchLog('loadedmetadata', { hls: true, via: 'PlayerCore', proxy: isProxyUrl });
          // PlayerCore's onManifestParsed (HLS) catches manifest loads. For a
          // true MP4 behind the proxy, hls.js will fail with MANIFEST_PARSE_ERROR
          // and the fallback below re-attaches as MP4.
          resolve();
        } catch (e) {
          cleanup();
          reject(e);
        }
        return;
      }

      // ── MP4 / Direct source (non-proxy, non-HLS) ─────────────
      console.log('[WATCH PLAYER] assigning source:', {
        provider: currentProvider || 'unknown',
        sourceType: 'mp4',
        mimeType: 'video/mp4',
        url: source
      });

      if (window.__aniStrimPlaybackDebug) {
        window.__aniStrimPlaybackDebug.sourceAttached = true;
        window.__aniStrimPlaybackDebug.selectedSource = source;
      }

      var resolved = false;
      function onReady() {
        if (resolved) return;
        resolved = true;
        cleanup();
        watchLog('loadedmetadata', { hls: false });
        currentQualityIndex = -1;
        refreshHlsQualityOptions();
        refreshAudioTracks();
        populateAudioOptions();
        refreshSubtitleTracks();
        populateSubtitleOptions();
        resolve();
      }

      ['canplay', 'loadeddata', 'loadedmetadata'].forEach(function(evt) {
        video.addEventListener(evt, onReady, { once: true });
      });

      video.addEventListener('error', function() {
        if (resolved) return;
        resolved = true;
        cleanup();
        console.error('[WATCH PLAYER] video error:', {
          code: video.error ? video.error.code : null,
          message: video.error ? video.error.message : null,
          currentSrc: video.currentSrc
        });
        reject(new Error('Video source could not be loaded.'));
      }, { once: true });

      var fallbackResolve = setTimeout(function() {
        if (resolved) return;
        resolved = true;
        cleanup();
        console.warn('[WATCH PLAYER] No media event within 10s — resolving anyway');
        resolve();
      }, 10000);

      var originalCleanup = cleanup;
      cleanup = function() {
        clearTimeout(timeout);
        clearTimeout(fallbackResolve);
        originalCleanup();
      };

      video.src = source;
      video.load();
    });
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
  // FIX A: stop auto-save before leaving so no stale episodeId is saved.
  if (window.Progress && typeof window.Progress.stopAutoSave === 'function') {
    window.Progress.stopAutoSave();
  }
  // Save progress before leaving (FIX 2 Phase 3: use PUT + canonical fields)
  var video = document.getElementById('animePlayer');
  if (video && currentEpId) {
    var progressSec = Math.floor(video.currentTime || 0);
    var durationSec = Math.floor(video.duration || 0);
    if (progressSec > 0 && durationSec > 0) {
      // Fire-and-forget save via the canonical PUT route
      apiFetch('/api/watch/progress', {
        method: 'PUT',
        body: JSON.stringify({
          episodeId: currentEpId,
          positionSec: progressSec,
          durationSec: durationSec,
          event: 'exit'
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
console.log('[WATCH DEBUG] Registering DOMContentLoaded listener for loadWatch');
document.addEventListener('DOMContentLoaded', loadWatch);
console.log('[WATCH DEBUG] DOMContentLoaded listener registered');


