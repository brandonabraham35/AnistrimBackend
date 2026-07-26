document.addEventListener('DOMContentLoaded', () => {
  const initializedSections = new Set();

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
      const data = await apiFetch('/api/admin/dashboard/overview');

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
      safeInner('#stats-cloudinary-videos', videoC