// Cloudinary-only episode helpers for dashboard variants that load this file.
// The current dashboard supplies its own modal; these exports preserve the
// established manageEpisodes(animeId, title) and loadEpisodes(animeId) hooks.
(function () {
  let currentAnimeId = null;

  async function loadEpisodes(animeId = currentAnimeId) {
    if (!animeId) return [];
    currentAnimeId = animeId;
    const tbody = document.querySelector('#episodes-table tbody');
    if (!tbody) return [];
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading episodes...</td></tr>';

    try {
        const episodes = await window.apiRequest(`/api/admin/anime/${animeId}/episodes`);
        tbody.innerHTML = episodes.map(episode => `<tr>
            <td>${episode.episode_number || '-'}</td>
            <td>${episode.thumbnail_url ? `<img src="${episode.thumbnail_url}" alt="" style="width:60px;height:40px;object-fit:cover;border-radius:6px;">` : '-'}</td>
            <td>${episode.title || 'Untitled Episode'}</td>
            <td>${episode.duration_sec ? `${episode.duration_sec} sec` : '-'}</td>
            <td>${episode.is_premium ? 'Yes' : 'No'}</td>
            <td><button class="secondary-btn" onclick="openEpisodeModal(${episode.id})">Edit</button> <button class="danger-btn" onclick="deleteEpisode(${episode.id})">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;">No episodes added yet.</td></tr>';
        return episodes;
    } catch (error) {
        console.error(`[Episodes] Failed to load episodes for anime ${animeId}:`, error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Error loading episodes. Check console.</td></tr>`;
        return [];
    }
  }

  function manageEpisodes(animeId, animeTitle = '') {
    currentAnimeId = animeId;
    const title = document.getElementById('current-anime-title');
    if (title) title.textContent = animeTitle ? `Episodes: ${animeTitle}` : 'Episodes';
    if (typeof window.showSection === 'function') window.showSection('episodes');
    return loadEpisodes(animeId);
  }

  async function deleteEpisode(episodeId) {
    try {
        if (!window.confirm('Delete this episode?')) return;
        await window.apiRequest(`/api/admin/episodes/${episodeId}`, { method: 'DELETE' });
        await loadEpisodes();
    } catch (error) {
        console.error(`[Episodes] Failed to delete episode ${episodeId}:`, error);
        alert(`Failed to delete episode: ${error.message}`);
    }
  }

  // File selection is handled by the dashboard modal. There is deliberately no
  // URL field, status polling, or provider-specific playback state here.
  window.loadEpisodes = loadEpisodes;
  window.manageEpisodes = manageEpisodes;
  window.deleteEpisode = deleteEpisode;
})();
