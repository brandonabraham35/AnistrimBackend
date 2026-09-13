const fs = require('fs');
const { uploadVideo, deleteVideo } = require('../utils/bunnyStream');
const { sendSuccess } = require('../utils/response');

function responsePayload(video) {
  return {
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
    // Server-side container validation from magic bytes — never trust MIME type.
    const { sniffVideoType } = require('../utils/uploadContent');
    const header = fs.readFileSync(temporaryPath).subarray(0, 16);
    if (!sniffVideoType(header)) {
      return res.status(400).json({ success: false, message: 'Unsupported or invalid video file.' });
    }
    const video = await uploadVideo(temporaryPath);
    return sendSuccess(res, responsePayload(video), { message: 'Video uploaded successfully.' }, 201);
  } catch (error) {
    console.error('Cloudinary video upload failed:', error.message);
    return res.status(502).json({ success: false, message: 'Video upload failed.' });
  } finally {
    if (temporaryPath) fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
};

exports.deleteVideo = async (req, res) => {
  try {
    const result = await deleteVideo(req.params.videoId);
    return sendSuccess(res, { result: result.result });
  } catch (error) {
    console.error('Cloudinary video delete failed:', error.message);
    return res.status(502).json({ success: false, message: 'Unable to delete video.' });
  }
};
