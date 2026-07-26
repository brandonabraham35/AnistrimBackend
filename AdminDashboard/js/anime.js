// AdminDashboard/js/anime.js

// This module handles the "Anime List" section of the admin dashboard.

let currentEditId = null;

function initializeAnimeSection() {
    console.log('[Anime] Initializing Anime management section...');
    loadAnime();

    // --- Event Listeners ---
    const searchInput = document.getElementById('anime-search');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => loadAnime({ query: searchInput.value }), 300);
        });
    }

    document.getElementById('add-anime-button')?.addEventListener('click', openAddAnimeModal);
    document.getElementById('close-add-anime-modal')?.addEventListener('click', closeAddAnimeModal);
    document.getElementById('manual-add-anime-form')?.addEventListener('submit', handleAnimeFormSubmit);

    // Use event delegation for edit/delete buttons in the table
    document.getElementById('anime-table')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('edit')) {
            const id = e.target.dataset.id;
            openEditAnimeModal(id);
        }
        if (e.target.classList.contains('delete')) {
            const id = e.target.dataset.id;
            handleDeleteAnime(id);
        }
    });
}

function openAddAnimeModal() {
    currentEditId = null;
    document.getElementById('add-anime-modal-title').textContent = 'Add Anime';
    document.getElementById('manual-add-anime-form').reset();
    document.getElementById('manual-cover-preview').innerHTML = '';
    document.getElementById('manual-banner-preview').innerHTML = '';
    document.getElementById('add-anime-modal').hidden = false;
}

async function openEditAnimeModal(id) {
    try {
        const anime = await window.apiRequest(`/api/admin/anime/${id}`);
        if (!anime) throw new Error('Anime not found');

        currentEditId = id;
        document.getElementById('add-anime-modal-title').textContent = `Edit Anime: ${anime.title}`;

        // Populate the form
        document.getElementById('manual-title').value = anime.title || '';
        document.getElementById('manual-year').value = anime.year || '';
        document.getElementById('manual-studio').value = anime.studio || '';
        document.getElementById('manual-status').value = anime.status || 'completed';
        document.getElementById('manual-description').value = anime.description || '';
        document.getElementById('manual-is-premium').checked = anime.is_premium;
        document.getElementById('manual-is-featured').checked = anime.is_featured;

        // Display image previews
        document.getElementById('manual-cover-preview').innerHTML = anime.cover_image ? `<img src="${anime.cover_image}" style="max-height:100px;">` : '';
        document.getElementById('manual-banner-preview').innerHTML = anime.banner_image ? `<img src="${anime.banner_image}" style="max-height:100px;">` : '';

        document.getElementById('add-anime-modal').hidden = false;
    } catch (error) {
        console.error(`[Anime] Failed to fetch anime for editing (ID: ${id}):`, error);
        alert('Could not load anime data for editing.');
    }
}

function closeAddAnimeModal() {
    document.getElementById('add-anime-modal').hidden = true;
}

async function handleAnimeFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Convert checkbox values to boolean
    data.is_premium = !!data.is_premium;
    data.is_featured = !!data.is_featured;

    try {
        let response;
        if (currentEditId) {
            // Update existing anime
            response = await window.apiRequest(`/api/admin/anime/${currentEditId}`, {
                method: 'PUT',
                body: data
            });
        } else {
            // Create new anime
            response = await window.apiRequest('/api/admin/anime', {
                method: 'POST',
                body: data
            });
        }
        closeAddAnimeModal();
        loadAnime(); // Refresh the list
    } catch (error) {
        console.error('[Anime] Failed to save anime:', error);
        alert(`Error saving anime: ${error.message}`);
    }
}

async function loadAnime(filters = {}) {
    const tableBody = document.querySelector('#anime-table tbody');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading anime...</td></tr>';

    try {
        const params = new URLSearchParams();
        if (filters.query) params.set('q', filters.query);

        const animeList = await window.apiRequest(`/api/admin/anime?${params.toString()}`);

        if (!animeList || animeList.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No anime found.</td></tr>';
            return;
        }

        tableBody.innerHTML = animeList.map(anime => `
            <tr>
                <td><input type="checkbox" data-id="${anime.id}"></td>
                <td><img src="${anime.cover_image || 'img/placeholder.png'}" alt="${anime.title}" style="width:40px; height:60px; object-fit:cover; border-radius:4px;"></td>
                <td>${anime.title}</td>
                <td><span class="status-badge ${anime.status}">${anime.status}</span></td>
                <td>${anime.is_premium ? 'Yes' : 'No'}</td>
                <td>${anime.is_featured ? 'Yes' : 'No'}</td>
                <td>
                    <button class="btn-action edit" data-id="${anime.id}" title="Edit">✏️</button>
                    <button class="btn-action delete" data-id="${anime.id}" title="Delete">🗑️</button>
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('[Anime] Failed to load anime:', error);
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--danger);">Error loading anime. Check console.</td></tr>`;
    }
}

async function handleDeleteAnime(id) {
    if (!confirm(`Are you sure you want to delete anime ID: ${id}? This cannot be undone.`)) {
        return;
    }
    await window.apiRequest(`/api/admin/anime/${id}`, { method: 'DELETE' });
    loadAnime(); // Refresh the list
}

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('anime-table')) {
        initializeAnimeSection();
    }
});