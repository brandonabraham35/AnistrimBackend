async function initGenres() {
    const genres = await window.apiRequest('/admin/genres');
    const tbody = document.querySelector('#genres-table tbody');
    tbody.innerHTML = '';
    genres.forEach(g => {
        tbody.innerHTML += `<tr><td>${g.name}</td><td><button class="action-btn delete-btn" onclick="deleteGenre(${g.id})">Delete</button></td></tr>`;
    });
}

document.getElementById('genre-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('genre-name').value;
    await window.apiRequest('/admin/genres', { method: 'POST', body: { name } });
    document.getElementById('genre-name').value = '';
    initGenres();
};

async function deleteGenre(id) {
    if (confirm('Delete genre?')) {
        await window.apiRequest(`/admin/genres/${id}`, { method: 'DELETE' });
        initGenres();
    }
}

window.initGenres = initGenres;
window.deleteGenre = deleteGenre;
