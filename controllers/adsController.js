const db = require('../config/db');

const toBoolean = value => value === true || value === 1 || value === '1' || value === 'true';
const serialize = row => ({
  id: row.id,
  bannerEnabled: toBoolean(row.banner_enabled),
  interstitialEnabled: toBoolean(row.interstitial_enabled),
  interstitialClicksBetween: Number(row.interstitial_clicks_between),
  preRollEnabled: toBoolean(row.pre_roll_enabled),
  updatedAt: row.updated_at,
});

async function fetchConfig() {
  const [rows] = await db.query('SELECT * FROM ads_config WHERE id = 1');
  return rows[0] || null;
}

exports.getAdConfig = async (_req, res) => {
  try {
    const config = await fetchConfig();
    if (!config) return res.status(503).json({ message: 'Ads configuration has not been initialized.' });
    return res.json(serialize(config));
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
