// Backend/routes/uploadRoutes.js
// Rebuilt AniStrim image upload routes.
// Mount in server.js with:
//   app.use('/api/admin/upload', require('./routes/uploadRoutes'));
// Optional for normal user profile avatar uploads:
//   app.use('/api/upload', require('./routes/uploadRoutes'));

const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const { protect, adminOnly } = auth;
const {
  handleImageUpload,
  hasCloudinaryConfig,
  FIELD_NAMES,
  FOLDERS,
  MAX_FILE_SIZE,
} = require('../utils/bunnyUpload');
const cloudinaryVideoController = require('../controllers/bunnyStreamController');
const { sendSuccess } = require('../utils/response');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const videoTempDir = path.join(require('os').tmpdir(), 'anistrim-videos');
fs.mkdirSync(videoTempDir, { recursive: true });
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, videoTempDir),
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 }, // 1 GB per file, single file
  fileFilter: (_req, file, callback) => callback(null, /^video\/(mp4|quicktime|x-matroska|webm)$/.test(file.mimetype)),
});

// Abandoned temporary-file cleanup: multer writes uploaded videos to disk; if a
// request is interrupted/aborted/rejected after upload, the temp file can be
// orphaned. Sweep files older than an hour on startup and periodically.
const MAX_TEMP_AGE_MS = 60 * 60 * 1000;
function sweepVideoTempDir() {
  try {
    for (const name of fs.readdirSync(videoTempDir)) {
      const p = path.join(videoTempDir, name);
      const st = fs.statSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > MAX_TEMP_AGE_MS) fs.unlinkSync(p);
    }
  } catch (e) { /* best-effort */ }
}
sweepVideoTempDir();
setInterval(sweepVideoTempDir, 15 * 60 * 1000).unref?.();

function uploadTo(folderKey) {
  return (req, res) => handleImageUpload(req, res, folderKey);
}

router.get('/_ping', (_req, res) => {
  return sendSuccess(res, {
    ok: true,
    route: '/api/admin/upload',
    provider: 'cloudinary',
    uploadEngine: 'multer-memory-storage + cloudinary-upload-stream',
    cloudinaryConfigured: hasCloudinaryConfig(),
    maxFileSizeMb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
    acceptedFields: FIELD_NAMES,
    folders: FOLDERS,
    time: new Date().toISOString(),
  });
});

router.get('/_health', protect, (_req, res) => {
  return sendSuccess(res, {
    ok: true,
    provider: 'cloudinary',
    cloudinaryConfigured: hasCloudinaryConfig(),
    maxFileSizeMb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
    acceptedFields: FIELD_NAMES,
    folders: FOLDERS,
  });
});

// Admin dashboard uploads: add anime, edit anime, add episode thumbnail.
router.post('/', protect, adminOnly, uploadTo('anime'));
router.post('/anime', protect, adminOnly, uploadTo('anime'));
router.post('/cover', protect, adminOnly, uploadTo('anime'));
router.post('/covers', protect, adminOnly, uploadTo('anime'));
router.post('/banner', protect, adminOnly, uploadTo('banners'));
router.post('/banners', protect, adminOnly, uploadTo('banners'));
router.post('/thumbnail', protect, adminOnly, uploadTo('thumbnails'));
router.post('/thumbnails', protect, adminOnly, uploadTo('thumbnails'));

// User profile avatar uploads. These require login, but not admin.
// This fixes profile picture upload failures like the screenshot.
router.post('/avatar', protect, uploadTo('avatars'));
router.post('/profile', protect, uploadTo('profiles'));
router.post('/profile/avatar', protect, uploadTo('avatars'));

// Handle multer errors here (instead of the global 500 handler) so oversized /
// rejected uploads get a proper client error, and any temp file is left to the
// sweeper if it was written.
router.post('/video', protect, adminOnly, (req, res, next) => {
  videoUpload.single('video')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'Video too large. Max 1 GB.' });
      }
      return res.status(400).json({ success: false, message: 'Video upload failed.' });
    }
    next();
  });
}, cloudinaryVideoController.uploadVideo);

router.delete('/video/:videoId', protect, adminOnly, cloudinaryVideoController.deleteVideo);

module.exports = router;
