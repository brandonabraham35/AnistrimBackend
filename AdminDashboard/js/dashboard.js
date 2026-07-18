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
      body.innerHTML = anime.map(a => `<tr><td>${escapeHtml(a.title)}</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.year || '—')}</td><td>${Number(a.episode_count || 0)}</td><td>${Number(a.view_count || 0).toLocaleString()}</td><td>${escapeHtml(a.genres || 'Uncategorized')}<br><button class="btn secondary" data-edit-anime="${a.id}">Edit</button> <button class="btn danger" data-delete-anime="${a.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6">No anime records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadUsers() {
    const body = document.querySelector('#users-table tbody');
    body.innerHTML = '<tr><td colspan="6">Loading users…</td></tr>';
    try {
      const users = await window.apiRequest('/admin/users');
      body.innerHTML = users.map(u => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${u.is_admin ? 'Admin' : 'User'}</td><td>${u.is_premium ? 'Premium' : 'Free'}</td><td>${escapeHtml(u.status)}</td><td>${date(u.created_at)}<br>${u.is_admin ? '' : `<button class="btn secondary" data-premium-user="${u.id}" data-premium-value="${u.is_premium ? '0' : '1'}">${u.is_premium ? 'Revoke Premium' : 'Grant Premium'}</button>`}</td></tr>`).join('') || '<tr><td colspan="6">No user records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  async function loadEpisodes() {
    const body = document.querySelector('#episodes-table tbody');
    body.innerHTML = '<tr><td colspan="6">Loading episodes…</td></tr>';
    try {
      const episodes = await window.apiRequest('/admin/episodes');
      body.innerHTML = episodes.map(e => `<tr><td>${escapeHtml(e.anime_title)}</td><td>${escapeHtml(e.episode_number)}</td><td>${escapeHtml(e.title || 'Untitled')}</td><td>${e.duration_sec ? `${Number(e.duration_sec)} sec` : '—'}</td><td>${Number(e.view_count || 0).toLocaleString()}</td><td>${e.is_premium ? 'Premium' : 'Free'}<br><button class="btn secondary" data-edit-episode="${e.id}">Edit</button> <button class="btn danger" data-delete-episode="${e.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6">No episode records.</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
  }

  function openModal(title, content) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal-card"><div class="toolbar"><h3 style="margin-right:auto">${escapeHtml(title)}</h3><button class="btn secondary" type="button">Close</button></div>${content}</div>`;
    backdrop.addEventListener('click', event => { if (event.target === backdrop || event.target.matches('button.secondary')) backdrop.remove(); });
    document.body.append(backdrop);
    return backdrop;
  }

  async function uploadImage(file, folder) {
    if (!file) return '';
    const payload = new FormData(); payload.append('image', file);
    const result = await window.apiRequest(`/admin/upload/${folder}`, { method: 'POST', body: payload });
    return result.url || result.imageUrl || result.image_url || '';
  }

  async function openAnimeEditor(id = null) {
    let anime = {};
    if (id) anime = (await window.apiRequest('/admin/anime')).find(item => Number(item.id) === Number(id)) || {};
    const modal = openModal(id ? 'Edit Anime' : 'Add Anime', `<form id="anime-form" class="form-grid">
      <label>Title<input name="title" required value="${escapeHtml(anime.title || '')}"></label><label>Japanese title<input name="title_japanese" value="${escapeHtml(anime.title_japanese || '')}"></label>
      <label>Year<input name="year" type="number" value="${escapeHtml(anime.year || '')}"></label><label>Studio<input name="studio" value="${escapeHtml(anime.studio || '')}"></label>
      <label>Rating<input name="rating" type="number" min="0" max="10" step=".1" value="${escapeHtml(anime.rating || '')}"></label><label>Status<select name="status"><option value="airing">Airing</option><option value="completed">Completed</option><option value="upcoming">Upcoming</option></select></label>
      <label>Cover URL<input name="cover_image" value="${escapeHtml(anime.cover_image || '')}"><input name="cover_file" type="file" accept="image/*"></label><label>Banner URL<input name="banner_image" value="${escapeHtml(anime.banner_image || '')}"><input name="banner_file" type="file" accept="image/*"></label>
      <label class="wide">Description<textarea name="description">${escapeHtml(anime.description || '')}</textarea></label><label class="wide">Tags<input name="tags" value="${escapeHtml(anime.tags || '')}"></label>
      <label><input name="is_premium" type="checkbox" ${anime.is_premium ? 'checked' : ''}> Premium only</label><label><input name="is_featured" type="checkbox" ${anime.is_featured ? 'checked' : ''}> Hero featured</label>
      <div class="wide"><button class="btn" type="submit">${id ? 'Save changes' : 'Create anime'}</button></div></form>`);
    modal.querySelector('[name=status]').value = anime.status || 'completed';
    modal.querySelector('#anime-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = Object.fromEntries(new FormData(form)); data.is_premium = form.is_premium.checked; data.is_featured = form.is_featured.checked; if (form.cover_file.files[0]) data.cover_image = await uploadImage(form.cover_file.files[0], 'anime'); if (form.banner_file.files[0]) data.banner_image = await uploadImage(form.banner_file.files[0], 'banners'); delete data.cover_file; delete data.banner_file; await window.apiRequest(id ? `/admin/anime/${id}` : '/admin/anime', { method: id ? 'PUT' : 'POST', body: data }); modal.remove(); await loadAnime(); await loadOverview(); } catch (error) { alert(`Anime was not saved: ${error.message}`); } finally { submit.disabled = false; } });
  }

  async function openEpisodeEditor() {
    const anime = await window.apiRequest('/admin/anime');
    const modal = openModal('Add Episode', `<form id="episode-form" class="form-grid"><label>Anime<select name="anime_id" required>${anime.map(a => `<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('')}</select></label><label>Episode number<input name="episode_number" type="number" min="1" required></label><label>Title<input name="title"></label><label>Duration (seconds)<input name="duration_sec" type="number"></label><label>Video URL<input name="video_url"></label><label>Thumbnail URL<input name="thumbnail_url"><input name="thumbnail_file" type="file" accept="image/*"></label><label>Intro start<input name="intro_start_time" type="number" min="0"></label><label>Intro end<input name="intro_end_time" type="number" min="0"></label><label><input name="is_premium" type="checkbox"> Premium episode</label><div class="wide"><button class="btn" type="submit">Publish episode</button></div></form>`);
    modal.querySelector('#episode-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = Object.fromEntries(new FormData(form)); data.is_premium = form.is_premium.checked; if (form.thumbnail_file.files[0]) data.thumbnail_url = await uploadImage(form.thumbnail_file.files[0], 'thumbnails'); delete data.thumbnail_file; const animeId = data.anime_id; delete data.anime_id; await window.apiRequest(`/admin/anime/${animeId}/episodes`, { method: 'POST', body: data }); modal.remove(); await loadEpisodes(); await loadOverview(); } catch (error) { alert(`Episode was not published: ${error.message}`); } finally { submit.disabled = false; } });
  }

  async function openEpisodeEdit(id) {
    const episode = await window.apiRequest(`/admin/episodes/${id}`);
    const modal = openModal('Edit Episode', `<form id="episode-edit-form" class="form-grid"><label>Episode number<input name="episode_number" type="number" min="1" value="${escapeHtml(episode.episode_number)}"></label><label>Title<input name="title" value="${escapeHtml(episode.title || '')}"></label><label>Duration (seconds)<input name="duration_sec" type="number" value="${escapeHtml(episode.duration_sec || '')}"></label><label>Video URL<input name="video_url" value="${escapeHtml(episode.video_url || '')}"></label><label>Thumbnail URL<input name="thumbnail_url" value="${escapeHtml(episode.thumbnail_url || '')}"></label><label>Intro start<input name="intro_start_time" type="number" value="${escapeHtml(episode.intro_start_time || '')}"></label><label>Intro end<input name="intro_end_time" type="number" value="${escapeHtml(episode.intro_end_time || '')}"></label><label><input name="is_premium" type="checkbox" ${episode.is_premium ? 'checked' : ''}> Premium episode</label><div class="wide"><button class="btn" type="submit">Save episode</button></div></form>`);
    modal.querySelector('#episode-edit-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = Object.fromEntries(new FormData(form)); data.is_premium = form.is_premium.checked; await window.apiRequest(`/admin/episodes/${id}`, { method: 'PUT', body: data }); modal.remove(); await loadEpisodes(); await loadOverview(); } catch (error) { alert(`Episode was not saved: ${error.message}`); } finally { submit.disabled = false; } });
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
    document.getElementById('add-anime-button').addEventListener('click', () => openAnimeEditor());
    document.getElementById('add-episode-button').addEventListener('click', () => openEpisodeEditor());
    document.addEventListener('click', async event => {
      const edit = event.target.closest('[data-edit-anime]');
      const remove = event.target.closest('[data-delete-anime]');
      const premium = event.target.closest('[data-premium-user]');
      const editEpisode = event.target.closest('[data-edit-episode]');
      const deleteEpisode = event.target.closest('[data-delete-episode]');
      try {
        if (edit) return openAnimeEditor(edit.dataset.editAnime);
        if (remove && confirm('Delete this anime and its episodes?')) { await window.apiRequest(`/admin/anime/${remove.dataset.deleteAnime}`, { method: 'DELETE' }); await loadAnime(); await loadOverview(); }
        if (premium) { await window.apiRequest(`/admin/users/${premium.dataset.premiumUser}/premium`, { method: 'PUT', body: { is_premium: premium.dataset.premiumValue === '1' } }); await loadUsers(); await loadOverview(); }
        if (editEpisode) return openEpisodeEdit(editEpisode.dataset.editEpisode);
        if (deleteEpisode && confirm('Delete this episode?')) { await window.apiRequest(`/admin/episodes/${deleteEpisode.dataset.deleteEpisode}`, { method: 'DELETE' }); await loadEpisodes(); await loadOverview(); }
      } catch (error) { alert(error.message || 'Operation failed.'); }
    });
    showSection(['dashboard', 'anime', 'episodes', 'users', 'payments'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
    window.setInterval(() => { if (!document.querySelector('[data-section-panel="dashboard"]').hidden) loadOverview(); }, 30000);
  });
})();
