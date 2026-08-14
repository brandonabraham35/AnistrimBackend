const express = require('express');
const auth = require('../middleware/auth');
const ads = require('../controllers/adsController');

const router = express.Router();

// Mobile clients fetch this at boot; now requires JWT so we can enforce plan-based ad rules.
router.get('/config', auth.protect, ads.getAdConfig);
router.put('/config', auth.protect, auth.adminOnly, ads.updateAdConfig);

// Phase 8.1: server-side ad policy (entitlement-decided, never a client flag).
router.get('/policy', auth.protect, ads.getPolicy);

// Phase 8.3: log ad impression/failure for the health dashboard.
router.post('/event', auth.protect, ads.logAdEvent);

module.exports = router;
