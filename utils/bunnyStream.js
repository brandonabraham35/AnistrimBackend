const axios = require('axios');

const BASE_URL = 'https://video.bunnycdn.com/library';
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function config() {
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) throw new Error('Bunny Stream is not configured. Set BUNNY_STREAM_LIBRARY_ID and BUNNY_STREAM_API_KEY.');
  return { libraryId, apiKey };
}

function isRetryable(error) {
  return !error.response || RETRYABLE_STATUSES.has(error.response.status);
}

async function withRetry(operation, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      const delay = 400 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
      console.warn(`[BunnyStream] ${label} failed (attempt ${attempt}/${attempts}); retrying in ${delay}ms.`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  const status = lastError?.response?.status;
  const detail = typeof lastError?.response?.data === 'string' ? lastError.response.data : lastError?.response?.data?.message;
  const error = new Error(detail || `Bunny Stream ${label} failed${status ? ` (HTTP ${status})` : ''}.`);
  error.status = status;
  throw error;
}

async function createVideo(title) {
  const { libraryId, apiKey } = config();
  const response = await withRetry(() => axios.post(`${BASE_URL}/${libraryId}/videos`, { title }, { headers: { AccessKey: apiKey, 'Content-Type': 'application/json' }, timeout: 30000 }), 'placeholder creation');
  if (!response.data?.guid) throw new Error('Bunny Stream did not return a video ID.');
  return response.data.guid;
}

async function uploadVideoFile(videoGuid, data) {
  const { libraryId, apiKey } = config();
  // Buffers are safely repeatable across retries. Disk-stream uploads are handled by the
  // dedicated controller route, which creates a new stream for each request.
  return withRetry(() => axios.put(`${BASE_URL}/${libraryId}/videos/${videoGuid}`, data, { headers: { AccessKey: apiKey, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60 * 1000 }), 'video upload', 3);
}

async function getVideoStatus(videoGuid) {
  const { libraryId, apiKey } = config();
  const response = await withRetry(() => axios.get(`${BASE_URL}/${libraryId}/videos/${videoGuid}`, { headers: { AccessKey: apiKey, Accept: 'application/json' }, timeout: 30000 }), 'status check', 3);
  const statusMap = { 0: 'queued', 1: 'processing', 2: 'encoding', 3: 'resolving', 4: 'ready', 5: 'failed', 6: 'presigned_upload' };
  return { guid: response.data.guid, status: statusMap[response.data.status] || 'processing', statusCode: response.data.status, progress: Number(response.data.encodeProgress) || 0 };
}

module.exports = { createVideo, uploadVideoFile, getVideoStatus };
