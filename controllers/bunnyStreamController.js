const fs = require('fs');
const { uploadVideo, getVideo, deleteVideo } = require('../utils/bunnyStream');

function responsePayload(video) {
  return {
    success: true,
    video_url: video.secure_url,
    public_id: video.public_id,
    duration: video.duration,
    bytes: video.bytes,
    status: 'ready',
    video_status: 'ready',
    // Compatibility aliases for older dashboard builds. They contain Cloudinary data.
    bunny_video_id: video.public_id,
    playback_url: video.secure_url,
    embed_url: video.secure_url,
  };
}

exports.uploadVideo = async (req, res) => {
  const temporaryPath = req.file?.path;
  try {
    if (!temporaryPath) return res.status(400).json({ success: false, message: 'No video file uploaded.' });
    const video = await uploadVideo(temporaryPath);
    return res.status(201).json({ ...responsePayload(video), message: 'Video uploaded successfully.' });
  } catch (error) {
    console.error('Cloudinary video upload failed:', error.message);
    return res.status(502).json({ success: false, message: error.message || 'Video upload failed.' });
  } finally {
    if (temporaryPath) fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
};

exports.getVideoStatus = async (req, res) => {
  try {
    const video = await getVideo(req.params.videoId);
    return res.json({ ...responsePayload(video), progress: 100, encodeProgress: 100 });
  } catch (error) {
    return res.status(error.http_code === 404 ? 404 : 502).json({ success: false, message: error.message || 'Unable to retrieve video.' });
  }
};

exports.deleteVideo = async (req, res) => {
  try {
    const result = await deleteVideo(req.params.videoId);
    return res.json({ success: true, result: result.result });
  } catch (error) {
    return res.status(502).json({ success: false, message: error.message || 'Unable to delete video.' });
  }
};
