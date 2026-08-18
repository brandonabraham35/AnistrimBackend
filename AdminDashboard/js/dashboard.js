document.addEventListener('DOMContentLoaded', () => {
  const initializedSections = new Set();

  // Ensure admin token exists, otherwise redirect to login.
  if (!localStorage.getItem('admin_token')) {
    window.location.replace('index.html');
    return;
  }

  const sections = document.querySelectorAll('.content-section');
  const navLinks = document.querySelectorAll('.sidebar .nav-links a:not(.logout-btn)');

  // shared.js provides _escapeHTML, showToast, _confirm, ModalManager, SkeletonLoader,
  // EmptyState, ErrorState, Badge, DataTable, etc. globally.
  // No fallbacks needed — shared.js is loaded before dashboard.js in dashboard.html.

  // Simple helper to set text content on elements
  const setText = (selector, value, fallback = '0') => {
    const el = document.querySelector(selector);
    if (el) el.textContent = value || fallback;
  };

  // --- SPA Routing ---
  function showSection(targetId) {
    const effectiveTargetId = document.getElementById(targetId) ? targetId : 'dashboard';

    sections.forEach(section => {
      section.classList.toggle('active', section.id === effectiveTargetId);
    });

    navLinks.forEach(link => {
      const linkTargetId = (link.dataset.section || (link.href && link.href.split('#')[1]));
      link.classList.toggle('active', linkTargetId === effectiveTargetId);
    });

    if (history.pushState) {
      if (window.location.hash !== `#${effectiveTargetId}`) {
        history.pushState(null, null, `#${effectiveTargetId}`);
      }
    }

    // Initialize section-specific JS module if it hasn't been already
    if (!initializedSections.has(effectiveTargetId)) {
      switch (effectiveTargetId) {
        case 'anime':    if (window.initializeAnimeSection)    window.initializeAnimeSection(); break;
        case 'users':    if (window.initializeUsersSection)    window.initializeUsersSection(); break;
        case 'episodes': if (window.initializeEpisodesSection) window.initializeEpisodesSection(); break;
        case 'genres':   if (window.initializeGenresSection)   window.initializeGenresSection(); break;
        case 'payments': if (window.initializePaymentsSection) window.initializePaymentsSection(); break;
        case 'ads-config': if (window.initializeAdsSection)      window.initializeAdsSection(); break;
        case 'logs':     if (window.initializeLogsSection)     window.initializeLogsSection(); break;
        case 'settings': if (window.initializeSettingsSection) window.initializeSettingsSection(); break;
      }
      initializedSections.add(effectiveTargetId);
    }
  }

  // ─── Chart.js Instance Registry ─────────────────────────────────
  let _chartInstances = {};

  function _destroyChart(id) {
    if (_chartInstances[id]) {
      _chartInstances[id].destroy();
      delete _chartInstances[id];
    }
  }

  function _createOrUpdateChart(id, config) {
    const container = document.getElementById(id);
    if (!container) return;
    const canvas = container.querySelector('canvas');
    if (!canvas) return;
    _destroyChart(id);
    try {
      const ctx = canvas.getContext('2d');
      _chartInstances[id] = new Chart(ctx, config);
    } catch (e) {
      console.warn(`[Chart] Failed to create ${id}:`, e.message);
    }
  }

  function _getChartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#a0aec0', font: { size: 10 } } },
        tooltip: { backgroundColor: '#1e293b', titleColor: '#f8fafc', bodyColor: '#cbd5e1', borderColor: '#2a2c37', borderWidth: 1 }
      },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 9 } }, grid: { color: 'rgba(42,44,55,0.3)' } },
        y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(42,44,55,0.3)' }, beginAtZero: true }
      }
    };
  }

  // ─── Load Charts ───────────────────────────────────────────────
  async function loadCharts() {
    const chartTypes = [
      { id: 'chart-daily-users', type: 'daily-users', label: 'Daily Active Users' },
      { id: 'chart-revenue', type: 'revenue', label: 'Revenue' },
      { id: 'chart-anime-growth', type: 'anime-growth', label: 'Anime Growth' },
      { id: 'chart-episode-views', type: 'episode-views', label: 'Episode Views' },
      { id: 'chart-genre-distribution', type: 'genre-distribution', label: 'Genre Distribution' },
      { id: 'chart-provider-usage', type: 'provider-usage', label: 'Provider Usage' },
    ];

    const chartPromises = chartTypes.map(async (chart) => {
      try {
        const data = await window.apiRequest(`/api/admin/dashboard/charts/${chart.type}`);
        if (!data || !data.labels || !data.values) return;

        const isPie = chart.type === 'genre-distribution' || chart.type === 'provider-usage';
        const colors = ['#dc2626', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6'];

        if (isPie) {
          _createOrUpdateChart(chart.id, {
            type: 'doughnut',
            data: {
              labels: data.labels,
              datasets: [{ data: data.values, backgroundColor: colors.slice(0, data.labels.length), borderWidth: 0 }]
            },
            options: { ..._getChartDefaults(), cutout: '60%', plugins: { ..._getChartDefaults().plugins, legend: { ..._getChartDefaults().plugins.legend, position: 'right' } } }
          });
        } else {
          _createOrUpdateChart(chart.id, {
            type: 'line',
            data: {
              labels: data.labels,
              datasets: [{
                label: chart.label, data: data.values,
                borderColor: colors[chartTypes.indexOf(chart) % colors.length],
                backgroundColor: colors[chartTypes.indexOf(chart) % colors.length] + '20',
                fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2
              }]
            },
            options: _getChartDefaults()
          });
        }
      } catch (e) {
        console.warn(`[Chart] Failed to load ${chart.type}:`, e.message);
        _destroyChart(chart.id);
      }
    });

    await Promise.all(chartPromises);
  }

  // ─── Load Ads Metrics (ad_events) ──────────────────────────────
  // Renders impressions/clicks/fails/skips/timeouts per slot per day for the
  // last 30 days, plus fill-rate = impressions / (impressions + fail + timeout).
  async function loadAdsMetrics() {
    const container = document.getElementById('chart-ads-metrics');
    if (!container) return;
    const summaryEl = document.getElementById('ads-metrics-summary');
    try {
      const data = await window.apiRequest('/api/admin/dashboard/ads-metrics');
      if (!data || !data.series || !data.series.length) {
        if (summaryEl) summaryEl.textContent = 'No ad events recorded yet.';
        return;
      }

      const colors = ['#dc2626', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
      const datasets = [];
      data.series.forEach((s, i) => {
        const color = colors[i % colors.length];
        datasets.push({
          label: `${s.slot} · impressions`,
          data: s.perDay.map(d => d.impressions),
          borderColor: color,
          backgroundColor: color + '20',
          fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2,
          yAxisID: 'y',
        });
        datasets.push({
          label: `${s.slot} · fill-rate %`,
          data: s.perDay.map(d => d.fillRate),
          borderColor: color,
          borderDash: [4, 4],
          backgroundColor: 'transparent',
          fill: false, tension: 0.3, pointRadius: 2, borderWidth: 1,
          yAxisID: 'y1',
        });
      });

      _createOrUpdateChart('chart-ads-metrics', {
        type: 'line',
        data: { labels: data.days, datasets },
        options: {
          ..._getChartDefaults(),
          scales: {
            ..._getChartDefaults().scales,
            y: { ..._getChartDefaults().scales.y, position: 'left', title: { display: true, text: 'Count', color: '#64748b', font: { size: 9 } } },
            y1: { position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + '%' }, title: { display: true, text: 'Fill rate %', color: '#64748b', font: { size: 9 } } },
          },
        },
      });

      // Summary line: totals per slot.
      if (summaryEl) {
        const lines = data.series.map(s => {
          const totals = s.perDay.reduce((acc, d) => {
            acc.impressions += d.impressions; acc.clicks += d.clicks; acc.fails += d.fails; acc.skips += d.skips; acc.timeouts += d.timeouts;
            return acc;
          }, { impressions: 0, clicks: 0, fails: 0, skips: 0, timeouts: 0 });
          const denom = totals.impressions + totals.fails + totals.timeouts;
          const fill = denom > 0 ? ((totals.impressions / denom) * 100).toFixed(1) + '%' : '—';
          return `${s.slot}: ${totals.impressions} imp · ${totals.clicks} clk · ${totals.fails} fail · ${totals.skips} skip · ${totals.timeouts} timeout · fill ${fill}`;
        });
        summaryEl.textContent = lines.join('  |  ');
      }
    } catch (e) {
      console.warn('[AdsMetrics] Failed to load:', e.message);
      _destroyChart('chart-ads-metrics');
      if (summaryEl) summaryEl.textContent = 'Failed to load ads metrics.';
    }
  }

  // ─── Load Health Status ────────────────────────────────────────
  // The probe vocabulary is now standardized on 'up' | 'degraded' | 'down'.
  async function loadHealth() {
    try {
      const health = await window.apiRequest('/api/admin/dashboard/health');
      // Overall status badge.
      const overallEl = document.getElementById('health-overall-status');
      if (overallEl) {
        const overall = health.status || 'unknown';
        overallEl.textContent = overall.toUpperCase();
        overallEl.className = 'health-overall-badge';
        if (overall === 'up') overallEl.classList.add('health-ok');
        else if (overall === 'degraded') overallEl.classList.add('health-warn');
        else if (overall === 'down') overallEl.classList.add('health-err');
        else overallEl.classList.add('health-unknown');
      }

      const cards = document.querySelectorAll('.health-card');
      cards.forEach(card => {
        const key = card.dataset.health;
        const check = health.checks?.[key];
        const statusEl = card.querySelector('.health-status');
        const iconEl = card.querySelector('.health-icon i');
        if (!check) return;

        card.className = 'health-card';
        let status = check.status || 'unknown';
        if (status === 'up') {
          card.classList.add('health-ok');
          if (iconEl) iconEl.style.color = '#10b981';
        } else if (status === 'degraded') {
          card.classList.add('health-warn');
          if (iconEl) iconEl.style.color = '#f59e0b';
        } else {
          card.classList.add('health-err');
          if (iconEl) iconEl.style.color = '#f43f5e';
        }

        // Show status text; for server_uptime show the formatted uptime.
        if (key === 'server_uptime') {
          statusEl.textContent = check.uptime || '—';
        } else {
          statusEl.textContent = status.toUpperCase();
        }

        // Sanitized tooltip: latency + a sanitized lastError (no raw DB/Pesapal
        // messages that could leak hostnames/connection strings).
        let tooltip = `${status.toUpperCase()} · ${Number(check.latencyMs) ? check.latencyMs + 'ms' : '—'}ms`;
        if (check.lastError && typeof check.lastError === 'string') {
          const sanitized = String(check.lastError)
            .replace(/https?:\/\/[^\s]+/gi, '[url]')
            .replace(/(?:[A-Za-z0-9+/]{32,}={0,3})/g, '[token]')
            .replace(/\b(?:user|pass|key|secret|token|password)\b[=: ]+[^\s,;]+/gi, '$1=[redacted]')
            .slice(0, 160);
          tooltip += ` · ${sanitized}`;
        }
        card.title = tooltip;
      });
    } catch (e) {
      console.warn('[Health] Failed to load:', e.message);
    }
  }

  // ─── Load Recent Activity Timeline ─────────────────────────────
  async function loadActivityTimeline() {
    const container = document.getElementById('recent-activity-timeline');
    if (!container) return;

    try {
      const activities = await window.apiRequest('/api/admin/dashboard/activity/recent');
      if (!activities || activities.length === 0) {
        EmptyState.render({ container, icon: '📋', title: 'No recent activity', description: 'Activity will appear here as users interact with the platform.' });
        return;
      }

      container.innerHTML = activities.map(a => {
        const iconMap = { anime: '📺', user: '👤', payment: '💰', admin_action: '⚙️' };
        const icon = iconMap[a.type] || '📌';
        const timeAgo = window._timeAgo ? window._timeAgo(a.created_at) : new Date(a.created_at).toLocaleString();
        return `<div class="timeline-item"><span class="timeline-icon">${icon}</span><div class="timeline-content"><strong>${window._escapeHTML(a.label)}</strong>${a.detail ? `<small>${window._escapeHTML(a.detail)}</small>` : ''}</div><span class="timeline-time">${timeAgo}</span></div>`;
      }).join('');
    } catch (e) {
      console.warn('[Activity] Failed to load:', e.message);
    }
  }

  // --- Data Loading ---
  async function loadOverview() {
    // Show skeleton loading on stat cards
    const statCards = document.querySelectorAll('.card .value[id^="stats-"]');
    statCards.forEach(el => {
      el.innerHTML = '...';
    });

    try {
      const data = await window.apiRequest('/api/admin/dashboard/overview');

      const overview = data.overview;
      if (!overview) {
        throw new Error('API response is missing the "overview" object.');
      }

      const { users = {}, content = {}, cloudinary = {}, revenue = {} } = overview;
      const { total: totalUsers = 0, premium: premiumUsers = 0 } = users;
      const { totalAnime = 0, totalEpisodes = 0 } = content;
      const { ready: videoCount = 0 } = cloudinary;
      const { today = 0, month = 0, total = 0 } = revenue;

      setText('#stats-total-users', totalUsers);
      setText('#stats-vip-users', premiumUsers);
      setText('#stats-total-anime', totalAnime);
      setText('#stats-total-episodes', totalEpisodes);
      setText('#stats-cloudinary-videos', videoCount);
      setText('#stats-revenue-today', `UGX ${window._formatNumber(today)}`);
      setText('#stats-revenue-month', `UGX ${window._formatNumber(month)}`);
      setText('#stats-revenue-total', `UGX ${window._formatNumber(total)}`);

      // Populate lists
      populateList('#top-anime-list', data.topAnime, item => `<span>${window._escapeHTML(item.title)}</span><span class="list-value">${window._formatNumber(item.views || 0)} views</span>`);
      populateList('#recent-uploads', data.recentEpisodes, item => `<span>${window._escapeHTML(item.anime_title || 'Unknown')} - Ep ${item.episode_number}</span><span class="list-value">${window._formatDate(item.created_at)}</span>`);
      populateList('#latest-users', data.latestUsers, item => `<span>${window._escapeHTML(item.name)}</span><span class="list-value">${window._escapeHTML(item.email)}</span>`);
      populateList('#activity-logs', data.activityLogs, item => `<span>${window._escapeHTML(item.action || item.message)}</span><span class="list-value">${window._timeAgo(item.created_at || item.timestamp)}</span>`);

    } catch (error) {
      console.error('Failed to load or render dashboard overview:', error);
      const errorEl = document.getElementById('dashboard-error');
      if (errorEl) {
        ErrorState.render({
          container: errorEl,
          message: 'Failed to load dashboard data',
          details: error.message,
          retryFn: () => loadOverview()
        });
      }
      document.querySelectorAll('[id^="stats-"]').forEach(el => el.textContent = '—');
    }
  }

  function populateList(selector, items, formatter) {
    const container = document.querySelector(selector);
    if (!container) return;
    if (!items || items.length === 0) {
      EmptyState.render({
        container: container,
        icon: '📦',
        title: 'No data available',
        description: 'Check back later for updates.'
      });
      return;
    }
    container.innerHTML = items.map(item => {
      const content = formatter(item);
      return `<div class="list-item">${content}</div>`;
    }).join('');
  }

  // --- Event Listeners ---
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetSection = link.dataset.section || (link.getAttribute('href') || '').substring(1);
      if (targetSection) {
        showSection(targetSection);
      }
    });
  });

  window.addEventListener('hashchange', () => {
    const targetId = window.location.hash.substring(1) || 'dashboard';
    showSection(targetId);
  });

  window.addEventListener('popstate', () => {
    const targetId = window.location.hash.substring(1) || 'dashboard';
    showSection(targetId);
  });

  function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
  }
  window.logout = logout;

  function initializeDashboard() {
    const initialSection = window.location.hash.substring(1) || 'dashboard';
    showSection(initialSection);

    // Load all dashboard components
    loadOverview();
    loadHealth();
    loadCharts();
    loadAdsMetrics();
    loadActivityTimeline();

    // Auto-refresh setup
    let autoRefreshTimer = null;
    const REFRESH_INTERVAL = 30000; // 30 seconds

    function startAutoRefresh() {
      stopAutoRefresh();
      autoRefreshTimer = setInterval(fullRefresh, REFRESH_INTERVAL);
    }

    function stopAutoRefresh() {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    }

    function fullRefresh() {
      loadOverview();
      loadHealth();
      loadCharts();
      loadAdsMetrics();
      loadActivityTimeline();
      const refreshEl = document.getElementById('last-refresh-time');
      if (refreshEl) refreshEl.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
    }

    // Auto-refresh toggle
    const toggle = document.getElementById('auto-refresh-toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        if (toggle.checked) startAutoRefresh();
        else stopAutoRefresh();
      });
    }

    // Manual refresh button
    const refreshBtn = document.getElementById('refresh-now-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', fullRefresh);
    }

    // Start auto-refresh
    startAutoRefresh();
  }

  initializeDashboard();
});
