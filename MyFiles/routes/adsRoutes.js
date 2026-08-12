const express = require('express');
const auth = require('../middleware/auth');
const ads = require('../controllers/adsController');

const router = express.Router();

// Mobile clients fetch this at boot; now requires JWT so we can enforce plan-based ad rules.
router.get('/config', auth.protect, ads.getAdConfig);
router.put('/config', auth.protect, auth.adminOnly, ads.updateAdConfig);

module.exports = router;
