// routes/avatarRoutes.js
// Mount in server.js as: app.use('/api/auth', require('./routes/avatarRoutes'));
// Provides: POST /api/auth/avatar

const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const protect = auth.protect;
const { handleImageUpload } = require('../utils/bunnyUpload');

function getUserId(req) {
  return req.user?.id || req.user?._id || req.user?.userId || req.user?.user_id || null;
}

function optionalRequire(paths) {
  for (const p of paths) {
    try { return require(p); } catch (_) {}
  }
  return null;
}

async function updateAvatarIfDbExists(userId, avatarUrl) {
  if (!userId) return;

  const db = optionalRequire(['../config/db', '../db', '../database', '../config/database']);
  if (!db) return;

  // Your MySQL schema has avatar_url, so only update that column.
  // The old code used PostgreSQL placeholders ($1, $2), which breaks on mysql2.
  const sql = 'UPDATE users SET avatar_url = ? WHERE id = ?';

  try {
    if (typeof db.execute === 'function') {
      await db.execute(sql, [avatarUrl, userId]);
      return;
    }
    if (typeof db.query === 'function') {
      await db.query(sql, [avatarUrl, userId]);
      return;
    }
    if (typeof db.run === 'function') {
      await new Promise((resolve, reject) => db.run(sql, [avatarUrl, userId], err => err ? reject(err) : resolve()));
    }
  } catch (err) {
    console.warn('[avatarRoutes] Avatar saved but database update was skipped/failed:', err.message);
  }
}

router.post('/avatar', protect, async (req, res) => {
  // Use the handleImageUpload from bunnyUpload utility
  // We need to intercept the response to update the database
  const originalJson = res.json;
  res.json = async function (data) {
    if (data.success && (data.url || data.avatarUrl)) {
      const avatarUrl = data.url || data.avatarUrl;
      await updateAvatarIfDbExists(getUserId(req), avatarUrl);
      // Ensure the response has all the keys the frontend expects
      data.avatar = avatarUrl;
      data.avatarUrl = avatarUrl;
      data.avatar_url = avatarUrl;
    }
    return originalJson.call(this, data);
  };

  try {
    await handleImageUpload(req, res, 'avatars');
  } catch (err) {
    console.error('[avatarRoutes] Bunny upload error:', err);
    res.status(500).json({
      success: false,
      message: 'Avatar upload failed.',
      error: err.message
    });
  }
});

module.exports = router;
