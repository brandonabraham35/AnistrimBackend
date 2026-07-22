let allAnime = [];

// ─── Initialization ──────────────────────────────────────────
async function initAnime() {
    await loadAnimeList();
    wireAddAnimeModal();
}

// ─── Anime Table ─────────────────────────────────────────────
async function loadAnimeList() {
    const q = document.getElementById('anime-search')?.value || '';
    const status = document.getElementById('anime-filter-status')?.value || '';

    let url = '/admin/anime?';
    if (q) url += `q=${encodeURIComponent(q)}&`;
    if (status) url += `status=${encodeURIComponent(status)}&`;

    const data = await window.apiRequest(url);
    allAnime = data;
    const tbody = document.querySelector('#anime-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    data.forEach(a => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><img src="${a.cover_image || 'placeholder.jpg'}" width="50" style="border-radius:4px;aspect-ratio:3/4;object-fit:cover"></td>
            <td>${window.escapeHtml ? window.escapeHtml(a.title) : a.title}</td>
            <td><span class="status-badge ${a.status || 'unknown'}">${a.status || 'unknown'}</span></td>
            <td>${a.is_premium ? '💎' : 'Free'}</td>
            <td>${a.is_featured ? '⭐' : '-'}</td>
            <td>
                <button class="action-btn edit-btn" onclick="editAnime(${a.id})" title="Edit"><i class="fas fa-edit"></i></button>
                <button class="action-btn edit-btn" style="background:#10b981" onclick="window.manageEpisodes && manageEpisodes(${a.id}, '${(a.title || '').replace(/'/g, "\\'")}')" title="Episodes"><i class="fas fa-list"></i></button>
                <button class="action-btn delete-btn" onclick="deleteAnime(${a.id})" title="Delete"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ─── Hybrid Modal ────────────────────────────────────────────
function wireAddAnimeModal() {
    const modal = document.getElementById('add-anime-modal');
    if (!modal) return;

    const openBtn = document.getElementById('add-anime-button');
    const closeBtn = document.getElementById('close-add-anime-modal');
    const tabButtons = modal.querySelectorAll('[data-anime-tab]');
    const panels = modal.querySelectorAll('[data-anime-panel]');
    const searchForm = document.getElementById('kitsu-search-form');
    const searchResults = document.getElementById('kitsu-search-results');
    const manualForm = document.getElementById('manual-add-anime-form');

    // ─── Open / Close ────────────────────────────────────────
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            // Reset to first tab
            tabButtons.forEach((btn, i) => {
                btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
            });
            panels.forEach((panel, i) => {
                panel.hidden = i !== 0;
            });
            // Clear previous results
            if (searchResults) searchResults.innerHTML = '';
            if (searchForm) searchForm.reset();
            if (manualForm) manualForm.reset();
            // Reset previews
            document.getElementById('manual-cover-preview').innerHTML = '';
            document.getElementById('manual-banner-preview').innerHTML = '';
            document.getElementById('manual-cover-url').value = '';
            document.getElementById('manual-banner-url').value = '';
            modal.hidden = false;
            modal.removeAttribute('aria-hidden');
            // Focus search input
            setTimeout(() => document.getElementById('kitsu-search-input')?.focus(), 100);
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeModal();
    });

    function closeModal() {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
    }

    // ─── Tab Toggle ──────────────────────────────────────────
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-anime-tab');
            tabButtons.forEach(b => b.setAttribute('aria-selected', b.getAttribute('data-anime-tab') === tab ? 'true' : 'false'));
            panels.forEach(p => p.hidden = p.getAttribute('data-anime-panel') !== tab);
        });
    });

    // ─── Kitsu Search ────────────────────────────────────────
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
                renderKitsuResults(data);
            } catch (err) {
                searchResults.innerHTML = `<p style="color:#ef4444;padding:1rem">${err.message}</p>`;
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Search';
            }
        });
    }

    function renderKitsuResults(results) {
        if (!results || !results.length) {
            searchResults.innerHTML = '<p style="color:#94a3b8;padding:1rem">No results found. Try a different query.</p>';
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
                <img src="${anime.cover_image || ''}" alt="${anime.title}" loading="lazy" onerror="this.src='placeholder.jpg'">
                <div>
                    <h4>${anime.title}</h4>
                    <p>${anime.year || '?'} · ${anime.episode_count || '?'} episodes</p>
                    <p class="synopsis">${anime.description || 'No synopsis available.'}</p>
                </div>
                <button class="btn import-btn" data-kitsu-id="${anime.kitsu_id || anime.id}">Import</button>
            `;
            searchResults.appendChild(card);
        });

        // ─── Helper: import a single kitsu-result card by button ─
        async function importSingle(btn) {
            const kitsuId = btn.getAttribute('data-kitsu-id');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Importing...';

            try {
                await window.apiRequest('/admin/import-anime', {
                    method: 'POST',
                    body: { kitsuId }
                });
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

    // ─── Manual Upload: Cover Image ──────────────────────────
    const coverFile = document.getElementById('manual-cover-file');
    if (coverFile) {
        coverFile.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const result = await uploadImg(file, 'anime');
                document.getElementById('manual-cover-url').value = result;
                document.getElementById('manual-cover-preview').innerHTML = `<img src="${result}">`;
            } catch (err) {
                document.getElementById('manual-cover-preview').innerHTML = `<span style="color:#ef4444;font-size:.85rem">Upload failed: ${err.message}</span>`;
            }
        });
    }

    // ─── Manual Upload: Banner Image ─────────────────────────
    const bannerFile = document.getElementById('manual-banner-file');
    if (bannerFile) {
        bannerFile.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const result = await uploadImg(file, 'banners');
                document.getElementById('manual-banner-url').value = result;
                document.getElementById('manual-banner-preview').innerHTML = `<img src="${result}">`;
            } catch (err) {
                document.getElementById('manual-banner-preview').innerHTML = `<span style="color:#ef4444;font-size:.85rem">Upload failed: ${err.message}</span>`;
            }
        });
    }

    // ─── Manual Upload: Submit Form ──────────────────────────
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

                await window.apiRequest('/admin/anime', {
                    method: 'POST',
                    body
                });

                closeModal();
                // ⬇ Replace `loadAnimeList()` with your table refresh function:
                await loadAnimeList();
            } catch (err) {
                alert(`Failed to create anime: ${err.message}`);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Anime';
            }
        });
    }
}

// ─── Image Upload Helper ─────────────────────────────────────
async function uploadImg(file, folder) {
    const formData = new FormData();
    formData.append('image', file);
    const data = await window.apiRequest(`/admin/upload/${folder}`, { method: 'POST', body: formData });
    return data.url || data.secure_url || data;
}

// ─── Edit Anime Modal ────────────────────────────────────────
function editAnime(id) {
    var a = allAnime.find(function(x) { return x.id === id; });
    if (!a) return;
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(2,6,23,.75);display:grid;place-items:center;padding:1rem;';
    var modal = document.createElement('div');
    modal.className = 'modal-card';
    modal.style.cssText = 'width:min(480px,100%);background:#1e293b;border:1px solid #475569;border-radius:.75rem;padding:1.5rem;color:#f8fafc;';
    var t = (a.title || '').replace(/"/g, '"');
    var d = (a.description || '').replace(/"/g, '"');
    modal.innerHTML = [
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">',
          '<h3 style="font-size:1.15rem;">Edit Anime</h3>',
          '<button type="button" class="close-edit-btn" style="background:transparent;color:#94a3b8;border:0;font-size:1.5rem;cursor:pointer;">\u00d7</button>',
        '</div>',
        '<form style="display:grid;gap:1rem;">',
          '<label style="display:grid;gap:.35rem;color:#94a3b8;font-size:.85rem;">Title',
            '<input name="title" value="' + t + '" required style="background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:.35rem;padding:.55rem;">',
          '</label>',
          '<label style="display:grid;gap:.35rem;color:#94a3b8;font-size:.85rem;">Description',
            '<textarea name="description" rows="3" style="background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:.35rem;padding:.55rem;">' + d + '</textarea>',
          '</label>',
          '<label style="display:grid;gap:.35rem;color:#94a3b8;font-size:.85rem;">Status',
            '<select name="status" style="background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:.35rem;padding:.55rem;">',
              '<option value="airing"' + (a.status === 'airing' ? ' selected' : '') + '>Airing</option>',
              '<option value="completed"' + (a.status === 'completed' ? ' selected' : '') + '>Completed</option>',
              '<option value="upcoming"' + (a.status === 'upcoming' ? ' selected' : '') + '>Upcoming</option>',
            '</select>',
          '</label>',
          '<label style="display:flex;align-items:center;gap:.5rem;color:#94a3b8;font-size:.85rem;cursor:pointer;">',
            '<input type="checkbox" name="is_premium"' + (a.is_premium ? ' checked' : '') + ' style="width:auto;"> Premium only',
          '</label>',
          '<div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:.5rem;">',
            '<button type="button" class="close-edit-btn" style="background:#334155;border:0;border-radius:.45rem;padding:.55rem .8rem;color:white;cursor:pointer;font-weight:600;">Cancel</button>',
            '<button type="submit" class="save-edit-btn" style="background:#3b82f6;border:0;border-radius:.45rem;padding:.55rem .8rem;color:white;cursor:pointer;font-weight:600;">Save Changes</button>',
          '</div>',
        '</form>'
    ].join('');
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    var closeEdit = function() { backdrop.remove(); };
    backdrop.querySelectorAll('.close-edit-btn').forEach(function(el) { el.addEventListener('click', closeEdit); });
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) closeEdit(); });
    var form = modal.querySelector('form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = form.querySelector('.save-edit-btn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
            var body = {
                title: form.title.value.trim(),
                description: form.description.value.trim(),
                status: form.status.value,
                is_premium: form.is_premium.checked ? 1 : 0
            };
            await window.apiRequest('/admin/anime/' + a.id, { method: 'PUT', body: body });
            closeEdit();
            var toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;background:#059669;color:#fff;padding:.75rem 1.25rem;border-radius:.5rem;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.3);';
            toast.textContent = '\u2705 "' + body.title + '" updated';
            document.body.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 3000);
            var idx = allAnime.findIndex(function(x) { return x.id === a.id; });
            if (idx !== -1) {
                allAnime[idx] = Object.assign({}, allAnime[idx], body);
                var tbody = document.querySelector('#anime-table tbody');
                if (tbody) {
                    var rows = tbody.querySelectorAll('tr');
                    if (rows[idx]) {
                        var u = allAnime[idx];
                        var ta = (u.title || '').replace(/'/g, "\\'");
                        rows[idx].innerHTML = [
                            '<td><img src="' + (u.cover_image || 'placeholder.jpg') + '" width="50" style="border-radius:4px;aspect-ratio:3/4;object-fit:cover"></td>',
                            '<td>' + (window.escapeHtml ? window.escapeHtml(u.title) : u.title) + '</td>',
                            '<td><span class="status-badge ' + (u.status || 'unknown') + '">' + (u.status || 'unknown') + '</span></td>',
                            '<td>' + (u.is_premium ? '\uD83D\uDC8E' : 'Free') + '</td>',
                            '<td>' + (u.is_featured ? '\u2B50' : '-') + '</td>',
                            '<td>',
                              '<button class="action-btn edit-btn" onclick="editAnime(' + u.id + ')" title="Edit"><i class="fas fa-edit"></i></button> ',
                              '<button class="action-btn edit-btn" style="background:#10b981" onclick="window.manageEpisodes && manageEpisodes(' + u.id + ', \'' + ta + '\')" title="Episodes"><i class="fas fa-list"></i></button> ',
                              '<button class="action-btn delete-btn" onclick="deleteAnime(' + u.id + ')" title="Delete"><i class="fas fa-trash"></i></button>',
                            '</td>'
                        ].join('');
                    }
                }
            }
        } catch (err) {
            alert('Failed to update: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Changes';
        }
    });
}

// ─── Delete Anime ────────────────────────────────────────────
async function deleteAnime(id) {
    if (!confirm('Delete this anime permanently?')) return;
    await window.apiRequest(`/admin/anime/${id}`, { method: 'DELETE' });
    await loadAnimeList();
}

// ─── Exports ─────────────────────────────────────────────────
window.initAnime = initAnime;
window.editAnime = editAnime;
window.deleteAnime = deleteAnime;
window.loadAnimeList = loadAnimeList;

