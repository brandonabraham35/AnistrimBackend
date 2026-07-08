const fs = require('fs');
const fetch = require('node-fetch');

const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const API_KEY = process.env.BUNNY_STREAM_API_KEY;
const CDN_HOSTNAME = process.env.BUNNY_STREAM_CDN_HOSTNAME;

function checkBunnyEnv() {
  if (!LIBRARY_ID || !API_KEY || !CDN_HOSTNAME) {
    throw new Error('Missing Bunny Stream environment variables.');
  }
}

exports.uploadVideo = async (req, res) => {
  let tempPath = null;

  try {
    checkBunnyEnv();

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded.',
      });
    }

    tempPath = req.file.path;
    const title = req.body.title || req.file.originalname || 'AniStrim Video';

    // 1. Create video in Bunny Stream
    const createRes = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos`,
      {
        method: 'POST',
        headers: {
          AccessKey: API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
      }
    );

    const createText = await createRes.text();

let created;
try {
  created = JSON.parse(createText);
} catch {
  console.error('[BunnyStream] Create returned non-JSON:', createText);
  return res.status(502).json({
    success: false,
    message: 'Bunny Stream returned a temporary server error. Please try again later.',
    raw: createText.slice(0, 300),
  });
}

    if (!createRes.ok || !created.guid) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create Bunny Stream video.',
        error: created,
      });
    }

    const videoId = created.guid;

    // 2. Upload actual video file
    const uploadRes = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${videoId}`,
      {
        method: 'PUT',
        headers: {
          AccessKey: API_KEY,
          'Content-Type': 'application/octet-stream',
        },
        body: fs.createReadStream(tempPath),
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(500).json({
        success: false,
        message: 'Failed to upload video to Bunny Stream.',
        error: errText,
      });
    }

    return res.json({
      success: true,
      bunny_video_id: videoId,
      videoId,
      video_status: 'processing',
      status: 'processing',
      playback_url: `https://${CDN_HOSTNAME}/${videoId}/playlist.m3u8`,
      playbackUrl: `https://${CDN_HOSTNAME}/${videoId}/playlist.m3u8`,
      embed_url: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}`,
      embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}`,
      message: 'Video uploaded successfully. Bunny Stream is processing it.',
    });
  } catch (err) {
    console.error('Bunny Stream upload error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Server error during Bunny Stream upload.',
    });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupErr) {
        console.error('Failed to clean temp video file:', cleanupErr.message);
      }
    }
  }
};

exports.getVideoStatus = async (req, res) => {
  try {
    checkBunnyEnv();

    const { videoId } = req.params;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: 'Missing video ID.',
      });
    }

    const response = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${videoId}`,
      {
        method: 'GET',
        headers: {
          AccessKey: API_KEY,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: 'Failed to fetch Bunny Stream video status.',
        error: data,
      });
    }

    let readableStatus = 'processing';

    // Bunny status values can be numeric depending on API response.
    // 4 is commonly "finished/ready".
    if (data.status === 4 || data.status === 'ready' || data.status === 'finished') {
      readableStatus = 'ready';
    } else if (data.status === 5 || data.status === 'failed') {
      readableStatus = 'failed';
    }

    return res.json({
      success: true,
      videoId,
      bunny_video_id: videoId,
      raw_status: data.status,
      status: readableStatus,
      video_status: readableStatus,
      encodeProgress: data.encodeProgress || 0,
      length: data.length || null,
      availableResolutions: data.availableResolutions || null,
      thumbnailUrl: data.thumbnailUrl || null,
      playback_url: `https://${CDN_HOSTNAME}/${videoId}/playlist.m3u8`,
      embed_url: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}`,
      bunny: data,
    });
  } catch (err) {
    console.error('Bunny Stream status error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Server error while checking Bunny Stream video status.',
    });
  }
};