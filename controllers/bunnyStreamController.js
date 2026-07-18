const fs = require('fs');
const axios = require('axios');
const { createVideo, getVideoStatus: getBunnyStatus } = require('../utils/bunnyStream');

const retryable = new Set([408, 429, 500, 502, 503, 504]);

function env() {
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const cdnHostname = process.env.BUNNY_STREAM_CDN_HOSTNAME;
  if (!libraryId || !apiKey || !cdnHostname) throw new Error('Missing Bunny Stream environment variables.');
  return { libraryId, apiKey, cdnHostname: cdnHostname.replace(/^https?:\/\//, '').replace(/\/$/, '') };
}

async function uploadFile(videoId, filePath, size, libraryId, apiKey) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await axios.put(`https://video.bunnycdn.com/library/${libraryId}/videos/${videoId}`, fs.createReadStream(filePath), {
        headers: { AccessKey: apiKey, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60 * 1000,
      });
    } catch (error) {
      lastError = error;
      if (error.response && !retryable.has(error.response.status)) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
    }
  }
  const status = lastError?.response?.status;
  throw new Error(`Bunny Stream upload failed${status ? ` (HTTP ${status})` : ''}.`);
}

function responsePayload(videoId, cdnHostname, libraryId, status = 'processing') {
  const playbackUrl = `https://${cdnHostname}/${videoId}/playlist.m3u8`;
  const embedUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
  return { success: true, bunny_video_id: videoId, videoId, video_status: status, status, playback_url: playbackUrl, playbackUrl, embed_url: embedUrl, embedUrl };
}

exports.uploadVideo = async (req, res) => {
  const tempPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No video file uploaded.' });
    const { libraryId, apiKey, cdnHostname } = env();
    const videoId = await createVideo(req.body.title || req.file.originalname || 'AniStrim Video');
    await uploadFile(videoId, tempPath, req.file.size, libraryId, apiKey);
    return res.json({ ...responsePayload(videoId, cdnHostname, libraryId), message: 'Video uploaded successfully. Bunny Stream is processing it.' });
  } catch (error) {
    console.error('Bunny Stream upload error:', error.message);
    return res.status(error.status && error.status < 500 ? 502 : 503).json({ success: false, message: error.message || 'Video upload failed.' });
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(error => console.warn('Temporary video cleanup failed:', error.message));
  }
};

exports.getVideoStatus = async (req, res) => {
  try {
    const { libraryId, cdnHostname } = env();
    const status = await getBunnyStatus(req.params.videoId);
    return res.json({ ...responsePayload(req.params.videoId, cdnHostname, libraryId, status.status), raw_status: status.statusCode, encodeProgress: status.progress, progress: status.progress });
  } catch (error) {
    console.error('Bunny Stream status error:', error.message);
    return res.status(502).json({ success: false, message: error.message || 'Unable to check video status.' });
  }
};
