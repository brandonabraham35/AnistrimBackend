const db = require('../config/db');
const { getEntitlement } = require('../utils/episodeAccess');

const toBoolean = value => value === true || value === 1 || value === '1' || value === 'true';
const GRANTING_STATES = new Set(['trialing', 'active', 'grace']);
const serialize = (row, isPremium) => {
  // Premium users always get all ads disabled — never serve ads to paying users
  if (isPremium) {
    return {
      id: row?.id || 1,
      bannerEnabled: false,
      interstitialEnabled: false,
      interstitialClicksBetween: Number(row?.interstitial_clicks_between || 3),
      preRollEnabled: false,
      updatedAt: row?.updated_at || null,
    };
  }

  // Basic / free users receive the normal ad configuration from the DB
  return {
    id: row.id,
    bannerEnabled: toBoolean(row.banner_enabled),
    interstitialEnabled: toBoolean(row.interstitial_enabled),
    interstitialClicksBetween: Number(row.interstitial_clicks_between),
    preRollEnabled: toBoolean(row.pre_roll_enabled),
    updatedAt: row.updated_at,
  };
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
    // or a 503 for free users (admin should initialize it)
    if (!config) {
      if (isPremium) {
        return res.json({
          id: 1,
          bannerEnabled: false,
          interstitialEnabled: false,
          interstitialClicksBetween: 3,
          preRollEnabled: false,
          updatedAt: null,
        });
      }
      return res.status(503).json({ message: 'Ads configuration has not been initialized.' });
    }

    // Serialize the config with premium override
    return res.json(serialize(config, isPremium));
  } catch (error) {
    console.error('Unable to read ads configuration:', error.message);
    return res.status(500).json({ message: 'Unable to load ads configuration.' });
  }
};

exports.updateAdConfig = async (req, res) => {
  const { bannerEnabled, interstitialEnabled, interstitialClicksBetween, preRollEnabled } = req.body || {};
  const updates = [];
  const values = [];
  if (bannerEnabled !== undefined) { updates.push('banner_enabled = ?'); values.push(toBoolean(bannerEnabled) ? 1 : 0); }
  if (interstitialEnabled !== undefined) { updates.push('interstitial_enabled = ?'); values.push(toBoolean(interstitialEnabled) ? 1 : 0); }
  if (preRollEnabled !== undefined) { updates.push('pre_roll_enabled = ?'); values.push(toBoolean(preRollEnabled) ? 1 : 0); }
  if (interstitialClicksBetween !== undefined) {
    const clicks = Number(interstitialClicksBetween);
    if (!Number.isInteger(clicks) || clicks < 1 || clicks > 100) return res.status(400).json({ message: 'interstitialClicksBetween must be an integer between 1 and 100.' });
    updates.push('interstitial_clicks_between = ?'); values.push(clicks);
  }
  if (!updates.length) return res.status(400).json({ message: 'No ads configuration fields were provided.' });
  try {
    await db.query(`UPDATE ads_config SET ${updates.join(', ')} WHERE id = 1`, values);
    const config = await fetchConfig();
    return res.json(serialize(config));
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
