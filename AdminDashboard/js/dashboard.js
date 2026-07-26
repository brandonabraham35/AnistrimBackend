document.addEventListener('DOMContentLoaded', () => {
  // Ensure admin token exists, otherwise redirect to login.
  if (!localStorage.getItem('admin_token')) {
    window.location.replace('index.html');
    return;
  }

  const sections = document.querySelectorAll('.content-section');
  const navLinks = document.querySelectorAll('.sidebar .nav-link');

  // --- Helper Functions ---
  const safeInner = (selector, value, fallback = '0') => {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = value || fallback;
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
  }

  // --- Data Loading ---
  async function loadOverview() {
    try {
      const data = await apiFetch('/api/admin/dashboard/overview');

      // The API nests the main stats under an "overview" key.
      // We must access that key first.
      const overview = data.overview;
      if (!overview) {
        throw new Error('API response is missing the "overview" object.');
      }

      const { users = {}, content = {}, cloudinary = {}, revenue = {} } = overview;
      const { totalUsers = 0, premiumUsers = 0 } = users;
      const { totalAnime = 0, totalEpisodes = 0 } = content;
      const { videoCount = 0 } = cloudinary;
      const { today = 0, month = 0 } = revenue;

      console.log('[Dashboard] Hydrating stats:', { totalUsers, premiumUsers, totalAnime, totalEpisodes, videoCount, revenueToday: today, revenueMonth: month });

      safeInner('#stats-total-users', totalUsers);
      safeInner('#stats-vip-users', premiumUsers);
      safeInner('#stats-total-anime', totalAnime);
      safeInner('#stats-total-episodes', totalEpisodes);
      safeInner('#stats-cloudinary-videos', videoCount);
      safeInner('#stats-revenue-today', `UGX ${today.toLocaleString()}`);
      safeInner('#stats-revenue-month', `UGX ${month.toLocaleString()}`);

    } catch (error) {
      console.error('Failed to load or render dashboard overview:', error);
      const errorEl = document.getElementById('dashboard-error');
      if (errorEl) {
        errorEl.textContent = `Dashboard Error: ${error.message}. Check console for details.`;
      }
      document.querySelectorAll('[id^="stats-"]').forEach(el => el.innerHTML = '<span style="color: #f87171;">Error</span>');
    }
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