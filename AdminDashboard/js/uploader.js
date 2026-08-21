// AdminDashboard/js/uploader.js

(function() {
    function getAuthToken() {
        return localStorage.getItem('admin_token') || '';
    }

    function getUploadEndpoint(targetId) {
        const id = String(targetId || '').toLowerCase();
        if (id.includes('banner')) return '/api/admin/upload/banners';
        if (id.includes('thumb')) return '/api/admin/upload/thumbnails';
        if (id.includes('video')) return '/api/admin/upload/videos'; // Added for episodes
        return '/api/admin/upload/anime'; // Default
    }

    function buildUploader(host) {
        if (host.dataset.iuReady) return;
        host.dataset.iuReady = '1';
        const targetId = host.dataset.target;
        const hiddenInput = document.getElementById(targetId);
        if (!hiddenInput) {
            console.error(`[Uploader] Hidden input with ID "${targetId}" not found.`);
            return;
        }

        host.innerHTML = `
            <div class="iu-preview"><span>No file</span></div>
            <div class="iu-actions">
                <div class="iu-row">
                    <button type="button" class="iu-pick">Choose File</button>
                    <button type="button" class="iu-remove" style="display:none;">Remove</button>
                </div>
                <div class="iu-status">Max 15 MB</div>
                <input type="file" accept="image/*,video/*" style="display:none;">
            </div>`;

        const fileInput = host.querySelector('input[type=file]');
        const preview = host.querySelector('.iu-preview');
        const status = host.querySelector('.iu-status');
        const removeBtn = host.querySelector('.iu-remove');
        let blobUrl = null;

        function showPreview(src, label) {
            preview.innerHTML = src ? `<img src="${window._escapeHTML(src)}" alt="${window._escapeHTML(label || 'Preview')}">` : '<span>No file</span>';
            removeBtn.style.display = src ? 'inline-block' : 'none';
            status.textContent = label || 'Max 15 MB';
        }

        function setFromUrl(url) {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = null;
            hiddenInput.value = url || '';
            showPreview(url, url ? 'Saved URL' : null);
        }

        host.querySelector('.iu-pick').addEventListener('click', () => fileInput.click());
        removeBtn.addEventListener('click', () => {
            fileInput.value = '';
            setFromUrl('');
        });

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            if (file.size > 15 * 1024 * 1024) {
                alert('File is too large. Max 15 MB.');
                fileInput.value = '';
                return;
            }

            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = URL.createObjectURL(file);
            showPreview(blobUrl, 'Uploading...');

            const endpoint = getUploadEndpoint(targetId);
            const token = getAuthToken();

            try {
                if (!token) throw new Error('Not authenticated. Please log in again.');

                const fd = new FormData();
                fd.append('file', file); // Backend expects 'file' field

                const data = await window.apiRequest(endpoint, {
                    method: 'POST',
                    body: fd,
                    // apiRequest preserves this header and leaves the browser
                    // to supply the multipart Content-Type boundary.
                    headers: { 'X-Client': 'admin' }
                });

                const uploadedUrl = data.url;
                if (!uploadedUrl) throw new Error('Server response did not include a URL.');

                hiddenInput.value = uploadedUrl;
                showPreview(uploadedUrl, window._escapeHTML('Upload complete'));
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                blobUrl = null;

            } catch (e) {
                console.error('[Uploader] Upload failed:', e);
                status.textContent = `Upload failed: ${e.message}`;
                hiddenInput.value = ''; // Clear hidden input on failure
            }
        });

        host._iuSet = setFromUrl;
        if (hiddenInput.value) setFromUrl(hiddenInput.value);
    }

    function refreshAll() {
        document.querySelectorAll('.img-uploader').forEach(buildUploader);
    }

    window.refreshImagePreviews = refreshAll;
    document.addEventListener('DOMContentLoaded', refreshAll);
})();
