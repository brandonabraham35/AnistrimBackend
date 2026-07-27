// Cloudinary-only episode helpers for dashboard variants that load this file.
// The current dashboard supplies its own modal; these exports preserve the
// established manageEpisodes(animeId, title) and loadEpisodes(animeId) hooks.
(function () {
  let currentAnimeId = null;
  let _episodes_all = []; // Local cache for episodes
  let _episodes_tbody = null; // Cached tbody element

  async function loadEpisodes(animeId = currentAnimeId) {
    if (!animeId) return [];
    currentAnimeId = animeId;
    _episodes_tbody = document.querySelector('#episodes-table tbody'); // Cache tbody
    if (!_episodes_tbody) return [];
    _episodes_tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading episodes...</td></tr>';

    try {
        _episodes_all = await window.apiRequest(`/api/admin/anime/${animeId}/episodes`);
        _renderEpisodes();
        return _episodes_all;
    } catch (error) {
        console.error(`[Episodes] Failed to load episodes for anime ${animeId}:`, error);
        _episodes_tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--danger);">Error loading episodes. Check console.</td></tr>`;
        return [];
    }
  }

  function _renderEpisodes() {
    if (!_episodes_tbody) return;

    if (_episodes_all.length === 0) {
      _episodes_tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No episodes added yet.</td></tr>';
      return;
    }

    _episodes_tbody.innerHTML = _episodes_all.map(episode => `<tr>
            <td>${episode.episode_number || '-'}</td>
            <td>${episode.thumbnail_url ? `<img src="${episode.thumbnail_url}" alt="" style="width:60px;height:40px;object-fit:cover;border-radius:6px;">` : '-'}</td>
            <td>${episode.title || 'Untitled Episode'}</td>
            <td>${episode.duration_sec ? `${episode.duration_sec} sec` : '-'}</td>
            <td>${episode.is_premium ? 'Yes' : 'No'}</td>
            <td><button class="secondary-btn" onclick="openEpisodeModal(${episode.id})">Edit</button> <button class="danger-btn" onclick="deleteEpisode(${episode.id})">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;">No episodes added yet.</td></tr>';
  }

  function manageEpisodes(animeId, animeTitle = '') {
    currentAnimeId = animeId;
    // Ensure tbody is cached when managing episodes
    if (!_episodes_tbody) {
      _episodes_tbody = document.querySelector('#episodes-table tbody');
    }

    const title = document.getElementById('current-anime-title');
    if (title) title.textContent = animeTitle ? `Episodes: ${animeTitle}` : 'Episodes';
    if (typeof window.showSection === 'function') window.showSection('episodes');
    return loadEpisodes(animeId);
  }

  async function deleteEpisode(episodeId) {
    try {
        if (!window.confirm('Delete this episode?')) return;
        await window.apiRequest(`/api/admin/episodes/${episodeId}`, { method: 'DELETE' });
        _episodes_all = _episodes_all.filter(ep => String(ep.id) !== String(episodeId));
        _renderEpisodes(); // Re-render from local cache
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
