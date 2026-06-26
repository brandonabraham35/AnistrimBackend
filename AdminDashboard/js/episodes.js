let currentAnimeId = null;

async function manageEpisodes(animeId, animeTitle) {
    currentAnimeId = animeId;
    document.getElementById('current-anime-title').innerText = `Episodes for: ${animeTitle}`;
    window.showSection('episodes');
    await loadEpisodes();
}

let allEpisodes = [];

async function loadEpisodes() {
    try {
        const data = await window.apiRequest(`/anime/${currentAnimeId}`);
        allEpisodes = data.episodes || [];
        const tbody = document.querySelector('#episodes-table tbody');
        tbody.innerHTML = '';

        allEpisodes.forEach(ep => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${ep.episode_number}</td>
                <td><img src="${ep.thumbnail_url || 'placeholder.jpg'}" width="80" height="45" style="object-fit: cover;"></td>
                <td>${ep.title || 'No Title'}</td>
                <td>${ep.is_premium ? '⭐' : 'Free'}</td>
                <td>
                    <button class="action-btn edit-btn" onclick="openEditEpisode(${ep.id})">Edit</button>
                    <button class="action-btn delete-btn" onclick="deleteEpisode(${ep.id})">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load episodes:', err);
    }
}

async function deleteEpisode(id) {
    if (!confirm('Delete this episode?')) return;
    try {
        await window.apiRequest(`/admin/episodes/${id}`, { method: 'DELETE' });
        loadEpisodes();
    } catch (err) {
        alert(err.message);
    }
}

// Modal handling
const epModal = document.getElementById('episode-modal');
const epForm = document.getElementById('episode-form');
const closeEpModal = epModal.querySelector('.close-modal');

document.getElementById('add-episode-btn').addEventListener('click', () => {
    document.getElementById('episode-modal-title').innerText = 'Add Episode';
    epForm.reset();
    document.getElementById('episode-id').value = '';
    document.getElementById('ep-thumb-preview').innerHTML = '';
    epModal.style.display = 'block';
});

closeEpModal.onclick = () => epModal.style.display = 'none';
window.addEventListener('click', (e) => { if (e.target == epModal) epModal.style.display = 'none'; });

function editEpisode(ep) {
    document.getElementById('episode-modal-title').innerText = 'Edit Episode';
    document.getElementById('episode-id').value = ep.id;
    document.getElementById('ep-number').value = ep.episode_number;
    document.getElementById('ep-title').value = ep.title || '';
    document.getElementById('ep-video-url').value = ep.video_url || '';
    document.getElementById('ep-duration').value = ep.duration_sec || '';
    document.getElementById('ep-description').value = ep.description || '';
    document.getElementById('ep-is-premium').checked = !!ep.is_premium;
    document.getElementById('ep-thumb-url').value = ep.thumbnail_url || '';

    if (ep.thumbnail_url) document.getElementById('ep-thumb-preview').innerHTML = `<img src="${ep.thumbnail_url}" width="150">`;

    epModal.style.display = 'block';
}

// Thumbnail upload
document.getElementById('ep-thumb-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        document.getElementById('ep-thumb-preview').innerText = 'Uploading...';
        const formData = new FormData();
        formData.append('image', file);
        const data = await window.apiRequest('/admin/upload/thumbnails', {
            method: 'POST',
            body: formData
        });
        const url = data.url || data.imageUrl || data.image_url || data.secure_url || data.path;
        document.getElementById('ep-thumb-url').value = url;
        document.getElementById('ep-thumb-preview').innerHTML = `<img src="${url}" width="150">`;
    } catch (err) {
        alert('Upload failed: ' + err.message);
    }
});

epForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('episode-id').value;
    const epData = {
        episode_number: parseInt(document.getElementById('ep-number').value),
        title: document.getElementById('ep-title').value,
        video_url: document.getElementById('ep-video-url').value,
        duration_sec: parseInt(document.getElementById('ep-duration').value) || 0,
        description: document.getElementById('ep-description').value,
        is_premium: document.getElementById('ep-is-premium').checked ? 1 : 0,
        thumbnail_url: document.getElementById('ep-thumb-url').value
    };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `/admin/episodes/${id}` : `/admin/anime/${currentAnimeId}/episodes`;
        await window.apiRequest(endpoint, {
            method,
            body: epData
        });
        epModal.style.display = 'none';
        loadEpisodes();
    } catch (err) {
        alert(err.message);
    }
});

document.getElementById('back-to-anime-btn').addEventListener('click', () => {
    window.showSection('anime');
});

function openEditEpisode(id) {
    const ep = allEpisodes.find(e => e.id === id);
    if (ep) editEpisode(ep);
}

window.manageEpisodes = manageEpisodes;
window.loadEpisodes = loadEpisodes;
window.editEpisode = editEpisode;
window.openEditEpisode = openEditEpisode;
window.deleteEpisode = deleteEpisode;
