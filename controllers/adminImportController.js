const catalogue = require('../services/catalogueService');

// Protected by router.use(protect, adminOnly) in routes/adminRoutes.js.
exports.importAnime = async (req, res) => {
  const kitsuId = String(req.body?.kitsuId || '').trim();
  if (!kitsuId) return res.status(400).json({ message: 'kitsuId is required.' });
  try {
    const result = await catalogue.importFromKitsu(kitsuId);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('Kitsu anime import failed:', error.message);
    return res.status(502).json({ success: false, message: 'Unable to import anime metadata right now.' });
  }
};
