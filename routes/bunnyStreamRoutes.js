const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const {
  uploadVideo,
  deleteVideo,
} = require('../controllers/bunnyStreamController');

const { protect, adminOnly } = require('../middleware/auth');

const uploadDir = path.join(process.cwd(), 'tmp', 'videos');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const allowedVideoTypes = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
];

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedVideoTypes.includes(file.mimetype)) {
      return cb(new Error('Only MP4, MOV, MKV, and WEBM video files are allowed.'));
    }

    cb(null, true);
  },
});

router.post(
  '/upload/video',
  protect,
  adminOnly,
  upload.single('video'),
  uploadVideo
);

router.delete(
  '/videos/:videoId',
  protect,
  adminOnly,
  deleteVideo
);

module.exports = router;
