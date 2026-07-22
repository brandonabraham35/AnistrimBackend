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

        // ─── Import Button Handler ───────────────────────────
        searchResults.querySelectorAll('.import-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const kitsuId = btn.getAttribute('data-kitsu-id');
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> Importing...';

                try {
                    await window.apiRequest('/admin/import-anime', {
                        method: 'POST',
                        body: { kitsuId }
                    });
                    // ─── SUCCESS ──────────────────────────────
                    // Close the modal
                    closeModal();
                    // ⬇ Replace `loadAnimeList()` with your table refresh function:
                    await loadAnimeList();
                } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'Import';
                    // Show error inline
                    const errEl = document.createElement('p');
                    errEl.style.cssText = 'color:#ef4444;font-size:.85rem;margin-top:.5rem;grid-column:1/-1';
                    errEl.textContent = `Import failed: ${err.message}`;
                    btn.closest('.kitsu-result')?.appendChild(errEl);
                }
            });
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

// ─── Edit Anime (placeholder for existing edit modal) ────────
// Your existing edit modal logic goes here if you have one.
// If not, this is a placeholder that opens a simple prompt-based edit.
function editAnime(id) {
    const a = allAnime.find(x => x.id === id);
    if (!a) return;
    // Open the manual tab pre-filled for editing?
    // For now, use the existing edit modal if it exists, or alert.
    alert(`Edit anime #${id}: "${a.title}"\n\nOpen your edit modal here.`);
    // If you have an existing edit modal, show it and pre-fill:
    // document.getElementById('anime-id').value = a.id;
    // ... show the modal ...
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

