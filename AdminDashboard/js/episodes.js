let currentAnimeId = null;
let animeEpisodes = [];

async function manageEpisodes(animeId, animeTitle) {
    currentAnimeId = animeId;
    document.getElementById('current-anime-title').innerText = `Manage Episodes: ${animeTitle}`;
    window.showSection('episodes');
    await loadEpisodesList();
}

async function loadEpisodesList() {
    const data = await window.apiRequest(`/anime/${currentAnimeId}`);
    animeEpisodes = data.episodes || [];
    const tbody = document.querySelector('#episodes-table tbody');
    tbody.innerHTML = '';

    animeEpisodes.forEach(ep => {
        tbody.innerHTML += `
            <tr>
                <td>${ep.episode_number}</td>
                <td><img src="${ep.thumbnail_url || 'placeholder.jpg'}" width="80" style="border-radius:4px"></td>
                <td>${ep.title || 'Untitled'}</td>
                <td><span class="status-badge" style="background:#6366f1">${ep.video_status || 'ready'}</span></td>
                <td>${ep.is_premium ? '💎' : 'Free'}</td>
                <td>
                    <button class="action-btn edit-btn" onclick="editEpisode(${ep.id})"><i class="fas fa-edit"></i></button>
                    <button class="action-btn delete-btn" onclick="deleteEpisode(${ep.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    });
}

const epModal = document.getElementById('episode-modal');
document.getElementById('add-episode-btn').onclick = () => {
    document.getElementById('episode-modal-title').innerText = 'Add Episode';
    document.getElementById('episode-form').reset();
    document.getElementById('episode-id').value = '';
    document.getElementById('ep-thumb-preview').innerHTML = '';
    document.getElementById('video-status-display').innerText = '';
    epModal.style.display = 'block';
};

function editEpisode(id) {
    const ep = animeEpisodes.find(x => x.id === id);
    if (!ep) return;
    document.getElementById('episode-modal-title').innerText = 'Edit Episode';
    document.getElementById('episode-id').value = ep.id;
    document.getElementById('ep-number').value = ep.episode_number;
    document.getElementById('ep-title').value = ep.title || '';
    document.getElementById('ep-description').value = ep.description || '';
    document.getElementById('ep-is-premium').checked = !!ep.is_premium;
    document.getElementById('ep-thumb-url').value = ep.thumbnail_url || '';
    document.getElementById('ep-bunny-id').value = ep.bunny_video_id || '';
    document.getElementById('ep-playback-url').value = ep.playback_url || '';
    document.getElementById('ep-embed-url').value = ep.embed_url || '';

    if (ep.thumbnail_url) document.getElementById('ep-thumb-preview').innerHTML = `<img src="${ep.thumbnail_url}">`;
    document.getElementById('video-status-display').innerText = `Status: ${ep.video_status || 'unknown'}`;

    epModal.style.display = 'block';
}

async function deleteEpisode(id) {
    if (confirm('Delete this episode?')) {
        await window.apiRequest(`/admin/episodes/${id}`, { method: 'DELETE' });
        loadEpisodesList();
    }
}

// Video Upload to Bunny Stream
document.getElementById('ep-video-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const progress = document.getElementById('video-upload-progress');
    const fill = progress.querySelector('.progress-fill');
    const status = document.getElementById('video-status-display');

    progress.style.display = 'block';
    fill.style.width = '0%';
    status.innerText = 'Uploading to Bunny Stream...';

    try {
        const formData = new FormData();
        formData.append('video', file);
        formData.append('title', document.getElementById('ep-title').value || `Ep ${document.getElementById('ep-number').value}`);

        const data = await window.apiRequest('/admin/upload/video', {
            method: 'POST',
            body: formData
        });

        document.getElementById('ep-bunny-id').value = data.bunny_video_id;
        document.getElementById('ep-playback-url').value = data.playback_url;
        document.getElementById('ep-embed-url').value = data.embed_url;

        fill.style.width = '100%';
        status.innerText = 'Uploaded! Processing...';

        // Start polling status
        pollVideoStatus(data.bunny_video_id);
    } catch (err) {
        status.innerText = 'Upload failed: ' + err.message;
    }
};

async function pollVideoStatus(videoId) {
    const statusDisplay = document.getElementById('video-status-display');
    const interval = setInterval(async () => {
        try {
            const data = await window.apiRequest(`/admin/videos/${videoId}/status`);
            statusDisplay.innerText = `Status: ${data.status} (${data.progress || 0}%)`;
            if (data.status === 'ready' || data.status === 'failed') {
                clearInterval(interval);
            }
        } catch (e) { clearInterval(interval); }
    }, 5000);
}

// Thumbnail Upload
document.getElementById('ep-thumb-file').onchange = async (e) => {
    if (!e.target.files[0]) return;
    const formData = new FormData();
    formData.append('image', e.target.files[0]);
    const data = await window.apiRequest('/admin/upload/thumbnails', { method: 'POST', body: formData });
    document.getElementById('ep-thumb-url').value = data.url;
    document.getElementById('ep-thumb-preview').innerHTML = `<img src="${data.url}">`;
};

document.getElementById('episode-form').onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('episode-id').value;
    const body = {
        episode_number: parseInt(document.getElementById('ep-number').value),
        title: document.getElementById('ep-title').value,
        description: document.getElementById('ep-description').value,
        is_premium: document.getElementById('ep-is-premium').checked ? 1 : 0,
        thumbnail_url: document.getElementById('ep-thumb-url').value,
        bunny_video_id: document.getElementById('ep-bunny-id').value,
        playback_url: document.getElementById('ep-playback-url').value,
        embed_url: document.getElementById('ep-embed-url').value,
        video_status: document.getElementById('video-status-display').innerText.replace('Status: ', '').split(' ')[0]
    };

    await window.apiRequest(id ? `/admin/episodes/${id}` : `/admin/anime/${currentAnimeId}/episodes`, {
        method: id ? 'PUT' : 'POST',
        body
    });
    epModal.style.display = 'none';
    loadEpisodesList();
};

document.getElementById('back-to-anime-btn').onclick = () => window.showSection('anime');
epModal.querySelector('.close-modal').onclick = () => epModal.style.display = 'none';

window.manageEpisodes = manageEpisodes;
window.editEpisode = editEpisode;
window.deleteEpisode = deleteEpisode;
