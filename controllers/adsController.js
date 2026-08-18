const db = require('../config/db');
const { getEntitlement } = require('../utils/episodeAccess');

const toBoolean = value => value === true || value === 1 || value === '1' || value === 'true';
const GRANTING_STATES = new Set(['trialing', 'active', 'grace']);

// Ad unit ID format: alphanumeric + / - _ : . (1-190 chars). Matches AdMob-style IDs.
const UNIT_ID_RE = /^[A-Za-z0-9\/\-_:.]{1,190}$/;

// Integer range validators (inclusive).
const INT_RANGES = {
  interstitialClicksBetween: [1, 100],
  interstitialFrequencyCap: [1, 20],
  interstitialEveryNEpisodes: [1, 50],
  preRollFrequencyCap: [1, 20],
  preRollSkippableAfterSec: [0, 30],
  preRollMaxDurationSec: [5, 60],
};

// Whitelist of accepted update keys → { column, type, validate }.
// Unknown keys are rejected (400) so a typo can never silently no-op.
const UPDATE_FIELDS = {
  bannerEnabled:            { column: 'banner_enabled',            type: 'bool' },
  bannerUnitId:             { column: 'banner_unit_id',            type: 'unitId' },
  interstitialEnabled:      { column: 'interstitial_enabled',      type: 'bool' },
  interstitialClicksBetween:{ column: 'interstitial_clicks_between', type: 'int', range: INT_RANGES.interstitialClicksBetween },
  interstitialFrequencyCap: { column: 'interstitial_frequency_cap', type: 'int', range: INT_RANGES.interstitialFrequencyCap },
  interstitialEveryNEpisodes:{ column: 'interstitial_every_n_episodes', type: 'int', range: INT_RANGES.interstitialEveryNEpisodes },
  preRollEnabled:           { column: 'pre_roll_enabled',          type: 'bool' },
  preRollUnitId:            { column: 'pre_roll_unit_id',          type: 'unitId' },
  preRollFrequencyCap:      { column: 'pre_roll_frequency_cap',    type: 'int', range: INT_RANGES.preRollFrequencyCap },
  preRollSkippableAfterSec: { column: 'pre_roll_skippable_after_sec', type: 'int', range: INT_RANGES.preRollSkippableAfterSec },
  preRollMaxDurationSec:    { column: 'pre_roll_max_duration_sec', type: 'int', range: INT_RANGES.preRollMaxDurationSec },
};

// Serialize the FULL ads_config row (all placement + policy fields).
// Premium users always get all ads disabled — never serve ads to paying users.
const serialize = (row, isPremium) => {
  const base = {
    id: row?.id || 1,
    bannerEnabled: toBoolean(row?.banner_enabled),
    bannerUnitId: row?.banner_unit_id || null,
    interstitialEnabled: toBoolean(row?.interstitial_enabled),
    interstitialClicksBetween: Number(row?.interstitial_clicks_between || 3),
    interstitialFrequencyCap: Number(row?.interstitial_frequency_cap || 2),
    interstitialEveryNEpisodes: Number(row?.interstitial_every_n_episodes || 3),
    preRollEnabled: toBoolean(row?.pre_roll_enabled),
    preRollUnitId: row?.pre_roll_unit_id || null,
    preRollFrequencyCap: Number(row?.pre_roll_frequency_cap || 2),
    preRollSkippableAfterSec: Number(row?.pre_roll_skippable_after_sec || 5),
    preRollMaxDurationSec: Number(row?.pre_roll_max_duration_sec || 15),
    updatedAt: row?.updated_at || null,
  };
  if (isPremium) {
    return { ...base, bannerEnabled: false, interstitialEnabled: false, preRollEnabled: false };
  }
  return base;
};

async function fetchConfig() {
  const [rows] = await db.query('SELECT * FROM ads_config WHERE id = 1');
  return rows[0] || null;
}

exports.getAdConfig = async (req, res) => {
  try {
    const config = await fetchConfig();

    // Prompt 4: Determine premium from the authoritative entitlement read path,
    // not the stale req.user.isPremium JWT claim.
    let isPremium = false;
    try {
      const { getEntitlement } = require('../utils/episodeAccess');
      const ent = await getEntitlement(req.userId ?? req.user?.id);
      isPremium = !!(ent && ent.isPremium && ['trialing', 'active', 'grace'].includes(ent.state));
    } catch (e) {
      console.warn('[Ads] Entitlement check failed (treat as free):', e.message);
    }

    // If no config row exists at all, return a hard-coded disabled config for premium
    // or a 503 for free users (admin should initialize it).
    if (!config) {
      if (isPremium) {
        return res.json(serialize(null, true));
      }
      return res.status(503).json({ message: 'Ads configuration has not been initialized.' });
    }

    // Serialize the config with premium override.
    return res.json(serialize(config, isPremium));
  } catch (error) {
    console.error('Unable to read ads configuration:', error.message);
    return res.status(500).json({ message: 'Unable to load ads configuration.' });
  }
};

exports.updateAdConfig = async (req, res) => {
  const body = req.body || {};

  // Reject unknown keys so a typo can never silently no-op.
  const unknown = Object.keys(body).filter(k => !(k in UPDATE_FIELDS));
  if (unknown.length) {
    return res.status(400).json({ message: `Unknown ads config field(s): ${unknown.join(', ')}` });
  }

  const updates = [];
  const values = [];
  for (const [key, spec] of Object.entries(UPDATE_FIELDS)) {
    if (!(key in body)) continue;
    const value = body[key];

    if (spec.type === 'bool') {
      updates.push(`${spec.column} = ?`);
      values.push(toBoolean(value) ? 1 : 0);
    } else if (spec.type === 'unitId') {
      if (value === null || value === undefined || value === '') {
        updates.push(`${spec.column} = NULL`);
      } else {
        const s = String(value);
        if (!UNIT_ID_RE.test(s)) {
          return res.status(400).json({ message: `${key} must match /^[A-Za-z0-9\\/\\-_:.]{1,190}$/` });
        }
        updates.push(`${spec.column} = ?`);
        values.push(s);
      }
    } else if (spec.type === 'int') {
      const n = Number(value);
      const [min, max] = spec.range;
      if (!Number.isInteger(n) || n < min || n > max) {
        return res.status(400).json({ message: `${key} must be an integer between ${min} and ${max}.` });
      }
      updates.push(`${spec.column} = ?`);
      values.push(n);
    }
  }

  if (!updates.length) {
    return res.status(400).json({ message: 'No ads configuration fields were provided.' });
  }

  try {
    await db.query(`UPDATE ads_config SET ${updates.join(', ')} WHERE id = 1`, values);
    const config = await fetchConfig();
    if (!config) {
      return res.status(500).json({ message: 'Ads configuration row is missing after update.' });
    }
    return res.json(serialize(config, false));
  } catch (error) {
    console.error('Unable to update ads configuration:', error.message);
    return res.status(500).json({ message: 'Unable to update ads configuration.' });
  }
};

// ── Phase 8.1: GET /api/ads/policy?context=home|details|player ──
// Decided SERVER-SIDE from getEntitlement() — never a client flag.
// Premium users => { ads: [] }. Free users => resolved placements from ads_config.
exports.getPolicy = async (req, res) => {
  try {
    const context = req.query.context || 'home';
    const userId = req.userId ?? req.user?.id;

    // Authoritative server-side entitlement (not req.user.isPremium).
    let entitlement = { isPremium: false };
    if (userId) {
      entitlement = await getEntitlement(userId);
    }
    const isPremium = entitlement.isPremium && GRANTING_STATES.has(entitlement.state);

    // Premium users always get empty ads AND ad modules are never initialised.
    if (isPremium) {
      return res.json({ ads: [], session: null });
    }

    const config = await fetchConfig();
    if (!config) {
      return res.status(503).json({ message: 'Ads configuration has not been initialized.' });
    }

    const ads = [];
    // Player placements (pre_roll, mid_roll).
    if (context === 'player') {
      if (toBoolean(config.pre_roll_enabled) && config.pre_roll_unit_id) {
        ads.push({
          slot: 'pre_roll',
          provider: 'admob',
          unitId: config.pre_roll_unit_id,
          frequencyCapPerHour: Number(config.pre_roll_frequency_cap) || 2,
          skippableAfterSec: Number(config.pre_roll_skippable_after_sec) || 5,
          maxDurationSec: Number(config.pre_roll_max_duration_sec) || 15,
        });
      }
    } else if (context === 'home' || context === 'details') {
      if (toBoolean(config.banner_enabled)) {
        ads.push({ slot: 'banner', provider: 'admob', unitId: config.banner_unit_id || null });
      }
    }

    const session = {
      interstitialEveryNEpisodes: Number(config.interstitial_every_n_episodes || 3),
      interstitialEnabled: toBoolean(config.interstitial_enabled),
      interstitialFrequencyCap: Number(config.interstitial_frequency_cap) || 2,
    };

    return res.json({ ads, session });
  } catch (error) {
    console.error('Unable to build ads policy:', error.message);
    return res.status(500).json({ message: 'Unable to load ads policy.' });
  }
};

// ── Phase 8.3: POST /api/ads/event — log impression/failure ──
exports.logAdEvent = async (req, res) => {
  const { provider, slot, event, context, detail } = req.body || {};
  const valid = ['impression', 'click', 'fail', 'skip', 'timeout'];
  if (!valid.includes(event)) return res.status(400).json({ message: 'Invalid ad event.' });
  try {
    const userId = req.userId ?? req.user?.id ?? null;
    await db.query(
      `INSERT INTO ad_events (user_id, provider, slot, event, context, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, provider || null, slot || null, event, context || null, detail || null]
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Unable to log ad event:', error.message);
    return res.status(500).json({ message: 'Unable to log ad event.' });
  }
};