const express = require('express');
const multer = require('multer');
const router = express.Router();

const { uploadVideo } = require('../controllers/bunnyStreamController');
const { protect, adminOnly } = require('../middleware/auth');

const upload = multer({ dest: 'tmp/videos/' });

router.post('/upload/video', protect, adminOnly, upload.single('video'), uploadVideo);

module.exports = router;