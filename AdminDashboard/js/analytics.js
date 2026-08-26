// AdminDashboard/js/analytics.js — Unified cross-platform analytics section.
// Loads data from /api/admin/analytics/* endpoints and renders overview cards,
// platform breakdown, and recent activity feed.

(function () {
  'use strict';

  let _currentPlatform = 'all';
  let _currentRange = 30;

  function initializeAnalyticsSection() {
    console.log('[Analytics] Initializing...');

    // Platform filter
    document.getElementById('analytics-platform')?.addEventListener('change', (e) => {
      _currentPlatform = e.target.value;
      loadAnalytics();
    });

    // Date range filter
    document.getElementById('analytics-range')?.addEventListener('change', (e) => {
      _currentRange = parseInt(e.target.value);
      loadAnalytics();
    });

    loadAnalytics();
  }

  async function loadAnalytics() {
    try {
      const [overview, activity] = await Promise.all([
        window.apiRequest(`/api/admin/analytics/overview?platform=${_currentPlatform}&days=${_currentRange}`),
        window.apiRequest(`/api/admin/analytics/activity?platform=${_currentPlatform}&limit=20`),
      ]);

      renderOverview(overview);
      renderActivity(activity);
    } catch (err) {
      console.error('[Analytics] Failed to load:', err);
      const el = document.getElementById('analytics-overview');
      if (el) el.innerHTML = '<div class="empty-state"><p>Failed to load analytics data.</p></div>';
    }
  }

  function renderOverview(data) {
    if (!data) return;

    const totalUsers = document.getElementById('analytics-total-users');
    if (totalUsers) totalUsers.textContent = (data.users && data.users.total) || '0';

    const activeToday = document.getElementById('analytics-active-today');
    if (activeToday) activeToday.textContent = (data.users && data.users.activeToday) || '0';

    const totalViews = document.getElementById('analytics-total-views');
    if (totalViews) totalViews.textContent = window._formatNumber((data.views && data.views.anime) || 0);

    const totalSearches = document.getElementById('analytics-total-searches');
    if (totalSearches) totalSearches.textContent = window._formatNumber((data.engagement && data.engagement.searches) || 0);

    // Platform breakdown
    const container = document.getElementById('analytics-platform-breakdown');
    if (!container) return;

    const breakdown = data.platformBreakdown || [];
    if (!breakdown.length) {
      container.innerHTML = '<div class="empty-state"><p>No platform data yet. Analytics will appear as users interact with the platform.</p></div>';
      return;
    }

    container.innerHTML = breakdown.map(b => {
      const icon = b.platform === 'web' ? '🌐' : b.platform === 'mobile' ? '📱' : b.platform === 'desktop' ? '💻' : '❓';
      return `<div class="list-item"><span>${icon} ${b.platform.charAt(0).toUpperCase() + b.platform.slice(1)}</span><span class="list-value">${window._formatNumber(b.views)} views</span></div>`;
    }).join('');
  }

  function renderActivity(items) {
    const container = document.getElementById('analytics-activity');
    if (!container) return;

    if (!items || !items.length) {
      container.innerHTML = '<div class="empty-state"><p>No recent activity.</p></div>';
      return;
    }

    const iconMap = {
      anime_view: '👁️', episode_view: '▶️', watch_start: '🎬', watch_complete: '✅',
      search: '🔍', login: '🔑', google_login: '🔑', favorite_add: '❤️',
      download_start: '⬇️', stream_start: '📺', stream_error: '⚠️',
    };

    container.innerHTML = items.slice(0, 20).map(a => {
      const icon = iconMap[a.event] || '📌';
      const platform = a.platform ? ` (${a.platform})` : '';
      const anime = a.anime ? ` — ${window._escapeHTML(a.anime)}` : '';
      const episode = a.episode ? ` — ${window._escapeHTML(a.episode)}` : '';
      const user = window._escapeHTML(a.user || 'Anonymous');
      const time = window._timeAgo ? window._timeAgo(a.timestamp) : new Date(a.timestamp).toLocaleString();
      return `<div class="list-item"><span>${icon} <strong>${user}</strong> ${a.event}${platform}${anime}${episode}</span><span class="list-value">${time}</span></div>`;
    }).join('');
  }

  window.initializeAnalyticsSection = initializeAnalyticsSection;
})();
