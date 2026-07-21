const fs = require('fs');
const { uploadVideo, deleteVideo } = require('../utils/bunnyStream');

function responsePayload(video) {
  return {
    success: true,
    secure_url: video.secure_url,
    video_url: video.secure_url,
    public_id: video.public_id,
    duration: video.duration,
    bytes: video.bytes,
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

exports.deleteVideo = async (req, res) => {
  try {
    const result = await deleteVideo(req.params.videoId);
    return res.json({ success: true, result: result.result });
  } catch (error) {
    return res.status(502).json({ success: false, message: error.message || 'Unable to delete video.' });
  }
};
