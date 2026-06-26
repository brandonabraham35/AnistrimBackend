let allAnime = [];

async function initAnime() {
    await loadGenresForSelect();
    await loadAnimeList();
}

async function loadGenresForSelect() {
    const genres = await window.apiRequest('/admin/genres');
    const select = document.getElementById('anime-genres');
    select.innerHTML = genres.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
}

async function loadAnimeList() {
    const q = document.getElementById('anime-search').value;
    const status = document.getElementById('anime-filter-status').value;

    let url = '/admin/anime?';
    if (q) url += `q=${q}&`;
    if (status) url += `status=${status}&`;

    const data = await window.apiRequest(url);
    allAnime = data;
    const tbody = document.querySelector('#anime-table tbody');
    tbody.innerHTML = '';

    data.forEach(a => {
        tbody.innerHTML += `
            <tr>
                <td><img src="${a.cover_image || 'placeholder.jpg'}" width="50" style="border-radius:4px"></td>
                <td>${a.title}</td>
                <td><span class="status-badge ${a.status}">${a.status}</span></td>
                <td>${a.is_premium ? '💎' : 'Free'}</td>
                <td>${a.is_featured ? '⭐' : '-'}</td>
                <td>
                    <button class="action-btn edit-btn" onclick="editAnime(${a.id})"><i class="fas fa-edit"></i></button>
                    <button class="action-btn edit-btn" style="background:#10b981" onclick="manageEpisodes(${a.id}, '${a.title.replace(/'/g, "\\'")}')"><i class="fas fa-list"></i></button>
                    <button class="action-btn delete-btn" onclick="deleteAnime(${a.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    });
}

document.getElementById('anime-search').addEventListener('input', loadAnimeList);
document.getElementById('anime-filter-status').addEventListener('change', loadAnimeList);

const animeModal = document.getElementById('anime-modal');
document.getElementById('add-anime-btn').onclick = () => {
    document.getElementById('anime-modal-title').innerText = 'Add Anime';
    document.getElementById('anime-form').reset();
    document.getElementById('anime-id').value = '';
    document.getElementById('cover-preview').innerHTML = '';
    document.getElementById('banner-preview').innerHTML = '';
    animeModal.style.display = 'block';
};

function editAnime(id) {
    const a = allAnime.find(x => x.id === id);
    if (!a) return;
    document.getElementById('anime-modal-title').innerText = 'Edit Anime';
    document.getElementById('anime-id').value = a.id;
    document.getElementById('anime-title').value = a.title;
    document.getElementById('anime-title-jp').value = a.title_japanese || '';
    document.getElementById('anime-year').value = a.year || '';
    document.getElementById('anime-status').value = a.status;
    document.getElementById('anime-studio').value = a.studio || '';
    document.getElementById('anime-rating').value = a.rating || '';
    document.getElementById('anime-tags').value = a.tags || '';
    document.getElementById('anime-description').value = a.description || '';
    document.getElementById('anime-is-premium').checked = !!a.is_premium;
    document.getElementById('anime-is-featured').checked = !!a.is_featured;
    document.getElementById('anime-cover-url').value = a.cover_image || '';
    document.getElementById('anime-banner-url').value = a.banner_image || '';

    if (a.cover_image) document.getElementById('cover-preview').innerHTML = `<img src="${a.cover_image}">`;
    if (a.banner_image) document.getElementById('banner-preview').innerHTML = `<img src="${a.banner_image}">`;

    animeModal.style.display = 'block';
}

async function deleteAnime(id) {
    if (confirm('Delete this anime?')) {
        await window.apiRequest(`/admin/anime/${id}`, { method: 'DELETE' });
        loadAnimeList();
    }
}

// Image Uploads
async function uploadImg(file, folder) {
    const formData = new FormData();
    formData.append('image', file);
    const data = await window.apiRequest(`/admin/upload/${folder}`, { method: 'POST', body: formData });
    return data.url;
}

document.getElementById('anime-cover-file').onchange = async (e) => {
    if (!e.target.files[0]) return;
    const url = await uploadImg(e.target.files[0], 'anime');
    document.getElementById('anime-cover-url').value = url;
    document.getElementById('cover-preview').innerHTML = `<img src="${url}">`;
};

document.getElementById('anime-banner-file').onchange = async (e) => {
    if (!e.target.files[0]) return;
    const url = await uploadImg(e.target.files[0], 'banners');
    document.getElementById('anime-banner-url').value = url;
    document.getElementById('banner-preview').innerHTML = `<img src="${url}">`;
};

document.getElementById('anime-form').onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('anime-id').value;
    const selectedGenres = Array.from(document.getElementById('anime-genres').selectedOptions).map(o => parseInt(o.value));

    const body = {
        title: document.getElementById('anime-title').value,
        title_japanese: document.getElementById('anime-title-jp').value,
        year: parseInt(document.getElementById('anime-year').value),
        status: document.getElementById('anime-status').value,
        studio: document.getElementById('anime-studio').value,
        rating: parseFloat(document.getElementById('anime-rating').value),
        tags: document.getElementById('anime-tags').value,
        description: document.getElementById('anime-description').value,
        is_premium: document.getElementById('anime-is-premium').checked ? 1 : 0,
        is_featured: document.getElementById('anime-is-featured').checked ? 1 : 0,
        cover_image: document.getElementById('anime-cover-url').value,
        banner_image: document.getElementById('anime-banner-url').value,
        genres: selectedGenres
    };

    await window.apiRequest(id ? `/admin/anime/${id}` : '/admin/anime', {
        method: id ? 'PUT' : 'POST',
        body
    });
    animeModal.style.display = 'none';
    loadAnimeList();
};

document.querySelector('.close-modal').onclick = () => animeModal.style.display = 'none';

window.initAnime = initAnime;
window.editAnime = editAnime;
window.deleteAnime = deleteAnime;
window.loadAnimeList = loadAnimeList;
