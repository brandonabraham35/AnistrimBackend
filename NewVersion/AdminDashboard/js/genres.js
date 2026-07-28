// AdminDashboard/js/genres.js

// --- State ---
let _genres_all = [];
let _genres_tbody = null; // Cached tbody element

/**
 * Initializes the Genres management section, fetches data, and sets up event listeners.
 */
async function initGenres() {
    _genres_tbody = document.querySelector('#genres-table tbody'); // Cache tbody
    if (!_genres_tbody) return;
    _genres_tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Loading genres...</td></tr>';

    try {
        _genres_all = await window.apiRequest('/api/admin/genres');
        _renderGenres();
    } catch (error) {
        console.error('[Genres] Failed to load genres:', error);
        _genres_tbody.innerHTML = `<tr><td colspan="2" style="text-align:center; color: var(--danger);">Error loading genres. Check console.</td></tr>`;
    }
}

/**
 * Renders the list of genres into the table.
 */
function _renderGenres() {
    if (!_genres_tbody) return;

    if (_genres_all.length === 0) {
        _genres_tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">No genres created yet.</td></tr>';
        return;
    }

    _genres_tbody.innerHTML = _genres_all.map(g => `<tr><td>${window._escapeHTML(g.name)}</td><td><button class="action-btn delete-btn" onclick="deleteGenre(${g.id})">Delete</button></td></tr>`).join('');
}

// Event listener for adding a new genre
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('genre-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('genre-name').value;
    if (!name) return;

    try {
        const newGenre = await window.apiRequest('/api/admin/genres', { method: 'POST', body: { name } });
        document.getElementById('genre-name').value = '';
        _genres_all.push(newGenre); // Add to local cache
        _renderGenres(); // Re-render from local cache
    } catch (error) {
        console.error('[Genres] Failed to add genre:', error);
        window.showToast(`Failed to add genre: ${error.message}`, 'error');
    }
    });
});

/**
 * Deletes a genre after confirmation.
 * @param {number|string} id The ID of the genre to delete.
 */
async function deleteGenre(id) {
    if (!confirm('Are you sure you want to delete this genre? This action cannot be undone.')) return;
    try {
        await window.apiRequest(`/api/admin/genres/${id}`, { method: 'DELETE' });
        _genres_all = _genres_all.filter(g => String(g.id) !== String(id)); // Remove from local cache
        _renderGenres(); // Re-render from local cache
    } catch (error) {
        console.error(`[Genres] Failed to delete genre ${id}:`, error);
        window.showToast(`Failed to delete genre: ${error.message}`, 'error');
    }
};

// Expose the initialization function globally for dashboard.js
document.addEventListener('DOMContentLoaded', () => {
    window.initializeGenresSection = initGenres;
    window.deleteGenre = deleteGenre; // Expose for onclick handlers

    // Initialize if the hash matches on page load
    if (window.location.hash === '#genres') {
        initGenres();
    }
});
