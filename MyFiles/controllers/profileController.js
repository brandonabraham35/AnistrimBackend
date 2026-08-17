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
const watchController = require('./watchController');

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

    // Idempotency gate: once onboarded, do NOT let a revisit overwrite the
    // profile fields (only onboarded_at is COALESCE-protected otherwise).
    if (user.onboarded_at) {
      return res.status(400).json({ success: false, message: 'Onboarding already completed.' });
    }

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

    // Genres are REQUIRED: an array of ≥3 non-empty strings. Omitting them or
    // sending a non-array must NOT silently complete onboarding with zero genres.
    if (!Array.isArray(genres)) {
      return res.status(400).json({ message: 'Select at least 3 genres to personalise your feed.' });
    }
    const cleanedGenres = genres
      .filter(g => g && typeof g === 'string' && g.trim())
      .slice(0, 20)
      .map(g => g.trim());
    if (cleanedGenres.length < 3) {
      return res.status(400).json({ message: 'Select at least 3 genres to personalise your feed.' });
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
    const current = await getPreferences(userId);
    await upsertPreferences(userId, { ...current, genres: cleanedGenres });

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

  // ── Validation (Bug 6) ─────────────────────────────────
  // Quality whitelist.
  if (defaultQuality !== undefined && !['auto', '360', '480', '720', '1080'].includes(defaultQuality)) {
    return res.status(400).json({ message: 'Invalid default quality.' });
  }
  // playbackRate must be a finite number in [0.25, 3] (rejects "banana", NaN).
  if (playbackRate !== undefined) {
    const pr = Number(playbackRate);
    if (!Number.isFinite(pr) || pr < 0.25 || pr > 3) {
      return res.status(400).json({ message: 'Playback rate must be a number between 0.25 and 3.' });
    }
  }
  // autoplayCountdown must be an integer in [0, 60].
  if (autoplayCountdown !== undefined) {
    const ac = Number(autoplayCountdown);
    if (!Number.isInteger(ac) || ac < 0 || ac > 60) {
      return res.status(400).json({ message: 'Autoplay countdown must be an integer between 0 and 60 seconds.' });
    }
  }
  // subtitleLang must be whitelisted (FIX 8): en, es, fr, de, pt, ja, ar, none.
  const ALLOWED_SUBTITLE_LANGS = new Set(['en', 'es', 'fr', 'de', 'pt', 'ja', 'ar', 'none']);
  if (subtitleLang !== undefined) {
    if (typeof subtitleLang !== 'string' || !ALLOWED_SUBTITLE_LANGS.has(subtitleLang)) {
      return res.status(400).json({ message: 'Invalid subtitle language. Allowed: en, es, fr, de, pt, ja, ar, none.' });
    }
  }
  // genres (if provided) must be an array of strings (validate against known
  // genres is the controller's job; here enforce shape).
  if (genres !== undefined && !Array.isArray(genres)) {
    return res.status(400).json({ message: 'Genres must be an array.' });
  }
  if (Array.isArray(genres) && genres.some(g => typeof g !== 'string' || !g.trim())) {
    return res.status(400).json({ message: 'Genres must be an array of non-empty strings.' });
  }

  try {
    // Validate genres against the genres table (FIX 8).
    if (Array.isArray(genres) && genres.length) {
      const cleaned = [...new Set(genres.map(g => String(g).trim()).filter(Boolean))];
      if (cleaned.length) {
        const placeholders = cleaned.map(() => '?').join(',');
        const [genreRows] = await pool.query(
          `SELECT name FROM genres WHERE name IN (${placeholders})`,
          cleaned
        );
        const validNames = new Set(genreRows.map(r => r.name));
        const invalid = cleaned.filter(g => !validNames.has(g));
        if (invalid.length) {
          return res.status(400).json({ message: `Unknown genres: ${invalid.join(', ')}` });
        }
      }
    }

    await upsertPreferences(userId, {
      genres,
      autoplayNext,
      autoplayCountdown: autoplayCountdown !== undefined ? Number(autoplayCountdown) : undefined,
      defaultQuality,
      subtitlesOn,
      subtitleLang,
      playbackRate: playbackRate !== undefined ? Number(playbackRate) : undefined,
      skipIntroAuto,
      reduceMotion,
    });

    // FIX 8: re-read from the DB so the response reflects server state,
    // not the merged in-memory object.
    const freshPrefs = await getPreferences(userId);
    return res.json({ success: true, preferences: freshPrefs });
  } catch (error) {
    console.error('[PROFILE] updatePreferences error:', error.message);
    return res.status(500).json({ message: 'Server error updating preferences.' });
  }
};

// ── Clear watch history ────────────────────────────────────
// v31 renamed watch_history → watch_progress. Delegate to the authoritative
// watchController.clearHistory which cleans watch_progress + watch_dismissed.
exports.clearHistory = async (req, res) => {
  const userId = req.userId ?? req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
  try {
    return await watchController.clearHistory(req, res);
  } catch (error) {
    console.error('[PROFILE] clearHistory error:', error.message);
    return res.status(500).json({ message: 'Server error clearing history.' });
  }
};
