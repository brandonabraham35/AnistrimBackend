const axios = require('axios');

const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const API_KEY = process.env.BUNNY_STREAM_API_KEY;
const BASE_URL = 'https://video.bunnycdn.com/library';

async function createVideo(title) {
    try {
        const response = await axios.post(`${BASE_URL}/${LIBRARY_ID}/videos`,
            { title },
            { headers: { AccessKey: API_KEY, 'Content-Type': 'application/json' } }
        );
        return response.data.guid;
    } catch (err) {
        console.error('[BunnyStream] Create failed:', err.response?.data || err.message);
        throw new Error('Failed to create Bunny Stream video placeholder.');
    }
}

async function uploadVideoFile(videoGuid, buffer) {
    try {
        const response = await axios.put(`${BASE_URL}/${LIBRARY_ID}/videos/${videoGuid}`, buffer, {
            headers: { AccessKey: API_KEY, 'Content-Type': 'application/octet-stream' }
        });
        return response.data;
    } catch (err) {
        console.error('[BunnyStream] Upload failed:', err.response?.data || err.message);
        throw new Error('Failed to upload video file to Bunny Stream.');
    }
}

async function getVideoStatus(videoGuid) {
    try {
        const response = await axios.get(`${BASE_URL}/${LIBRARY_ID}/videos/${videoGuid}`, {
            headers: { AccessKey: API_KEY, Accept: 'application/json' }
        });
        // Status 4 = ready, 3 = processing, etc.
        const statusMap = {
            0: 'queued',
            1: 'processing',
            2: 'encoding',
            3: 'resolving',
            4: 'ready',
            5: 'failed',
            6: 'presigned_upload'
        };
        return {
            guid: response.data.guid,
            status: statusMap[response.data.status] || 'unknown',
            statusCode: response.data.status,
            progress: response.data.encodeProgress
        };
    } catch (err) {
        console.error('[BunnyStream] Status check failed:', err.response?.data || err.message);
        throw new Error('Failed to check Bunny Stream video status.');
    }
}

module.exports = {
    createVideo,
    uploadVideoFile,
    getVideoStatus
};
