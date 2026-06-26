// AdminDashboard/js/episodes.js

let currentAnimeId = null;
let currentAnimeTitle = "";
let videoStatusTimers = {};

function getApiBase() {
  return (
    window.API_BASE ||
    window.API_URL ||
    window.API ||
    "https://anistrimbackend.onrender.com/api"
  ).replace(/\/$/, "");
}

function getAdminToken() {
  return localStorage.getItem("admin_token");
}

function setVideoStatus(message, type = "processing") {
  const status = document.getElementById("video-status-display");
  if (!status) return;

  status.className = `video-status ${type}`;
  status.innerHTML = message;
}

function setVideoProgress(percent) {
  const container = document.getElementById("video-upload-progress");
  const fill = container ? container.querySelector(".progress-fill") : null;

  if (!container || !fill) return;

  container.style.display = "block";
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function uploadThumbnailIfSelected() {
  const fileInput = document.getElementById("ep-thumb-file");
  const hiddenInput = document.getElementById("ep-thumb-url");

  if (!fileInput || !fileInput.files.length) {
    return hiddenInput ? hiddenInput.value : "";
  }

  const formData = new FormData();
  formData.append("image", fileInput.files[0]);

  const response = await fetch(`${getApiBase()}/admin/upload/thumbnails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: formData,
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(data.message || "Thumbnail upload failed.");
  }

  const url = data.url || data.imageUrl || data.image_url || data.path;

  if (!url) {
    throw new Error("Thumbnail uploaded, but no URL was returned.");
  }

  if (hiddenInput) hiddenInput.value = url;

  return url;
}

function uploadVideoWithProgress(file, title) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();

    formData.append("video", file);
    formData.append("title", title || file.name || "AniStrim Episode");

    xhr.open("POST", `${getApiBase()}/admin/upload/video`);

    xhr.setRequestHeader("Authorization", `Bearer ${getAdminToken()}`);

    xhr.upload.onprogress = function (event) {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 30);
        setVideoProgress(percent);
        setVideoStatus(`Uploading video... ${Math.round((event.loaded / event.total) * 100)}%`, "processing");
      }
    };

    xhr.onload = function () {
      let data = null;

      try {
        data = JSON.parse(xhr.responseText);
      } catch (_err) {
        return reject(new Error("Invalid response from video upload server."));
      }

      if (xhr.status < 200 || xhr.status >= 300 || data.success === false) {
        return reject(new Error(data.message || "Video upload failed."));
      }

      resolve(data);
    };

    xhr.onerror = function () {
      reject(new Error("Network error during video upload."));
    };

    xhr.send(formData);
  });
}

async function uploadVideoIfSelected() {
  const fileInput = document.getElementById("ep-video-file");

  if (!fileInput || !fileInput.files.length) {
    return null;
  }

  const title =
    document.getElementById("ep-title")?.value ||
    `Episode ${document.getElementById("ep-number")?.value || ""}`;

  setVideoProgress(0);
  setVideoStatus("Preparing upload...", "processing");

  const data = await uploadVideoWithProgress(fileInput.files[0], title);

  const bunnyId =
    data.bunny_video_id ||
    data.videoId ||
    data.video_id;

  const playbackUrl =
    data.playback_url ||
    data.playbackUrl ||
    "";

  const embedUrl =
    data.embed_url ||
    data.embedUrl ||
    "";

  if (!bunnyId) {
    throw new Error("Video uploaded, but Bunny video ID was not returned.");
  }

  document.getElementById("ep-bunny-id").value = bunnyId;
  document.getElementById("ep-playback-url").value = playbackUrl;
  document.getElementById("ep-embed-url").value = embedUrl;

  setVideoProgress(30);
  setVideoStatus("Upload complete. Bunny Stream is now encoding...", "processing");

  pollVideoStatus(bunnyId);

  return {
    bunny_video_id: bunnyId,
    video_status: "processing",
    playback_url: playbackUrl,
    embed_url: embedUrl,
  };
}

async function pollVideoStatus(videoId) {
  if (!videoId) return;

  if (videoStatusTimers[videoId]) {
    clearInterval(videoStatusTimers[videoId]);
  }

  videoStatusTimers[videoId] = setInterval(async () => {
    try {
      const data = await window.apiRequest(`/admin/videos/${videoId}/status`);

      const progress =
        data.encodeProgress ||
        data.encode_progress ||
        0;

      if (data.status === "ready" || data.video_status === "ready") {
        setVideoProgress(100);
        setVideoStatus("✅ Ready to Stream", "ready");
        clearInterval(videoStatusTimers[videoId]);
        delete videoStatusTimers[videoId];
        return;
      }

      if (data.status === "failed" || data.video_status === "failed") {
        setVideoStatus("❌ Encoding failed", "failed");
        clearInterval(videoStatusTimers[videoId]);
        delete videoStatusTimers[videoId];
        return;
      }

      const visibleProgress = Math.max(30, progress || 30);
      setVideoProgress(visibleProgress);
      setVideoStatus(`Encoding video... ${visibleProgress}%`, "processing");
    } catch (err) {
      console.error("Video status polling failed:", err);
      clearInterval(videoStatusTimers[videoId]);
      delete videoStatusTimers[videoId];
    }
  }, 5000);
}

async function loadEpisodes(animeId = currentAnimeId) {
  if (!animeId) return;

  currentAnimeId = animeId;

  const tbody = document.querySelector("#episodes-table tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6">Loading episodes...</td></tr>`;

  try {
    const episodes = await window.apiRequest(`/admin/anime/${animeId}/episodes`);

    tbody.innerHTML = "";

    if (!episodes || episodes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">No episodes added yet.</td></tr>`;
      return;
    }

    episodes.forEach((episode) => {
      const status =
        episode.video_status ||
        (episode.bunny_video_id ? "processing" : "missing");

      const statusClass =
        status === "ready"
          ? "status-ready"
          : status === "failed"
          ? "status-failed"
          : "status-processing";

      const thumbnail = episode.thumbnail_url
        ? `<img src="${episode.thumbnail_url}" style="width:60px;height:40px;object-fit:cover;border-radius:6px;">`
        : "-";

      tbody.innerHTML += `
        <tr>
          <td>${episode.episode_number || "-"}</td>
          <td>${thumbnail}</td>
          <td>${episode.title || "Untitled Episode"}</td>
          <td><span class="${statusClass}">${status}</span></td>
          <td>${episode.is_premium ? "Yes" : "No"}</td>
          <td>
            ${
              episode.embed_url
                ? `<button class="secondary-btn" onclick="previewEpisode('${episode.embed_url}')">Preview</button>`
                : ""
            }
            <button class="secondary-btn" onclick="openEpisodeModal(${episode.id})">Edit</button>
            <button class="danger-btn" onclick="deleteEpisode(${episode.id})">Delete</button>
          </td>
        </tr>
      `;

      if (episode.bunny_video_id && status !== "ready" && status !== "failed") {
        pollVideoStatus(episode.bunny_video_id);
      }
    });
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="6">Failed to load episodes.</td></tr>`;
  }
}

function resetEpisodeForm() {
  document.getElementById("episode-form").reset();
  document.getElementById("episode-id").value = "";
  document.getElementById("ep-bunny-id").value = "";
  document.getElementById("ep-playback-url").value = "";
  document.getElementById("ep-embed-url").value = "";
  document.getElementById("ep-thumb-url").value = "";

  const preview = document.getElementById("ep-thumb-preview");
  if (preview) preview.innerHTML = "";

  setVideoProgress(0);

  const progress = document.getElementById("video-upload-progress");
  if (progress) progress.style.display = "none";

  setVideoStatus("", "processing");
}

async function openEpisodeModal(episodeId = null) {
  resetEpisodeForm();

  const modal = document.getElementById("episode-modal");
  const title = document.getElementById("episode-modal-title");

  if (title) {
    title.innerText = episodeId ? "Edit Episode" : "Add Episode";
  }

  if (episodeId) {
    try {
      const episode = await window.apiRequest(`/admin/episodes/${episodeId}`);

      document.getElementById("episode-id").value = episode.id || "";
      document.getElementById("ep-number").value = episode.episode_number || "";
      document.getElementById("ep-title").value = episode.title || "";
      document.getElementById("ep-description").value = episode.description || "";
      document.getElementById("ep-is-premium").checked = !!episode.is_premium;
      document.getElementById("ep-thumb-url").value = episode.thumbnail_url || "";
      document.getElementById("ep-bunny-id").value = episode.bunny_video_id || "";
      document.getElementById("ep-playback-url").value = episode.playback_url || "";
      document.getElementById("ep-embed-url").value = episode.embed_url || "";

      if (episode.thumbnail_url) {
        document.getElementById("ep-thumb-preview").innerHTML =
          `<img src="${episode.thumbnail_url}" style="max-width:120px;border-radius:8px;">`;
      }

      if (episode.bunny_video_id) {
        setVideoProgress(episode.video_status === "ready" ? 100 : 30);
        setVideoStatus(
          episode.video_status === "ready"
            ? "✅ Ready to Stream"
            : "Video already uploaded. Checking processing status...",
          episode.video_status === "ready" ? "ready" : "processing"
        );

        if (episode.video_status !== "ready") {
          pollVideoStatus(episode.bunny_video_id);
        }
      }
    } catch (err) {
      alert(err.message || "Failed to load episode.");
    }
  }

  modal.style.display = "block";
}

async function saveEpisode(event) {
  event.preventDefault();

  if (!currentAnimeId) {
    alert("No anime selected.");
    return;
  }

  const submitBtn = event.target.querySelector("button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "Saving...";
  }

  try {
    const uploadedVideo = await uploadVideoIfSelected();
    const thumbnailUrl = await uploadThumbnailIfSelected();

    const episodeId = document.getElementById("episode-id").value;

    const payload = {
      anime_id: currentAnimeId,
      episode_number: Number(document.getElementById("ep-number").value),
      title: document.getElementById("ep-title").value,
      description: document.getElementById("ep-description").value,
      is_premium: document.getElementById("ep-is-premium").checked ? 1 : 0,
      thumbnail_url: thumbnailUrl,
      bunny_video_id:
        uploadedVideo?.bunny_video_id ||
        document.getElementById("ep-bunny-id").value ||
        null,
      video_status:
        uploadedVideo?.video_status ||
        (document.getElementById("ep-bunny-id").value ? "processing" : null),
      playback_url:
        uploadedVideo?.playback_url ||
        document.getElementById("ep-playback-url").value ||
        null,
      embed_url:
        uploadedVideo?.embed_url ||
        document.getElementById("ep-embed-url").value ||
        null,
    };

    if (episodeId) {
      await window.apiRequest(`/admin/episodes/${episodeId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await window.apiRequest(`/admin/anime/${currentAnimeId}/episodes`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    document.getElementById("episode-modal").style.display = "none";
    await loadEpisodes(currentAnimeId);

    alert("Episode saved successfully.");
  } catch (err) {
    console.error(err);
    alert(err.message || "Failed to save episode.");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = "Save Episode";
    }
  }
}

async function deleteEpisode(episodeId) {
  if (!confirm("Delete this episode?")) return;

  try {
    await window.apiRequest(`/admin/episodes/${episodeId}`, {
      method: "DELETE",
    });

    await loadEpisodes(currentAnimeId);
  } catch (err) {
    alert(err.message || "Failed to delete episode.");
  }
}

function previewEpisode(embedUrl) {
  if (!embedUrl) {
    alert("No preview URL available yet.");
    return;
  }

  window.open(embedUrl, "_blank");
}

function initEpisodes() {
  const addBtn = document.getElementById("add-episode-btn");
  const backBtn = document.getElementById("back-to-anime-btn");
  const form = document.getElementById("episode-form");

  if (addBtn && !addBtn.dataset.bound) {
    addBtn.addEventListener("click", () => openEpisodeModal());
    addBtn.dataset.bound = "1";
  }

  if (backBtn && !backBtn.dataset.bound) {
    backBtn.addEventListener("click", () => {
      if (typeof showSection === "function") {
        showSection("anime");
      }
    });
    backBtn.dataset.bound = "1";
  }

  if (form && !form.dataset.bound) {
    form.addEventListener("submit", saveEpisode);
    form.dataset.bound = "1";
  }

  document.querySelectorAll(".close-modal").forEach((btn) => {
    if (!btn.dataset.episodeBound) {
      btn.addEventListener("click", () => {
        const modal = btn.closest(".modal");
        if (modal) modal.style.display = "none";
      });
      btn.dataset.episodeBound = "1";
    }
  });
}

function manageEpisodes(animeId, animeTitle = "") {
  currentAnimeId = animeId;
  currentAnimeTitle = animeTitle;

  const titleEl = document.getElementById("current-anime-title");
  if (titleEl) {
    titleEl.innerText = animeTitle ? `Episodes: ${animeTitle}` : "Episodes";
  }

  if (typeof showSection === "function") {
    showSection("episodes");
  }

  initEpisodes();
  loadEpisodes(animeId);
}

window.initEpisodes = initEpisodes;
window.manageEpisodes = manageEpisodes;
window.loadEpisodes = loadEpisodes;
window.openEpisodeModal = openEpisodeModal;
window.deleteEpisode = deleteEpisode;
window.previewEpisode = previewEpisode;