// Backend/routes/uploadRoutes.js
// Rebuilt AniStrim image upload routes.
// Mount in server.js with:
//   app.use('/api/admin/upload', require('./routes/uploadRoutes'));
// Optional for normal user profile avatar uploads:
//   app.use('/api/upload', require('./routes/uploadRoutes'));

const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const {
  handleImageUpload,
  hasCloudinaryConfig,
  FIELD_NAMES,
  FOLDERS,
  MAX_FILE_SIZE,
} = require('../utils/bunnyUpload');
const cloudinaryVideoController = require('../controllers/bunnyStreamController');
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
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, /^video\/(mp4|quicktime|x-matroska|webm)$/.test(file.mimetype)),
});

const protect = auth.protect || auth.auth || auth.authenticate;

if (typeof protect !== 'function') {
  throw new Error('Upload route needs an auth middleware export named protect, auth, or authenticate.');
}

const adminOnly = auth.adminOnly || auth.admin || ((req, res, next) => {
  const user = req.user || {};
  const role = String(user.role || user.user_role || user.type || '').toLowerCase();
  const isAdmin =
    user.isAdmin === true || user.is_admin === true || user.admin === true ||
    user.isAdmin === 1 || user.is_admin === 1 || user.admin === 1 ||
    role === 'admin' || role === 'administrator';

  if (isAdmin) return next();

  return res.status(403).json({
    success: false,
    message: 'Admin access required.',
    code: 'ADMIN_REQUIRED',
  });
});

function uploadTo(folderKey) {
  return (req, res) => handleImageUpload(req, res, folderKey);
}

router.get('/_ping', (_req, res) => {
  res.json({
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
  res.json({
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

router.post('/video', protect, adminOnly, videoUpload.single('video'), cloudinaryVideoController.uploadVideo);

router.delete('/video/:videoId', protect, adminOnly, cloudinaryVideoController.deleteVideo);

module.exports = router;
