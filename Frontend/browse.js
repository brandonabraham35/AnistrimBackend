// browse.js — FIX 1: Search + Genre + Status filters all working
let allAnime = [];
let currentGenre  = 'All';
let currentStatus = 'all';
let currentSearch = '';

async function initBrowse() {
  try {
    const { data } = await apiFetch('/api/anime/trending');
    allAnime = Array.isArray(data) ? data : [];
    applyFilters();
  } catch(e) {
    document.getElementById('browse-grid').innerHTML =
      '<p style="color:#9ca3af;padding:40px;text-align:center;grid-column:1/-1;">Could not load anime. Is the server running?</p>';
  }
}

// Search
function handleSearch(query) {
  currentSearch = query.toLowerCase().trim();
  applyFilters();
}
window.handleSearch = handleSearch;

// Genre filter
function filterByGenre(genre, el) {
  currentGenre = genre;
  document.querySelectorAll('.genre-filters .genre-tag-btn').forEach(b => {
    if (['All','Action','Adventure','Drama','Comedy','Mystery','Sci-Fi','Supernatural'].includes(b.textContent.trim())) {
      b.classList.remove('active');
    }
  });
  if (el) el.classList.add('active');
  applyFilters();
}
window.filterByGenre = filterByGenre;

// Status filter
function filterByStatus(status, el) {
  currentStatus = status;
  document.querySelectorAll('.genre-filters .genre-tag-btn').forEach(b => {
    if (['All Status','🟢 Airing','✅ Completed','🔜 Upcoming'].includes(b.textContent.trim())) {
      b.classList.remove('active');
    }
  });
  if (el) el.classList.add('active');
  applyFilters();
}
window.filterByStatus = filterByStatus;

// Master filter function
function applyFilters() {
  let filtered = allAnime;

  if (currentGenre !== 'All') {
    filtered = filtered.filter(a =>
      a.category === currentGenre ||
      (a.genres && a.genres.some(g => g.toLowerCase() === currentGenre.toLowerCase()))
    );
  }
  if (currentStatus !== 'all') {
    filtered = filtered.filter(a => a.status === currentStatus);
  }
  if (currentSearch) {
    filtered = filtered.filter(a =>
      a.title.toLowerCase().includes(currentSearch) ||
      (a.description && a.description.toLowerCase().includes(currentSearch))
    );
  }
  renderBrowseGrid(filtered);
}

function renderBrowseGrid(list) {
  const grid     = document.getElementById('browse-grid');
  const countEl  = document.getElementById('results-count');
  const noResult = document.getElementById('no-results');
  if (!grid) return;

  if (countEl) countEl.textContent = `${list.length} result${list.length !== 1 ? 's' : ''}`;

  if (!list.length) {
    grid.innerHTML = '';
    if (noResult) noResult.style.display = 'block';
    return;
  }
  if (noResult) noResult.style.display = 'none';

  grid.innerHTML = list.map(a => `
    <div class="browse-card" onclick="location.href='details.html?id=${a.id}'">
      <div class="browse-card-img">
        <img src="${a.cover_image}" alt="${a.title}" loading="lazy"
             onerror="this.src='https://picsum.photos/seed/${a.id}/300/450'">
        <span class="browse-card-badge">⭐ ${a.rating}</span>
        ${a.is_premium ? '<span class="browse-card-premium">👑 Premium</span>' : ''}
      </div>
      <div class="browse-card-title">${a.title}</div>
      <div class="browse-card-sub">${a.year || ''} · ${a.status || ''}</div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', initBrowse);
