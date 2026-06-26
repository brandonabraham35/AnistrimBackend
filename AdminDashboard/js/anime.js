async function loadAnime() {
    try {
        const animeList = await window.apiRequest('/admin/anime');
        const tbody = document.querySelector('#anime-table tbody');
        tbody.innerHTML = '';

        animeList.forEach(anime => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img src="${anime.cover_image || 'placeholder.jpg'}" width="50" height="70" style="object-fit: cover;"></td>
                <td>${anime.title}</td>
                <td>${anime.year || 'N/A'}</td>
                <td><span class="status-badge ${anime.status}">${anime.status}</span></td>
                <td>${anime.is_premium ? '⭐' : 'Free'}</td>
                <td>
                    <button class="action-btn edit-btn" onclick="editAnime(${anime.id})">Edit</button>
                    <button class="action-btn manage-btn" onclick="manageEpisodes(${anime.id}, '${anime.title.replace(/'/g, "\\'")}')">Episodes</button>
                    <button class="action-btn delete-btn" onclick="deleteAnime(${anime.id})">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load anime:', err);
    }
}

async function deleteAnime(id) {
    if (!confirm('Are you sure you want to delete this anime?')) return;
    try {
        await window.apiRequest(`/admin/anime/${id}`, { method: 'DELETE' });
        loadAnime();
    } catch (err) {
        alert(err.message);
    }
}

// Modal handling
const animeModal = document.getElementById('anime-modal');
const animeForm = document.getElementById('anime-form');
const closeModal = document.querySelector('.close-modal');

document.getElementById('add-anime-btn').addEventListener('click', () => {
    document.getElementById('anime-modal-title').innerText = 'Add Anime';
    animeForm.reset();
    document.getElementById('anime-id').value = '';
    document.getElementById('cover-preview').innerHTML = '';
    document.getElementById('banner-preview').innerHTML = '';
    animeModal.style.display = 'block';
});

closeModal.onclick = () => animeModal.style.display = 'none';
window.onclick = (e) => { if (e.target == animeModal) animeModal.style.display = 'none'; };

async function editAnime(id) {
    try {
        // We use the public getById to get full details including studio, banner etc if not in admin list
        const anime = await window.apiRequest(`/anime/${id}`);

        document.getElementById('anime-modal-title').innerText = 'Edit Anime';
        document.getElementById('anime-id').value = anime.id;
        document.getElementById('anime-title').value = anime.title;
        document.getElementById('anime-title-jp').value = anime.title_japanese || '';
        document.getElementById('anime-year').value = anime.year || '';
        document.getElementById('anime-status').value = anime.status;
        document.getElementById('anime-studio').value = anime.studio || '';
        document.getElementById('anime-rating').value = anime.rating || '';
        document.getElementById('anime-description').value = anime.description || '';
        document.getElementById('anime-is-premium').checked = !!anime.is_premium;
        document.getElementById('anime-is-featured').checked = !!anime.is_featured;

        document.getElementById('anime-cover-url').value = anime.cover_image || '';
        document.getElementById('anime-banner-url').value = anime.banner_image || '';

        if (anime.cover_image) document.getElementById('cover-preview').innerHTML = `<img src="${anime.cover_image}" width="100">`;
        if (anime.banner_image) document.getElementById('banner-preview').innerHTML = `<img src="${anime.banner_image}" width="200">`;

        animeModal.style.display = 'block';
    } catch (err) {
        alert(err.message);
    }
}

// Image uploads
async function handleFileUpload(file, endpoint) {
    const formData = new FormData();
    formData.append('image', file);
    const data = await window.apiRequest(endpoint, {
        method: 'POST',
        body: formData
    });
    return data.url || data.imageUrl || data.image_url || data.secure_url || data.path;
}

document.getElementById('anime-cover-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        document.getElementById('cover-preview').innerText = 'Uploading...';
        const url = await handleFileUpload(file, '/admin/upload/anime');
        document.getElementById('anime-cover-url').value = url;
        document.getElementById('cover-preview').innerHTML = `<img src="${url}" width="100">`;
    } catch (err) {
        alert('Upload failed: ' + err.message);
    }
});

document.getElementById('anime-banner-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        document.getElementById('banner-preview').innerText = 'Uploading...';
        const url = await handleFileUpload(file, '/admin/upload/banners');
        document.getElementById('anime-banner-url').value = url;
        document.getElementById('banner-preview').innerHTML = `<img src="${url}" width="200">`;
    } catch (err) {
        alert('Upload failed: ' + err.message);
    }
});

animeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('anime-id').value;
    const animeData = {
        title: document.getElementById('anime-title').value,
        title_japanese: document.getElementById('anime-title-jp').value,
        year: parseInt(document.getElementById('anime-year').value),
        status: document.getElementById('anime-status').value,
        studio: document.getElementById('anime-studio').value,
        rating: parseFloat(document.getElementById('anime-rating').value),
        description: document.getElementById('anime-description').value,
        is_premium: document.getElementById('anime-is-premium').checked ? 1 : 0,
        is_featured: document.getElementById('anime-is-featured').checked ? 1 : 0,
        cover_image: document.getElementById('anime-cover-url').value,
        banner_image: document.getElementById('anime-banner-url').value
    };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `/admin/anime/${id}` : '/admin/anime';
        await window.apiRequest(endpoint, {
            method,
            body: animeData
        });
        animeModal.style.display = 'none';
        loadAnime();
    } catch (err) {
        alert(err.message);
    }
});

window.loadAnime = loadAnime;
window.deleteAnime = deleteAnime;
window.editAnime = editAnime;
