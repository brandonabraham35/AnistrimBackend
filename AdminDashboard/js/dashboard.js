(function () {
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const setText = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value ?? '—'; };
  const date = value => value ? new Date(value).toLocaleDateString() : '—';
  const money = (value, currency = 'UGX') => `${currency} ${Number(value || 0).toLocaleString()}`;

  function requireAdmin() {
    const token = localStorage.getItem('admin_token');
    try {
      const user = JSON.parse(localStorage.getItem('admin_user') || 'null');
      if (token && user?.isAdmin) return true;
    } catch (_) { /* handled below */ }
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.replace('index.html');
    return false;
  }

  function setError(message = '') { setText('dashboard-error', message); }

  async function loadOverview() {
    try {
      const data = await window.apiRequest('/admin/dashboard/overview');
      const overview = data.overview;
      setText('total-users', overview.users.total.toLocaleString());
      setText('premium-users', overview.users.premium.toLocaleString());
      setText('total-anime', overview.content.totalAnime.toLocaleString());
      setText('total-episodes', overview.content.totalEpisodes.toLocaleString());
      setText('total-views', overview.content.totalViews.toLocaleString());
      setText('bunny-ready', overview.bunny.ready);
      setText('bunny-processing', overview.bunny.processing);
      setText('bunny-failed', overview.bunny.failed);
      setText('active-users-today', overview.users.activeToday);
      setText('banned-users', overview.users.banned);

      try {
        const paymentData = await window.apiRequest('/payments/revenue');
        const stats = paymentData.stats || {};
        const currency = paymentData.recent?.[0]?.currency || 'UGX';
        setText('revenue-total', money(stats.total_revenue, currency));
        setText('revenue-today', money(stats.revenue_today, currency));
        setText('revenue-monthly', stats.monthly_subs ? `${Number(stats.monthly_subs)} subscriptions` : 'No subscriptions');
        setText('rev-avg-daily', money(Number(stats.total_revenue || 0) / Math.max(1, new Date().getDate()), currency));
        document.querySelector('#recent-payments-table tbody').innerHTML = (paymentData.recent || []).slice(0, 5).map(p => `<tr><td>${escapeHtml(p.name || p.email)}</td><td>${escapeHtml(money(p.amount, p.currency || currency))}</td><td>${escapeHtml(p.status)}</td></tr>`).join('') || '<tr><td colspan="3">No payment records.</td></tr>';
      } catch (error) {
        console.error('Payments summary failed:', error);
        document.querySelector('#recent-payments-table tbody').innerHTML = '<tr><td colspan="3">Payment data is temporarily unavailable.</td></tr>';
      }
      document.getElementById('top-anime-list').innerHTML = data.topAnime.map(a => `<div class="list-item"><span class="item-title">${escapeHtml(a.title)}</span><span class="item-sub">${Number(a.view_count || 0).toLocaleString()} views</span></div>`).join('') || '<div class="item-sub">No anime records.</div>';
      document.getElementById('recent-uploads').innerHTML = data.recentEpisodes.map(e => `<div class="list-item"><span class="item-title">${escapeHtml(e.anime_title)} · Ep ${escapeHtml(e.episode_number)}</span><span class="item-sub">${escapeHtml(e.video_status)}</span></div>`).join('') || '<div class="item-sub">No episode records.</div>';
      document.getElementById('latest-users').innerHTML = data.latestUsers.map(u => `<div class="list-item"><span class="item-title">${escapeHtml(u.name)}</span><span class="item-sub">Joined ${date(u.created_at)}</span></div>`).join('') || '<div class="item-sub">No user records.</div>';
      document.getElementById('activity-logs').innerHTML = data.activityLogs.map(log => `<div class="timeline-item"><span class="time">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span><strong>${escapeHtml(log.user_name || 'System')}</strong> ${escapeHtml(log.action)}</span></div>`).join('') || '<div class="item-sub">No activity records.</div>';
      setError('');
    } catch (error) {
      console.error('Dashboard overview failed:', error);
      setError(`Unable to load live dashboard data: ${error.message}`);
    }
  }

  async function loadAnime() {
    const body = document.querySelector('#anime-table tbody');
    body.innerHTML = '<tr><td colspan="6">Loading anime…</td></tr>';
    try {
      const anime = await window.apiRequest('/admin/anime');
      body.innerHTML = anime.map(a => `<tr><td>${escapeHtml(a.title)}</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.year || '—')}</td><td>${Number(a.episode_count || 0)}</td><td>${Number(a.view_count || 0).toLocaleString()}</td><td>${escapeHtml(a.genres || 'Uncategorized')}</td></tr>`).join('') || '<tr><td colspan="6">No anime records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadUsers() {
    const body = document.querySelector('#users-table tbody');
    body.innerHTML = '<tr><td colspan="6">Loading users…</td></tr>';
    try {
      const users = await window.apiRequest('/admin/users');
      body.innerHTML = users.map(u => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${u.is_admin ? 'Admin' : 'User'}</td><td>${u.is_premium ? 'Premium' : 'Free'}</td><td>${escapeHtml(u.status)}</td><td>${date(u.created_at)}</td></tr>`).join('') || '<tr><td colspan="6">No user records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadEpisodes() {
    const body = document.querySelector('#episodes-table tbody');
    body.innerHTML = '<tr><td colspan="6">Loading episodes…</td></tr>';
    try {
      const episodes = await window.apiRequest('/admin/episodes');
      body.innerHTML = episodes.map(e => `<tr><td>${escapeHtml(e.anime_title)}</td><td>${escapeHtml(e.episode_number)}</td><td>${escapeHtml(e.title || 'Untitled')}</td><td>${e.duration_sec ? `${Number(e.duration_sec)} sec` : '—'}</td><td>${Number(e.view_count || 0).toLocaleString()}</td><td>${e.is_premium ? 'Premium' : 'Free'}</td></tr>`).join('') || '<tr><td colspan="6">No episode records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadPayments() {
    const body = document.querySelector('#payments-table tbody');
    body.innerHTML = '<tr><td colspan="5">Loading payments…</td></tr>';
    try {
      const data = await window.apiRequest('/payments/revenue');
      body.innerHTML = (data.recent || []).map(p => `<tr><td>${escapeHtml(p.name || p.email)}</td><td>${escapeHtml(money(p.amount, p.currency || 'UGX'))}</td><td>${escapeHtml(p.plan)}</td><td>${escapeHtml(p.status)}</td><td>${date(p.paid_at || p.created_at)}</td></tr>`).join('') || '<tr><td colspan="5">No payment records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`; }
  }

  function showSection(section) {
    document.querySelectorAll('[data-section-panel]').forEach(panel => { panel.hidden = panel.dataset.sectionPanel !== section; });
    document.querySelectorAll('[data-section]').forEach(link => link.classList.toggle('active', link.dataset.section === section));
    setText('page-title', ({ dashboard: 'Administrative Overview', anime: 'Anime List', episodes: 'Episodes', users: 'Users Management', payments: 'Payments' })[section]);
    window.location.hash = section;
    if (section === 'dashboard') loadOverview();
    if (section === 'anime') loadAnime();
    if (section === 'episodes') loadEpisodes();
    if (section === 'users') loadUsers();
    if (section === 'payments') loadPayments();
  }

  window.logout = () => { localStorage.removeItem('admin_token'); localStorage.removeItem('admin_user'); window.location.replace('index.html'); };
  document.addEventListener('DOMContentLoaded', () => {
    if (!requireAdmin()) return;
    document.querySelectorAll('[data-section]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showSection(link.dataset.section); }));
    showSection(['dashboard', 'anime', 'episodes', 'users', 'payments'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
    window.setInterval(() => { if (!document.querySelector('[data-section-panel="dashboard"]').hidden) loadOverview(); }, 30000);
  });
})();
