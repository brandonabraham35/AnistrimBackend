document.addEventListener('DOMContentLoaded', () => {
  const sections = document.querySelectorAll('.content-section');
  const navLinks = document.querySelectorAll('.sidebar .nav-link');

  // --- Helper Functions ---
  const safeInner = (selector, value, fallback = '0') => {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = value || fallback;
  };

  // --- SPA Routing ---
  function showSection(targetId) {
    const currentActive = document.querySelector('.content-section.active');
    if (currentActive && currentActive.id === targetId) {
      return;
    }

    sections.forEach(section => {
      section.classList.toggle('active', section.id === targetId);
    });

    navLinks.forEach(link => {
      const linkTargetId = (link.dataset.section || (link.href && link.href.split('#')[1]));
      link.classList.toggle('active', linkTargetId === targetId);
    });

    if (history.pushState) {
      history.pushState(null, null, `#${targetId}`);
    } else {
      location.hash = `#${targetId}`;
    }
  }

  // --- Data Loading ---
  async function loadOverview() {
    try {
      const overview = await apiFetch('/api/admin/dashboard/overview');

      const { users = {}, content = {}, cloudinary = {}, revenue = {} } = overview || {};
      const { totalUsers = 0, premiumUsers = 0 } = users;
      const { totalAnime = 0, totalEpisodes = 0 } = content;
      const { videoCount = 0 } = cloudinary;
      const { today = 0, month = 0 } = revenue;

      safeInner('#stats-total-users', totalUsers);
      safeInner('#stats-vip-users', premiumUsers);
      safeInner('#stats-total-anime', totalAnime);
      safeInner('#stats-total-episodes', totalEpisodes);
      safeInner('#stats-cloudinary-videos', videoCount);
      safeInner('#stats-revenue-today', `UGX ${today.toLocaleString()}`);
      safeInner('#stats-revenue-month', `UGX ${month.toLocaleString()}`);

    } catch (error) {
      console.error('Failed to load dashboard overview:', error);
      document.querySelectorAll('[id^="stats-"]').forEach(el => el.innerHTML = '<span style="color: #f87171;">Error</span>');
    }
  }

  // --- Event Listeners ---
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetSection = link.dataset.section;
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

  // --- Initial Load ---
  function initializeDashboard() {
    const initialSection = window.location.hash.substring(1) || 'dashboard';
    showSection(initialSection);
    loadOverview();
    setInterval(loadOverview, 30000);
  }

  initializeDashboard();
});