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

  // --- Data Loading ---
  async function loadOverview() {
    // Show skeleton loading on stat cards
    const statCards = document.querySelectorAll('.card .value[id^="stats-"]');
    statCards.forEach(el => {
      el.innerHTML = window.SkeletonLoader ? window.SkeletonLoader.stat(1) : '...';
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

      console.log('[Dashboard] Hydrating stats:', { totalUsers, premiumUsers, totalAnime, totalEpisodes, videoCount, revenueToday: today, revenueMonth: month });

      setText('#stats-total-users', totalUsers);
      setText('#stats-vip-users', premiumUsers);
      setText('#stats-total-anime', totalAnime);
      setText('#stats-total-episodes', totalEpisodes);
      setText('#stats-cloudinary-videos', videoCount);
      setText('#stats-revenue-today', `UGX ${today.toLocaleString()}`);
      setText('#stats-revenue-month', `UGX ${month.toLocaleString()}`);
      setText('#stats-revenue-total', `UGX ${total.toLocaleString()}`);

      // Populate lists using shared EmptyState for empty data
      populateList('#top-anime-list', data.topAnime, item => `<span>${window._escapeHTML(item.title)}</span><span class="list-value">${item.views || 0} views</span>`);
      populateList('#recent-uploads', data.recentEpisodes, item => `<span>${window._escapeHTML(item.anime_title || 'Unknown')} - Ep ${item.episode_number}</span><span class="list-value">${new Date(item.created_at).toLocaleDateString()}</span>`);
      populateList('#latest-users', data.latestUsers, item => `<span>${window._escapeHTML(item.name)}</span><span class="list-value">${window._escapeHTML(item.email)}</span>`);
      populateList('#activity-logs', data.activityLogs, item => `<span>${window._escapeHTML(item.message)}</span><span class="list-value">${new Date(item.timestamp).toLocaleTimeString()}</span>`);

    } catch (error) {
      console.error('Failed to load or render dashboard overview:', error);
      const errorEl = document.getElementById('dashboard-error');
      if (errorEl && window.ErrorState) {
        ErrorState.render({
          container: errorEl,
          message: 'Failed to load dashboard data',
          details: error.message,
          retryFn: () => loadOverview()
        });
      } else if (errorEl) {
        errorEl.innerHTML = `Dashboard Error: ${window._escapeHTML(error.message)}.`;
      }
      document.querySelectorAll('[id^="stats-"]').forEach(el => el.textContent = '—');
    }
  }

  function populateList(selector, items, formatter) {
    const container = document.querySelector(selector);
    if (!container) return;
    if (!items || items.length === 0) {
      if (window.EmptyState) {
        EmptyState.render({
          container: container,
          icon: 'inbox',
          title: 'No data available',
          description: 'Check back later for updates.'
        });
      } else {
        container.innerHTML = '<div class="list-item empty">No data available.</div>';
      }
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
    loadOverview();
    setInterval(loadOverview, 30000);
  }

  initializeDashboard();
});
