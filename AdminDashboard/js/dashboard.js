document.addEventListener('DOMContentLoaded', () => {
  const initializedSections = new Set();

  // Ensure admin token exists, otherwise redirect to login.
  if (!localStorage.getItem('admin_token')) {
    window.location.replace('index.html');
    return;
  }

  const sections = document.querySelectorAll('.content-section');
  const navLinks = document.querySelectorAll('.sidebar .nav-links a:not(.logout-btn)');

  // --- Helper Functions ---
  const safeInner = (selector, value, fallback = '0') => {
    const el = document.querySelector(selector);
    if (el) {
      // Use textContent for security unless the value is explicitly meant to be HTML
      if (String(value).includes('<')) el.innerHTML = value;
      else el.textContent = value || fallback;
    }
  };

  // --- SPA Routing ---
  function showSection(targetId) {
    // Default to 'dashboard' if the targetId is invalid or not found
    const effectiveTargetId = document.getElementById(targetId) ? targetId : 'dashboard';

    sections.forEach(section => {
      section.classList.toggle('active', section.id === effectiveTargetId);
    });

    navLinks.forEach(link => {
      const linkTargetId = (link.dataset.section || (link.href && link.href.split('#')[1]));
      link.classList.toggle('active', linkTargetId === effectiveTargetId);
    });

    // Update URL hash. Using history.pushState is cleaner for SPAs.
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
    try {
      const data = await window.apiRequest('/api/admin/dashboard/overview');

      // The API nests the main stats under an "overview" key.
      // We must access that key first.
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

      safeInner('#stats-total-users', totalUsers);
      safeInner('#stats-vip-users', premiumUsers);
      safeInner('#stats-total-anime', totalAnime);
      safeInner('#stats-total-episodes', totalEpisodes);
      safeInner('#stats-cloudinary-videos', videoCount);
      safeInner('#stats-revenue-today', `UGX ${today.toLocaleString()}`);
      safeInner('#stats-revenue-month', `UGX ${month.toLocaleString()}`);
      safeInner('#stats-revenue-total', `UGX ${total.toLocaleString()}`);

      // Populate the new Uchiha-style lists
      populateList('#top-anime-list', data.topAnime, item => `<span>${item.title}</span><span class="list-value">${item.views || 0} views</span>`);
      populateList('#recent-uploads', data.recentEpisodes, item => `<span>${item.anime_title || 'Unknown'} - Ep ${item.episode_number}</span><span class="list-value">${new Date(item.created_at).toLocaleDateString()}</span>`);
      populateList('#latest-users', data.latestUsers, item => `<span>${item.name}</span><span class="list-value">${item.email}</span>`);
      populateList('#activity-logs', data.activityLogs, item => `<span>${item.message}</span><span class="list-value">${new Date(item.timestamp).toLocaleTimeString()}</span>`);

    } catch (error) {
      console.error('Failed to load or render dashboard overview:', error);
      const errorEl = document.getElementById('dashboard-error');
      if (errorEl) {
        // Replace the inline onclick with a proper event listener for a better UX.
        errorEl.innerHTML = `
          Dashboard Error: ${error.message}.
          <button id="dashboard-retry-btn" style="background:var(--primary);color:#fff;border:0;border-radius:4px;padding:4px 12px;margin-left:8px;cursor:pointer;">
            ↺ Retry
          </button>
        `;
        const retryBtn = document.getElementById('dashboard-retry-btn');
        if (retryBtn) {
          // Re-call the load function directly instead of reloading the whole page.
          retryBtn.addEventListener('click', () => loadOverview());
        }
      }
      document.querySelectorAll('[id^="stats-"]').forEach(el => el.innerHTML = '<span style="color: #f87171;">Error</span>');
    }
  }

  function populateList(selector, items, formatter) {
    const container = document.querySelector(selector);
    if (!container) return;
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="list-item empty">No data available.</div>';
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
      // Support both `data-section` and `href` attributes for routing
      const targetSection = link.dataset.section || (link.getAttribute('href') || '').substring(1);
      if (targetSection) {
        showSection(targetSection);
      }
    });
  });

  // This listener handles direct hash changes (e.g., from bookmarks).
  window.addEventListener('hashchange', () => {
    const targetId = window.location.hash.substring(1) || 'dashboard';
    showSection(targetId);
  });

  // This listener handles browser back/forward navigation.
  window.addEventListener('popstate', () => {
    const targetId = window.location.hash.substring(1) || 'dashboard';
    showSection(targetId);
  });

  // --- Global Logout Handler ---
  function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
  }
  window.logout = logout;

  // --- Initial Load ---
  function initializeDashboard() {
    const initialSection = window.location.hash.substring(1) || 'dashboard';
    showSection(initialSection);
    loadOverview();
    setInterval(loadOverview, 30000);
  }

  initializeDashboard();
});