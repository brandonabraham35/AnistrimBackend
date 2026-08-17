// services/preferencesService.js — read/write user playback & display preferences.
//
// The user_preferences table stores per-user preferences (genres, autoplay,
// subtitle, quality, etc.) seeded by onboarding and read back into the
// canonical user DTO. All reads are defensive: missing row → sensible defaults.
const pool = require('../config/db');

// Sensible runtime defaults matching the schema.
const DEFAULT_PREFERENCES = {
  genres: [],
  autoplayNext: true,
  autoplayCountdown: 10,
  defaultQuality: 'auto',
  subtitlesOn: true,
  subtitleLang: 'en',
  playbackRate: 1.0,
  skipIntroAuto: false,
  reduceMotion: false,
};

function normalizeGenres(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Read a user's preferences, returning normalized camelCase shape.
async function getPreferences(userId) {
  const defaults = { ...DEFAULT_PREFERENCES, genres: [] };
  try {
    const [rows] = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = ?',
      [userId]
    );
    if (!rows.length) return defaults;

    const row = rows[0];
    return {
      genres: normalizeGenres(row.genres),
      autoplayNext: !!row.autoplay_next,
      autoplayCountdown: row.autoplay_countdown ?? 10,
      defaultQuality: row.default_quality || 'auto',
      subtitlesOn: !!row.subtitles_on,
      subtitleLang: row.subtitle_lang || 'en',
      playbackRate: parseFloat(row.playback_rate) || 1.0,
      skipIntroAuto: !!row.skip_intro_auto,
      reduceMotion: !!row.reduce_motion,
      updatedAt: row.updated_at || null,
    };
  } catch (e) {
    // Distinguish "no row" (fine — defaults) from "no table" (a real schema
    // problem that must not be silently masked). (Bug 9)
    if (e.code === 'ER_NO_SUCH_TABLE') {
      console.error('[Preferences] user_preferences table missing — run migrations:', e.message);
      return defaults;
    }
    // FIX 8: rethrow any other DB error so real failures surface as 500
    // instead of being silently masked as "everything is fine, defaults".
    throw e;
  }
}

// Create or update a user's preferences. Accepts a partial object.
async function upsertPreferences(userId, prefs = {}) {
  const current = await getPreferences(userId);

  const merged = {
    genres: prefs.genres !== undefined ? prefs.genres : current.genres,
    autoplayNext: prefs.autoplayNext !== undefined ? prefs.autoplayNext : current.autoplayNext,
    autoplayCountdown: prefs.autoplayCountdown !== undefined ? prefs.autoplayCountdown : current.autoplayCountdown,
    defaultQuality: prefs.defaultQuality !== undefined ? prefs.defaultQuality : current.defaultQuality,
    subtitlesOn: prefs.subtitlesOn !== undefined ? prefs.subtitlesOn : current.subtitlesOn,
    subtitleLang: prefs.subtitleLang !== undefined ? prefs.subtitleLang : current.subtitleLang,
    playbackRate: prefs.playbackRate !== undefined ? prefs.playbackRate : current.playbackRate,
    skipIntroAuto: prefs.skipIntroAuto !== undefined ? prefs.skipIntroAuto : current.skipIntroAuto,
    reduceMotion: prefs.reduceMotion !== undefined ? prefs.reduceMotion : current.reduceMotion,
  };

  await pool.query(
    `INSERT INTO user_preferences
       (user_id, genres, autoplay_next, autoplay_countdown, default_quality,
        subtitles_on, subtitle_lang, playback_rate, skip_intro_auto, reduce_motion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       genres = VALUES(genres),
       autoplay_next = VALUES(autoplay_next),
       autoplay_countdown = VALUES(autoplay_countdown),
       default_quality = VALUES(default_quality),
       subtitles_on = VALUES(subtitles_on),
       subtitle_lang = VALUES(subtitle_lang),
       playback_rate = VALUES(playback_rate),
       skip_intro_auto = VALUES(skip_intro_auto),
       reduce_motion = VALUES(reduce_motion)`,
    [
      userId,
      JSON.stringify(merged.genres),
      merged.autoplayNext ? 1 : 0,
      merged.autoplayCountdown,
      merged.defaultQuality,
      merged.subtitlesOn ? 1 : 0,
      merged.subtitleLang,
      merged.playbackRate,
      merged.skipIntroAuto ? 1 : 0,
      merged.reduceMotion ? 1 : 0,
    ]
  );

  return merged;
}

module.exports = { getPreferences, upsertPreferences, DEFAULT_PREFERENCES };