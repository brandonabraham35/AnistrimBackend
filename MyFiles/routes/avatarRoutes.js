// routes/avatarRoutes.js — secure avatar upload endpoint (Phase 2, item 2.2).
//
//   POST /api/auth/avatar
//   • multer memoryStorage, 5 MB limit, single 'avatar' field
//   • server sniffs magic bytes (do NOT trust mimetype)
//   • re-encodes/resizes to 512×512 webp (sharp if available)
//   • uploads to Bunny/Cloudinary under avatars/<userId>/<uuid>.webp
//   • UPDATE users.avatar_url, delete previous object
//   • returns the new URL
const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { uploadAvatarForUser, MAX_AVATAR_FILE_SIZE } = require('../services/avatarService');

const router = express.Router();

// Avatar upload: 5 MB limit, single file under 'avatar'.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    // The server sniffs magic bytes anyway; reject obvious non-images early.
    callback(null, String(file.mimetype).startsWith('image/'));
  },
}).single('avatar');

router.post('/avatar', authMiddleware.protect, (req, res) => {
  avatarUpload(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'Image too large. Max 5 MB.' });
      }
      return res.status(400).json({ success: false, message: err.message || 'Upload failed.' });
    }

    try {
      const userId = req.userId ?? req.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated.' });

      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({ success: false, message: 'No avatar file uploaded.' });
      }

      // Read the current avatar URL for deletion of the previous object.
      const [rows] = await pool.query('SELECT avatar_url FROM users WHERE id = ?', [userId]);
      const prevAvatarUrl = rows[0]?.avatar_url || null;

      const newAvatarUrl = await uploadAvatarForUser(userId, file.buffer, prevAvatarUrl);

      await pool.query('UPDATE users SET avatar_url = ?, updated_at = NOW() WHERE id = ?', [newAvatarUrl, userId]);

      return res.json({ success: true, avatar_url: newAvatarUrl, message: 'Avatar updated.' });
    } catch (e) {
      console.error('[AVATAR] Upload error:', e.message);
      const status = e.status || 502;
      return res.status(status).json({ success: false, message: e.message || 'Avatar upload failed.' });
    }
  });
});

module.exports = router;