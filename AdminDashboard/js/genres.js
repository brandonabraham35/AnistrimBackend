async function initGenres() {
    const tbody = document.querySelector('#genres-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Loading genres...</td></tr>';

    try {
        const genres = await window.apiRequest('/api/admin/genres');
        tbody.innerHTML = '';
        genres.forEach(g => {
            tbody.innerHTML += `<tr><td>${g.name}</td><td><button class="action-btn delete-btn" onclick="deleteGenre(${g.id})">Delete</button></td></tr>`;
        });
    } catch (error) {
        console.error('[Genres] Failed to load genres:', error);
        tbody.innerHTML = `<tr><td colspan="2" style="text-align:center; color: var(--danger);">Error loading genres. Check console.</td></tr>`;
    }
}

document.getElementById('genre-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('genre-name').value;
    if (!name) return;

    try {
        await window.apiRequest('/api/admin/genres', { method: 'POST', body: { name } });
        document.getElementById('genre-name').value = '';
        initGenres();
    } catch (error) {
        console.error('[Genres] Failed to add genre:', error);
        alert(`Failed to add genre: ${error.message}`);
    }
};

async function deleteGenre(id) {
    if (!confirm('Delete genre?')) return;
    try {
        await window.apiRequest(`/api/admin/genres/${id}`, { method: 'DELETE' });
        initGenres();
    } catch (error) {
        console.error(`[Genres] Failed to delete genre ${id}:`, error);
        alert(`Failed to delete genre: ${error.message}`);
    }
}

window.initGenres = initGenres;
window.deleteGenre = deleteGenre;
