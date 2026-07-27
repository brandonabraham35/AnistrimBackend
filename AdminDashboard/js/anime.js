// AdminDashboard/js/anime.js

// This module handles the "Anime List" section of the admin dashboard.

function initializeAnimeSection() {
    console.log('[Anime] Initializing Anime management section...');
    loadAnime();

    const searchInput = document.getElementById('anime-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => loadAnime({ query: searchInput.value }));
    }
    // Note: Event listeners for add, edit, delete buttons should be added here.
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
    try {
        await window.apiRequest(`/api/admin/anime/${id}`, { method: 'DELETE' });
        loadAnime(); // Refresh the list on success
    } catch (error) {
        console.error(`[Anime] Failed to delete anime ${id}:`, error);
        alert(`Failed to delete anime: ${error.message}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('anime-table')) {
        initializeAnimeSection();
    }
});