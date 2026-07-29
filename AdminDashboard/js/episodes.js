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

  async function initializeEpisodesSection() {
    _episodes_tbody = document.querySelector('#episodes-table tbody');
    if (!_episodes_tbody) return;

    _episodes_tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading episodes...</td></tr>';
    try {
      _episodes_all = await window.apiRequest('/api/admin/episodes');
      if (!_episodes_all.length) {
        _episodes_tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No episodes added yet.</td></tr>';
        return;
      }
      _episodes_tbody.innerHTML = _episodes_all.map(episode => `<tr>
        <td><input type="checkbox" aria-label="Select episode ${episode.id}"></td>
        <td>${window._escapeHTML(episode.anime_title || 'Unknown anime')}</td>
        <td>${episode.episode_number || '-'}</td>
        <td>${window._escapeHTML(episode.title || 'Untitled Episode')}</td>
        <td>${episode.duration_sec ? `${episode.duration_sec} sec` : '-'}</td>
        <td>${episode.view_count || 0}</td>
        <td>${episode.is_premium ? 'Yes' : 'No'}</td>
      </tr>`).join('');
    } catch (error) {
      console.error('[Episodes] Failed to load all episodes:', error);
      _episodes_tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--danger);">Unable to load episodes.</td></tr>';
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
            <td>${window._escapeHTML(episode.title || 'Untitled Episode')}</td>
            <td>${episode.duration_sec ? `${episode.duration_sec} sec` : '-'}</td>
            <td>${episode.is_premium ? 'Yes' : 'No'}</td>
            <td><button class="secondary-btn" data-action="edit" data-id="${episode.id}">Edit</button> <button class="danger-btn" data-action="delete" data-id="${episode.id}">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;">No episodes added yet.</td></tr>';
  }

  function manageEpisodes(animeId, animeTitle = '') {
    currentAnimeId = animeId;
    // Ensure tbody is cached when managing episodes
    if (!_episodes_tbody) {
      _episodes_tbody = document.querySelector('#episodes-table tbody');
    }
    // Use event delegation for actions to be more secure and efficient
    if (_episodes_tbody && !_episodes_tbody.dataset.listener) {
      _episodes_tbody.addEventListener('click', _handleEpisodeTableClick);
      _episodes_tbody.dataset.listener = 'true';
    }

    const title = document.getElementById('current-anime-title');
    if (title) title.textContent = animeTitle ? `Episodes: ${window._escapeHTML(animeTitle)}` : 'Episodes';
    if (typeof window.showSection === 'function') window.showSection('episodes');
    return loadEpisodes(animeId);
  }

  function _handleEpisodeTableClick(e) {
    const target = e.target.closest('button');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id;

    if (action === 'edit') {
      if (window.openEpisodeModal) window.openEpisodeModal(id);
    } else if (action === 'delete') {
      deleteEpisode(id);
    }
  }

  async function deleteEpisode(episodeId) {
    try {
        const confirmed = await _confirm('Delete Episode', 'Delete this episode? This action cannot be undone.', 'Delete', 'Cancel');
        if (!confirmed) return;
        await window.apiRequest(`/api/admin/episodes/${episodeId}`, { method: 'DELETE' });
        _episodes_all = _episodes_all.filter(ep => String(ep.id) !== String(episodeId));
        _renderEpisodes(); // Re-render from local cache
    } catch (error) {
        console.error(`[Episodes] Failed to delete episode ${episodeId}:`, error);
        window.showToast(`Failed to delete episode: ${error.message}`, 'error');
    }
  }

  // File selection is handled by the dashboard modal. There is deliberately no
  // URL field, status polling, or provider-specific playback state here.
  window.loadEpisodes = loadEpisodes;
  window.initializeEpisodesSection = initializeEpisodesSection;
  window.manageEpisodes = manageEpisodes;
  window.deleteEpisode = deleteEpisode;
})();
