// Cloudinary-only episode helpers for dashboard variants that load this file.
// The current dashboard supplies its own modal; these exports preserve the
// established manageEpisodes(animeId, title) and loadEpisodes(animeId) hooks.
(function () {
  let currentAnimeId = null;

  async function loadEpisodes(animeId = currentAnimeId) {
    if (!animeId) return [];
    currentAnimeId = animeId;
    const episodes = await window.apiRequest(`/admin/anime/${animeId}/episodes`);
    const tbody = document.querySelector('#episodes-table tbody');
    if (tbody) {
      tbody.innerHTML = episodes.map(episode => `<tr>
        <td>${episode.episode_number || '-'}</td>
        <td>${episode.thumbnail_url ? `<img src="${episode.thumbnail_url}" alt="" style="width:60px;height:40px;object-fit:cover;border-radius:6px;">` : '-'}</td>
        <td>${episode.title || 'Untitled Episode'}</td>
        <td>${episode.duration_sec ? `${episode.duration_sec} sec` : '-'}</td>
        <td>${episode.is_premium ? 'Yes' : 'No'}</td>
        <td><button class="secondary-btn" onclick="openEpisodeModal(${episode.id})">Edit</button> <button class="danger-btn" onclick="deleteEpisode(${episode.id})">Delete</button></td>
      </tr>`).join('') || '<tr><td colspan="6">No episodes added yet.</td></tr>';
    }
    return episodes;
  }

  function manageEpisodes(animeId, animeTitle = '') {
    currentAnimeId = animeId;
    const title = document.getElementById('current-anime-title');
    if (title) title.textContent = animeTitle ? `Episodes: ${animeTitle}` : 'Episodes';
    if (typeof window.showSection === 'function') window.showSection('episodes');
    return loadEpisodes(animeId);
  }

  async function deleteEpisode(episodeId) {
    if (!window.confirm('Delete this episode?')) return;
    await window.apiRequest(`/admin/episodes/${episodeId}`, { method: 'DELETE' });
    await loadEpisodes();
  }

  // File selection is handled by the dashboard modal. There is deliberately no
  // URL field, status polling, or provider-specific playback state here.
  window.loadEpisodes = loadEpisodes;
  window.manageEpisodes = manageEpisodes;
  window.deleteEpisode = deleteEpisode;
})();
