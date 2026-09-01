// AdminDashboard/js/analytics.js — Unified analytics section.
// Uses existing /api/admin/dashboard/* endpoints to render overview cards,
// platform breakdown, recent activity feed, and stream cache metrics.

(function () {
  'use strict';

  let _currentPlatform = 'all';
  let _currentRange = 30;

  function initializeAnalyticsSection() {
    console.log('[Analytics] Initializing...');

    document.getElementById('analytics-platform')?.addEventListener('change', (e) => {
      _currentPlatform = e.target.value;
      loadAnalytics();
    });

    document.getElementById('analytics-range')?.addEventListener('change', (e) => {
      _currentRange = parseInt(e.target.value);
      loadAnalytics();
    });

    loadAnalytics();
  }

  async function loadAnalytics() {
    try {
      const [overviewResp, activityResp, healthMetricsResp] = await Promise.all([
        window.apiRequest('/api/admin/dashboard/overview'),
        window.apiRequest('/api/admin/dashboard/activity/recent'),
        window.apiRequest('/api/admin/dashboard/health/metrics?hours=24'),
      ]);

      renderOverview(overviewResp);
      // unwrapAdminEnvelope returns { items, rows, pagination } for array payloads.
      const activityList = (activityResp && activityResp.items) || (activityResp && activityResp.rows) || activityResp;
      renderActivity(activityList);
      renderStreamCache(healthMetricsResp);
    } catch (err) {
      console.error('[Analytics] Failed to load:', err);
      const el = document.getElementById('analytics-overview');
      if (el) el.innerHTML = '<div class="empty-state"><p>Failed to load analytics data.</p></div>';
    }
  }

  function renderOverview(data) {
    if (!data) return;

    const overview = data.overview || data;
    const users = overview.users || {};
    const content = overview.content || {};

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val != null ? String(val) : '0';
    };

    setEl('analytics-total-users', users.total || 0);
    setEl('analytics-active-today', users.activeToday || 0);
    setEl('analytics-total-views', window._formatNumber ? window._formatNumber(content.totalViews || 0) : (content.totalViews || 0));
    // Searches not available from dashboard overview, show 0
    setEl('analytics-total-searches', 0);

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
      return `<div class="list-item"><span>${icon} ${b.platform.charAt(0).toUpperCase() + b.platform.slice(1)}</span><span class="list-value">${window._formatNumber ? window._formatNumber(b.views) : b.views} views</span></div>`;
    }).join('');
  }

  function renderActivity(items) {
    const container = document.getElementById('analytics-activity');
    if (!container) return;

    if (!items || !Array.isArray(items) || !items.length) {
      container.innerHTML = '<div class="empty-state"><p>No recent activity.</p></div>';
      return;
    }

    const iconMap = {
      anime: '📺', user: '👤', payment: '💰', admin_action: '⚙️',
    };

    container.innerHTML = items.slice(0, 20).map(a => {
      const icon = iconMap[a.type] || '📌';
      const user = window._escapeHTML(a.label || 'Anonymous');
      const detail = a.detail ? ` — ${window._escapeHTML(a.detail)}` : '';
      const time = window._timeAgo ? window._timeAgo(a.created_at) : new Date(a.created_at).toLocaleString();
      return `<div class="list-item"><span>${icon} <strong>${user}</strong>${detail}</span><span class="list-value">${time}</span></div>`;
    }).join('');
  }

  function renderStreamCache(data) {
    if (!data) return;

    const sc = data.streamCache || data;

    function setEl(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value == null ? '—' : String(value);
    }

    setEl('sc-redis-hits', window._formatNumber ? window._formatNumber(sc.redisHits || 0) : (sc.redisHits || 0));
    setEl('sc-mysql-hits', window._formatNumber ? window._formatNumber(sc.mysqlHits || 0) : (sc.mysqlHits || 0));
    setEl('sc-cache-misses', window._formatNumber ? window._formatNumber(sc.cacheMisses || 0) : (sc.cacheMisses || 0));
    setEl('sc-active-sources', window._formatNumber ? window._formatNumber(sc.activeCachedSources || 0) : (sc.activeCachedSources || 0));

    setEl('sc-animeheaven', window._formatNumber ? window._formatNumber(sc.animeHeavenCalls || 0) : (sc.animeHeavenCalls || 0));
    setEl('sc-consumet', window._formatNumber ? window._formatNumber(sc.consumetCalls || 0) : (sc.consumetCalls || 0));
    setEl('sc-resolvers', window._formatNumber ? window._formatNumber(sc.resolverCalls || 0) : (sc.resolverCalls || 0));
    setEl('sc-avg-lifetime', sc.averageSourceLifetimeMs
      ? Math.round(sc.averageSourceLifetimeMs / 60000) + 'm'
      : '—');

    setEl('sc-verify-ok', window._formatNumber ? window._formatNumber(sc.verificationSuccesses || 0) : (sc.verificationSuccesses || 0));
    setEl('sc-verify-fail', window._formatNumber ? window._formatNumber(sc.verificationFailures || 0) : (sc.verificationFailures || 0));
    setEl('sc-known-expiry', window._formatNumber ? window._formatNumber(sc.knownExpirySources || 0) : (sc.knownExpirySources || 0));
    setEl('sc-unknown-expiry', window._formatNumber ? window._formatNumber(sc.unknownExpirySources || 0) : (sc.unknownExpirySources || 0));
  }

  window.initializeAnalyticsSection = initializeAnalyticsSection;
})();
