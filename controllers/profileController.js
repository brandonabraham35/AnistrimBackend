// controllers/profileController.js — Phase 2 profile endpoints.
//
//   GET    /api/auth/username-available?u=...     → { available, username }
//   POST   /api/profile/onboarding                → set display_name/username, avatar, genres
//   GET    /api/profile/preferences               → current preferences
//   PUT    /api/profile/preferences               → update preferences
//   DELETE /api/profile/history                   → clear watch history
const pool = require('../config/db');
const { getPreferences, upsertPreferences } = require('../services/preferencesService');
const { buildUserDto } = require('../services/userDtoService');

// ── Username uniqueness check ──────────────────────────────
exports.checkUsername = async (req, res) => {
  const { u } = req.query;
  if (!u || typeof u !== 'string') {
    return res.status(400).json({ available: false, message: 'Username is required.' });
  }
  const username = u.trim().toLowerCase();
  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ available: false, message: 'Username must be 3–32 characters.' });
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return res.status(400).json({ available: false, message: 'Username may only contain lowercase letters, numbers, and underscores.' });
  }

  try {
    const userId = req.userId ?? req.user?.id;
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId || 0]);
    const available = rows.length === 0;
    return res.json({ available, username });
  } catch (error) {
    console.error('[PROFILE] username check error:', error.message);
    return res.status(500).json({ available: false, message: 'Server error checking username.' });
  }
};

// ── Set username (optional standalone) ─────────────────────
exports.setUsername = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  const { username } = req.body;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ message: 'Username is required.' });
  }
  const normalized = username.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 32) {
    return res.status(400).json({ message: 'Username must be 3–32 characters.' });
  }
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    return res.status(400).json({ message: 'Username may only contain lowercase letters, numbers, and underscores.' });
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [normalized, userId]);
    if (existing.length) {
      return res.status(409).json({ message: 'This username is already taken.' });
    }
    await pool.query('UPDATE users SET username = ?, updated_at = NOW() WHERE id = ?', [normalized, userId]);
    return res.json({ success: true, username: normalized, message: 'Username updated.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This username is already taken.' });
    }
    console.error('[PROFILE] setUsername error:', error.message);
    return res.status(500).json({ message: 'Server error setting username.' });
  }
};

// ── Onboarding: set display_name, username, avatar (optional), genres ──
exports.onboard = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

  let { displayName, username, genres } = req.body;

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!rows.length) return res.status(404).json({ message: 'User not found.' });
    const user = rows[0];

    // Validate username if provided.
    let normalizedUsername = null;
    if (username !== undefined && username !== null && username !== '') {
      normalizedUsername = String(username).trim().toLowerCase();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 32 || !/^[a-z0-9_]+$/.test(normalizedUsername)) {
        return res.status(400).json({ message: 'Username must be 3–32 lowercase letters, numbers, or underscores.' });
      }
      const [existing] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [normalizedUsername, userId]);
      if (existing.length) {
        return res.status(409).json({ message: 'This username is already taken.' });
      }
    }

    // Validate genres (min 3).
    let cleanedGenres = [];
    if (Array.isArray(genres)) {
      cleanedGenres = genres
        .filter(g => g && typeof g === 'string')
        .slice(0, 20)
        .map(g => g.trim());
      if (cleanedGenres.length < 3) {
        return res.status(400).json({ message: 'Select at least 3 genres to personalise your feed.' });
      }
    }

    // Update profile fields + mark onboarded.
    const displayNameFinal = (displayName !== undefined && displayName !== null && String(displayName).trim())
      ? String(displayName).trim().slice(0, 80)
      : user.display_name || user.name;

    await pool.query(
      `UPDATE users
       SET display_name = ?, username = COALESCE(?, username), onboarded_at = COALESCE(onboarded_at, NOW())
       WHERE id = ?`,
      [displayNameFinal, normalizedUsername, userId]
    );

    // Seed preferences (genres used by the recommendation engine).
    if (cleanedGenres.length) {
      const current = await getPreferences(userId);
      await upsertPreferences(userId, { ...current, genres: cleanedGenres });
    }

    // Refresh the user row to return the updated DTO.
    const [freshRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const dto = await buildUserDto(freshRows[0]);
    return res.json({ success: true, user: dto, message: 'Onboarding complete.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This username is already taken.' });
    }
    console.error('[PROFILE] onboard error:', error.message);
    return res.status(500).json({ message: 'Server error during onboarding.' });
  }
};

// ── Get preferences ────────────────────────────────────────
exports.getPreferences = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
  try {
    const prefs = await getPreferences(userId);
    return res.json({ preferences: prefs });
  } catch (error) {
    console.error('[PROFILE] getPreferences error:', error.message);
    return res.status(500).json({ message: 'Server error reading preferences.' });
  }
};

// ── Update preferences ─────────────────────────────────────
exports.updatePreferences = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

  const { genres, autoplayNext, autoplayCountdown, defaultQuality, subtitlesOn, subtitleLang, playbackRate, skipIntroAuto, reduceMotion } = req.body;

  // Validate quality whitelist.
  if (defaultQuality !== undefined && !['auto', '360', '480', '720', '1080'].includes(defaultQuality)) {
    return res.status(400).json({ message: 'Invalid default quality.' });
  }
  // Validate playback rate range.
  if (playbackRate !== undefined && (Number(playbackRate) < 0.25 || Number(playbackRate) > 3)) {
    return res.status(400).json({ message: 'Playback rate must be between 0.25 and 3.' });
  }

  try {
    const prefs = await upsertPreferences(userId, {
      genres,
      autoplayNext,
      autoplayCountdown,
      defaultQuality,
      subtitlesOn,
      subtitleLang,
      playbackRate,
      skipIntroAuto,
      reduceMotion,
    });
    return res.json({ success: true, preferences: prefs });
  } catch (error) {
    console.error('[PROFILE] updatePreferences error:', error.message);
    return res.status(500).json({ message: 'Server error updating preferences.' });
  }
};

// ── Clear watch history ────────────────────────────────────
exports.clearHistory = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
  try {
    await pool.query('DELETE FROM watch_history WHERE user_id = ?', [userId]);
    return res.json({ success: true, message: 'Watch history cleared.' });
  } catch (error) {
    console.error('[PROFILE] clearHistory error:', error.message);
    return res.status(500).json({ message: 'Server error clearing history.' });
  }
};