(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value ?? '-'; };
  const date = value => value ? new Date(value).toLocaleDateString() : '-';
  const money = (value, currency = 'UGX') => `${currency} ${Number(value || 0).toLocaleString()}`;

  function requireAdmin() {
    try { if (localStorage.getItem('admin_token') && JSON.parse(localStorage.getItem('admin_user') || '{}').isAdmin) return true; } catch (_) { /* sign out below */ }
    localStorage.removeItem('admin_token'); localStorage.removeItem('admin_user'); window.location.replace('index.html'); return false;
  }
  const setError = message => text('dashboard-error', message || '');

  async function loadOverview() {
    try {
      const data = await window.apiRequest('/admin/dashboard/overview'); const overview = data.overview;
      text('total-users', Number(overview.users.total || 0).toLocaleString()); text('premium-users', Number(overview.users.premium || 0).toLocaleString());
      text('total-anime', Number(overview.content.totalAnime || 0).toLocaleString()); text('total-episodes', Number(overview.content.totalEpisodes || 0).toLocaleString()); text('total-views', Number(overview.content.totalViews || 0).toLocaleString());
      const media = overview.cloudinary || { ready: 0, processing: 0, failed: 0 };
      text('cloudinary-ready', media.ready || 0); text('cloudinary-processing', media.processing || 0); text('cloudinary-failed', media.failed || 0);
      text('active-users-today', overview.users.activeToday || 0); text('banned-users', overview.users.banned || 0);
      document.getElementById('top-anime-list').innerHTML = (data.topAnime || []).map(a => `<div class="list-item"><span class="item-title">${esc(a.title)}</span><span class="item-sub">${Number(a.view_count || 0).toLocaleString()} views</span></div>`).join('') || '<div class="item-sub">No anime records.</div>';
      document.getElementById('recent-uploads').innerHTML = (data.recentEpisodes || []).map(e => `<div class="list-item"><span class="item-title">${esc(e.anime_title)} · Ep ${esc(e.episode_number)}</span><span class="item-sub">${esc(e.video_status || 'Available')}</span></div>`).join('') || '<div class="item-sub">No episode records.</div>';
      document.getElementById('latest-users').innerHTML = (data.latestUsers || []).map(u => `<div class="list-item"><span class="item-title">${esc(u.name)}</span><span class="item-sub">Joined ${date(u.created_at)}</span></div>`).join('') || '<div class="item-sub">No user records.</div>';
      document.getElementById('activity-logs').innerHTML = (data.activityLogs || []).map(log => `<div class="timeline-item"><span class="time">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span><strong>${esc(log.user_name || 'System')}</strong> ${esc(log.action)}</span></div>`).join('') || '<div class="item-sub">No activity records.</div>';
      try { await loadPaymentSummary(); } catch (error) { console.error('Payment summary failed:', error); }
      setError('');
    } catch (error) { console.error('Dashboard overview failed:', error); setError(`Unable to load live dashboard data: ${error.message}`); }
  }

  async function loadPaymentSummary() {
    const data = await window.apiRequest('/payments/revenue'); const stats = data.stats || {}; const currency = data.recent?.[0]?.currency || 'UGX';
    text('revenue-total', money(stats.total_revenue, currency)); text('revenue-today', money(stats.revenue_today, currency)); text('revenue-monthly', stats.monthly_subs ? `${stats.monthly_subs} subscriptions` : 'No subscriptions'); text('rev-avg-daily', money(Number(stats.total_revenue || 0) / Math.max(1, new Date().getDate()), currency));
    document.querySelector('#recent-payments-table tbody').innerHTML = (data.recent || []).slice(0, 5).map(p => `<tr><td>${esc(p.name || p.email)}</td><td>${esc(money(p.amount, p.currency || currency))}</td><td>${esc(p.status)}</td></tr>`).join('') || '<tr><td colspan="3">No payment records.</td></tr>';
  }
    async function loadAnime() { const body = document.querySelector('#anime-table tbody'); body.innerHTML = '<tr><td colspan="6">Loading anime...</td></tr>'; try { const anime = await window.apiRequest('/admin/anime'); body.innerHTML = anime.map(a => `<tr><td><img src="${esc(a.cover_image || 'placeholder.jpg')}" width="50" style="border-radius:4px;aspect-ratio:3/4;object-fit:cover"></td><td>${esc(a.title)}</td><td><span class="status-badge ${esc(a.status || 'unknown')}">${esc(a.status || 'unknown')}</span></td><td>${a.is_premium ? '💎' : 'Free'}</td><td>${a.is_featured ? '⭐' : '-'}</td><td><button class="action-btn edit-btn" onclick="openAnimeEditor(${a.id})" title="Edit"><i class="fas fa-edit"></i></button> <button class="action-btn edit-btn" style="background:#10b981" onclick="manageEpisodes(${a.id}, '${esc(a.title)}')" title="Episodes"><i class="fas fa-list"></i></button> <button class="action-btn delete-btn" onclick="deleteAnimeItem(${a.id})" title="Delete"><i class="fas fa-trash"></i></button></td></tr>`).join('') || '<tr><td colspan="6">No anime records.</td></tr>'; } catch (error) { body.innerHTML = `<tr><td colspan="6">${esc(error.message)}</td></tr>`; } }
    window.deleteAnimeItem = async (id) => { if (!confirm('Delete this anime permanently?')) return; await window.apiRequest(`/admin/anime/${id}`, { method: 'DELETE' }); await loadAnime(); await loadOverview(); };
  async function loadUsers() { const body = document.querySelector('#users-table tbody'); body.innerHTML = '<tr><td colspan="6">Loading users...</td></tr>'; try { const users = await window.apiRequest('/admin/users'); body.innerHTML = users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.is_admin ? 'Admin' : 'User'}</td><td>${u.is_premium ? 'Premium' : 'Free'}</td><td>${esc(u.status)}</td><td>${date(u.created_at)}<br>${u.is_admin ? '' : `<button class="btn secondary" data-premium-user="${u.id}" data-premium-value="${u.is_premium ? '0' : '1'}">${u.is_premium ? 'Revoke Premium' : 'Grant Premium'}</button>`}</td></tr>`).join('') || '<tr><td colspan="6">No user records.</td></tr>'; } catch (error) { body.innerHTML = `<tr><td colspan="6">${esc(error.message)}</td></tr>`; } }
  async function loadEpisodes() { const body = document.querySelector('#episodes-table tbody'); body.innerHTML = '<tr><td colspan="6">Loading episodes...</td></tr>'; try { const episodes = await window.apiRequest('/admin/episodes'); body.innerHTML = episodes.map(e => `<tr><td>${esc(e.anime_title)}</td><td>${esc(e.episode_number)}</td><td>${esc(e.title || 'Untitled')}</td><td>${e.duration_sec ? `${Number(e.duration_sec)} sec` : '-'}</td><td>${Number(e.view_count || 0).toLocaleString()}</td><td>${e.is_premium ? 'Premium' : 'Free'}<br><button class="btn secondary" data-edit-episode="${e.id}">Edit</button> <button class="btn danger" data-delete-episode="${e.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6">No episode records.</td></tr>'; } catch (error) { body.innerHTML = `<tr><td colspan="6">${esc(error.message)}</td></tr>`; } }
  async function loadPayments() { const body = document.querySelector('#payments-table tbody'); body.innerHTML = '<tr><td colspan="5">Loading payments...</td></tr>'; try { const data = await window.apiRequest('/payments/revenue'); body.innerHTML = (data.recent || []).map(p => `<tr><td>${esc(p.name || p.email)}</td><td>${esc(money(p.amount, p.currency || 'UGX'))}</td><td>${esc(p.plan)}</td><td>${esc(p.status)}</td><td>${date(p.paid_at || p.created_at)}</td></tr>`).join('') || '<tr><td colspan="5">No payment records.</td></tr>'; } catch (error) { body.innerHTML = `<tr><td colspan="5">${esc(error.message)}</td></tr>`; } }

    function openModal(title, content) { const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop'; backdrop.innerHTML = `<div class="modal-card"><div class="toolbar"><h3 style="margin-right:auto">${esc(title)}</h3><button class="btn secondary" type="button">Close</button></div>${content}</div>`; backdrop.addEventListener('click', event => { if (event.target === backdrop || event.target.matches('button.secondary')) backdrop.remove(); }); document.body.append(backdrop); return backdrop; }
    async function uploadImage(file, folder) { const payload = new FormData(); payload.append('image', file); const result = await window.apiRequest(`/admin/upload/${folder}`, { method: 'POST', body: payload }); return { url: result.secure_url || result.url || result.imageUrl || '', publicId: result.public_id || '' }; }

    // ─── Hybrid Add Anime Modal Wiring ──────────────────────
    function wireHybridModal() {
      const modal = document.getElementById('add-anime-modal');
      if (!modal) return;

      const openBtn = document.getElementById('add-anime-button');
      const closeBtn = document.getElementById('close-add-anime-modal');
      const tabButtons = modal.querySelectorAll('[data-anime-tab]');
      const panels = modal.querySelectorAll('[data-anime-panel]');
      const searchForm = document.getElementById('kitsu-search-form');
      const searchResults = document.getElementById('kitsu-search-results');
      const manualForm = document.getElementById('manual-add-anime-form');

      // ─── Open / Close ────────────────────────────────────
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          tabButtons.forEach((btn, i) => btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false'));
          panels.forEach((panel, i) => { panel.hidden = i !== 0; });
          if (searchResults) searchResults.innerHTML = '';
          if (searchForm) searchForm.reset();
          if (manualForm) manualForm.reset();
          document.getElementById('manual-cover-preview').innerHTML = '';
          document.getElementById('manual-banner-preview').innerHTML = '';
          document.getElementById('manual-cover-url').value = '';
          document.getElementById('manual-banner-url').value = '';
          modal.hidden = false;
          modal.removeAttribute('aria-hidden');
          setTimeout(() => document.getElementById('kitsu-search-input')?.focus(), 100);
        });
      }

      if (closeBtn) closeBtn.addEventListener('click', () => closeModal());

      modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

      function closeModal() { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); }

      // ─── Tab Toggle ──────────────────────────────────────
      tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-anime-tab');
          tabButtons.forEach(b => b.setAttribute('aria-selected', b.getAttribute('data-anime-tab') === tab ? 'true' : 'false'));
          panels.forEach(p => p.hidden = p.getAttribute('data-anime-panel') !== tab);
        });
      });

      // ─── Kitsu Search ────────────────────────────────────
      if (searchForm) {
        searchForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const query = document.getElementById('kitsu-search-input').value.trim();
          if (!query) return;

          const submitBtn = searchForm.querySelector('button[type="submit"]');
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner"></span> Searching...';
          searchResults.innerHTML = '';

          try {
            const data = await window.apiRequest(`/anime/search?q=${encodeURIComponent(query)}&limit=12`);
            renderKitsuSearchResults(data);
          } catch (err) {
            searchResults.innerHTML = `<p style="color:#ef4444;padding:1rem">${esc(err.message)}</p>`;
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Search';
          }
        });
      }

      function renderKitsuSearchResults(results) {
        if (!results || !results.length) {
          searchResults.innerHTML = '<p style="color:#94a3b8;padding:1rem">No results found.</p>';
          return;
        }
        searchResults.innerHTML = '';

        // ─── "Import All Results" toolbar ──────────────────────
        const importAllBar = document.createElement('div');
        importAllBar.className = 'import-all-bar';
        importAllBar.style.cssText = 'display:flex;justify-content:flex-end;gap:.75rem;margin-bottom:.75rem;';
        const importAllBtn = document.createElement('button');
        importAllBtn.className = 'btn import-all-btn';
        importAllBtn.textContent = '📥 Import All Results';
        importAllBtn.type = 'button';
        importAllBar.appendChild(importAllBtn);
        searchResults.appendChild(importAllBar);

        // ─── Build result cards ─────────────────────────────────
        results.forEach(anime => {
          const card = document.createElement('div');
          card.className = 'kitsu-result';
          card.innerHTML = `
            <img src="${esc(anime.cover_image || '')}" alt="${esc(anime.title)}" loading="lazy" onerror="this.src='placeholder.jpg'">
            <div>
              <h4>${esc(anime.title)}</h4>
              <p>${esc(anime.year || '?')} · ${esc(anime.episode_count || '?')} episodes</p>
              <p class="synopsis">${esc(anime.description || 'No synopsis available.')}</p>
            </div>
            <button class="btn import-btn" data-kitsu-id="${esc(anime.kitsu_id || anime.id)}">Import</button>
          `;
          searchResults.appendChild(card);
        });

        // ─── Helper: import a single kitus-result card by button ─
        async function importSingle(btn) {
          const kitsuId = btn.getAttribute('data-kitsu-id');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Importing...';

          try {
            await window.apiRequest('/admin/import-anime', { method: 'POST', body: { kitsuId } });
            btn.innerHTML = '✅ Imported';
            btn.className = 'btn imported-btn';
            btn.disabled = true;
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Import';
            const errEl = document.createElement('p');
            errEl.style.cssText = 'color:#ef4444;font-size:.85rem;margin-top:.5rem;grid-column:1/-1';
            errEl.textContent = `Import failed: ${err.message}`;
            btn.closest('.kitsu-result')?.appendChild(errEl);
          }
        }

        // ─── Wire individual import buttons ─────────────────────
        const allImportBtns = [...searchResults.querySelectorAll('.import-btn')];
        allImportBtns.forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await importSingle(btn);
          });
        });

        // ─── Wire "Import All Results" button ───────────────────
        importAllBtn.addEventListener('click', async () => {
          importAllBtn.disabled = true;
          importAllBtn.innerHTML = '<span class="spinner"></span> Importing all...';

          for (const btn of allImportBtns) {
            // Skip already-imported buttons
            if (btn.disabled && btn.classList.contains('imported-btn')) continue;
            await importSingle(btn);
          }

          importAllBtn.innerHTML = '✅ All Imported';
          importAllBtn.className = 'btn imported-btn';
          importAllBtn.disabled = true;
        });
      }

      // ─── Manual Upload: Cover Image ──────────────────────
      const coverFile = document.getElementById('manual-cover-file');
      if (coverFile) {
        coverFile.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const result = await uploadImage(file, 'anime');
            document.getElementById('manual-cover-url').value = result.url;
            document.getElementById('manual-cover-preview').innerHTML = `<img src="${result.url}">`;
          } catch (err) {
            document.getElementById('manual-cover-preview').innerHTML = `<span style="color:#ef4444;font-size:.85rem">Upload failed: ${esc(err.message)}</span>`;
          }
        });
      }

      // ─── Manual Upload: Banner Image ─────────────────────
      const bannerFile = document.getElementById('manual-banner-file');
      if (bannerFile) {
        bannerFile.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const result = await uploadImage(file, 'banners');
            document.getElementById('manual-banner-url').value = result.url;
            document.getElementById('manual-banner-preview').innerHTML = `<img src="${result.url}">`;
          } catch (err) {
            document.getElementById('manual-banner-preview').innerHTML = `<span style="color:#ef4444;font-size:.85rem">Upload failed: ${esc(err.message)}</span>`;
          }
        });
      }

      // ─── Manual Upload: Submit Form ──────────────────────
      if (manualForm) {
        manualForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const submitBtn = manualForm.querySelector('button[type="submit"]');
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner"></span> Creating...';

          try {
            const body = {
              title: document.getElementById('manual-title').value.trim(),
              year: document.getElementById('manual-year').value ? parseInt(document.getElementById('manual-year').value) : undefined,
              studio: document.getElementById('manual-studio').value.trim() || undefined,
              status: document.getElementById('manual-status').value,
              description: document.getElementById('manual-description').value.trim() || undefined,
              is_premium: document.getElementById('manual-is-premium').checked ? 1 : 0,
              is_featured: document.getElementById('manual-is-featured').checked ? 1 : 0,
              cover_image: document.getElementById('manual-cover-url').value || undefined,
              banner_image: document.getElementById('manual-banner-url').value || undefined,
            };

            await window.apiRequest('/admin/anime', { method: 'POST', body });
            closeModal();
            await loadAnime();
            await loadOverview();
          } catch (err) {
            alert(`Failed to create anime: ${err.message}`);
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Anime';
          }
        });
      }
    }
  function uploadVideo(file, title, progress) { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); const data = new FormData(); data.append('video', file); data.append('title', title || file.name); xhr.open('POST', `${window.API_BASE}/admin/upload/video`); const token = localStorage.getItem('admin_token'); if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`); xhr.upload.onprogress = event => event.lengthComputable && progress(Math.round(event.loaded / event.total * 100), 'Uploading...'); xhr.onerror = () => reject(new Error('Network error while uploading the video.')); xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch (_) { return reject(new Error('Invalid response from the video upload service.')); } if (xhr.status < 200 || xhr.status >= 300 || result.success === false) return reject(new Error(result.message || 'Video upload failed.')); resolve(result); }; xhr.send(data); }); }
  async function prepareEpisodeMedia(form) { const bar = form.querySelector('[data-upload-progress]'); const status = form.querySelector('[data-upload-status]'); const progress = (value, message) => { bar.hidden = false; bar.value = value; status.textContent = message; }; const data = Object.fromEntries(new FormData(form)); delete data.video_file; delete data.thumbnail_file; data.is_premium = form.is_premium.checked; if (form.thumbnail_file.files[0]) { progress(0, 'Preparing thumbnail upload...'); const image = await uploadImage(form.thumbnail_file.files[0], 'thumbnails'); data.thumbnail_url = image.url; data.thumbnail_public_id = image.publicId; const input = form.querySelector('#ep-thumb-url'); if (input) input.value = image.url; } if (form.video_file.files[0]) { progress(0, 'Preparing upload...'); const video = await uploadVideo(form.video_file.files[0], data.title, progress); progress(100, 'Cloudinary processing complete.'); data.video_url = video.secure_url || video.video_url; data.cloudinary_public_id = video.public_id; data.duration_sec = Math.round(Number(video.duration || 0)) || null; const urlInput = form.querySelector('#ep-video-url'); const idInput = form.querySelector('#ep-cloudinary-id'); if (urlInput) urlInput.value = data.video_url; if (idInput) idInput.value = data.cloudinary_public_id; } return data; }
  async function openAnimeEditor(id = null) { let anime = {}; if (id) anime = (await window.apiRequest('/admin/anime')).find(item => Number(item.id) === Number(id)) || {}; const modal = openModal(id ? 'Edit Anime' : 'Add Anime', `<form id="anime-form" class="form-grid"><label>Title<input name="title" required value="${esc(anime.title || '')}"></label><label>Japanese title<input name="title_japanese" value="${esc(anime.title_japanese || '')}"></label><label>Year<input name="year" type="number" value="${esc(anime.year || '')}"></label><label>Studio<input name="studio" value="${esc(anime.studio || '')}"></label><label>Rating<input name="rating" type="number" min="0" max="10" step=".1" value="${esc(anime.rating || '')}"></label><label>Status<select name="status"><option value="airing">Airing</option><option value="completed">Completed</option><option value="upcoming">Upcoming</option></select></label><label>Cover URL<input name="cover_image" value="${esc(anime.cover_image || '')}"><input name="cover_file" type="file" accept="image/*"></label><label>Banner URL<input name="banner_image" value="${esc(anime.banner_image || '')}"><input name="banner_file" type="file" accept="image/*"></label><label class="wide">Description<textarea name="description">${esc(anime.description || '')}</textarea></label><label class="wide">Tags<input name="tags" value="${esc(anime.tags || '')}"></label><label><input name="is_premium" type="checkbox" ${anime.is_premium ? 'checked' : ''}> Premium only</label><label><input name="is_featured" type="checkbox" ${anime.is_featured ? 'checked' : ''}> Hero featured</label><div class="wide"><button class="btn" type="submit">${id ? 'Save changes' : 'Create anime'}</button></div></form>`); modal.querySelector('[name=status]').value = anime.status || 'completed'; modal.querySelector('#anime-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = Object.fromEntries(new FormData(form)); data.is_premium = form.is_premium.checked; data.is_featured = form.is_featured.checked; if (form.cover_file.files[0]) { const image = await uploadImage(form.cover_file.files[0], 'anime'); data.cover_image = image.url; data.cover_public_id = image.publicId; } if (form.banner_file.files[0]) { const image = await uploadImage(form.banner_file.files[0], 'banners'); data.banner_image = image.url; data.banner_public_id = image.publicId; } delete data.cover_file; delete data.banner_file; await window.apiRequest(id ? `/admin/anime/${id}` : '/admin/anime', { method: id ? 'PUT' : 'POST', body: data }); modal.remove(); await loadAnime(); await loadOverview(); } catch (error) { alert(`Anime was not saved: ${error.message}`); } finally { submit.disabled = false; } }); }
  async function openEpisodeEditor(animeId = '') { const anime = await window.apiRequest('/admin/anime'); const modal = openModal('Add Episode', `<form id="episode-form" class="form-grid"><label>Anime<select name="anime_id" required>${anime.map(a => `<option value="${a.id}" ${String(a.id) === String(animeId) ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></label><label>Episode number<input name="episode_number" type="number" min="1" required></label><label>Title<input name="title"></label><label>Video file<input id="ep-video-file" name="video_file" type="file" accept="video/*" required></label><label>Thumbnail image<input id="ep-thumb-file" name="thumbnail_file" type="file" accept="image/*" required></label><input id="ep-video-url" name="video_url" type="hidden"><input id="ep-cloudinary-id" name="cloudinary_public_id" type="hidden"><input id="ep-thumb-url" name="thumbnail_url" type="hidden"><label>Intro start<input name="intro_start_time" type="number" min="0"></label><label>Intro end<input name="intro_end_time" type="number" min="0"></label><label><input name="is_premium" type="checkbox"> Premium episode</label><div class="wide"><progress data-upload-progress hidden value="0" max="100"></progress><div data-upload-status aria-live="polite"></div><button class="btn" type="submit">Save Episode</button></div></form>`); modal.querySelector('#episode-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = await prepareEpisodeMedia(form); const selected = data.anime_id; delete data.anime_id; await window.apiRequest(`/admin/anime/${selected}/episodes`, { method: 'POST', body: data }); modal.remove(); await loadEpisodes(); await loadOverview(); } catch (error) { alert(`Episode was not published: ${error.message}`); } finally { submit.disabled = false; } }); }
  async function openEpisodeEdit(id) { const episode = await window.apiRequest(`/admin/episodes/${id}`); const modal = openModal('Edit Episode', `<form id="episode-edit-form" class="form-grid"><label>Episode number<input name="episode_number" type="number" min="1" value="${esc(episode.episode_number)}"></label><label>Title<input name="title" value="${esc(episode.title || '')}"></label><label>Replace video (optional)<input id="ep-video-file" name="video_file" type="file" accept="video/*"></label><label>Replace thumbnail (optional)<input id="ep-thumb-file" name="thumbnail_file" type="file" accept="image/*"></label><input id="ep-video-url" name="video_url" type="hidden" value="${esc(episode.video_url || '')}"><input id="ep-cloudinary-id" name="cloudinary_public_id" type="hidden" value="${esc(episode.cloudinary_public_id || '')}"><input id="ep-thumb-url" name="thumbnail_url" type="hidden" value="${esc(episode.thumbnail_url || '')}"><label>Intro start<input name="intro_start_time" type="number" value="${esc(episode.intro_start_time || '')}"></label><label>Intro end<input name="intro_end_time" type="number" value="${esc(episode.intro_end_time || '')}"></label><label><input name="is_premium" type="checkbox" ${episode.is_premium ? 'checked' : ''}> Premium episode</label><div class="wide"><progress data-upload-progress hidden value="0" max="100"></progress><div data-upload-status aria-live="polite"></div><button class="btn" type="submit">Save Episode</button></div></form>`); modal.querySelector('#episode-edit-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const data = await prepareEpisodeMedia(form); await window.apiRequest(`/admin/episodes/${id}`, { method: 'PUT', body: data }); modal.remove(); await loadEpisodes(); await loadOverview(); } catch (error) { alert(`Episode was not saved: ${error.message}`); } finally { submit.disabled = false; } }); }
  function showSection(section) { document.querySelectorAll('[data-section-panel]').forEach(panel => { panel.hidden = panel.dataset.sectionPanel !== section; }); document.querySelectorAll('[data-section]').forEach(link => link.classList.toggle('active', link.dataset.section === section)); text('page-title', ({ dashboard: 'Administrative Overview', anime: 'Anime List', episodes: 'Episodes', users: 'Users Management', payments: 'Payments' })[section]); window.location.hash = section; ({ dashboard: loadOverview, anime: loadAnime, episodes: loadEpisodes, users: loadUsers, payments: loadPayments })[section]?.(); }
  window.manageEpisodes = (animeId) => { showSection('episodes'); openEpisodeEditor(animeId); }; window.logout = () => { localStorage.removeItem('admin_token'); localStorage.removeItem('admin_user'); window.location.replace('index.html'); };
  document.addEventListener('DOMContentLoaded', () => { if (!requireAdmin()) return; document.querySelectorAll('[data-section]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showSection(link.dataset.section); })); wireHybridModal(); document.getElementById('add-episode-button').addEventListener('click', () => openEpisodeEditor()); document.addEventListener('click', async event => { const edit = event.target.closest('[data-edit-anime]'); const remove = event.target.closest('[data-delete-anime]'); const manage = event.target.closest('[data-manage-episodes]'); const premium = event.target.closest('[data-premium-user]'); const editEpisode = event.target.closest('[data-edit-episode]'); const deleteEpisode = event.target.closest('[data-delete-episode]'); try { if (edit) return openAnimeEditor(edit.dataset.editAnime); if (manage) return window.manageEpisodes(manage.dataset.manageEpisodes, manage.dataset.animeTitle); if (remove && confirm('Delete this anime and its episodes?')) { await window.apiRequest(`/admin/anime/${remove.dataset.deleteAnime}`, { method: 'DELETE' }); await loadAnime(); await loadOverview(); } if (premium) { await window.apiRequest(`/admin/users/${premium.dataset.premiumUser}/premium`, { method: 'PUT', body: { is_premium: premium.dataset.premiumValue === '1' } }); await loadUsers(); await loadOverview(); } if (editEpisode) return openEpisodeEdit(editEpisode.dataset.editEpisode); if (deleteEpisode && confirm('Delete this episode?')) { await window.apiRequest(`/admin/episodes/${deleteEpisode.dataset.deleteEpisode}`, { method: 'DELETE' }); await loadEpisodes(); await loadOverview(); } } catch (error) { alert(error.message || 'Operation failed.'); } }); const section = location.hash.slice(1); showSection(['dashboard', 'anime', 'episodes', 'users', 'payments'].includes(section) ? section : 'dashboard'); window.setInterval(() => { if (!document.querySelector('[data-section-panel="dashboard"]').hidden) loadOverview(); }, 30000); });
})();
