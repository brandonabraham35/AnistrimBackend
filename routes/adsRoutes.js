const express = require('express');
const auth = require('../middleware/auth');
const ads = require('../controllers/adsController');

const router = express.Router();

// Mobile clients fetch this at boot; it intentionally requires no JWT.
router.get('/config', ads.getAdConfig);
router.put('/config', auth.protect, auth.adminOnly, ads.updateAdConfig);

module.exports = router;
