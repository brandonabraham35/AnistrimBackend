const express = require('express');
const auth = require('../middleware/auth');
const { adEventLimiter } = require('../middleware/rateLimit');
const ads = require('../controllers/adsController');

const router = express.Router();

// Mobile clients fetch this at boot; now requires JWT so we can enforce plan-based ad rules.
router.get('/config', auth.protect, ads.getAdConfig);
router.put('/config', auth.protect, auth.adminOnly, ads.updateAdConfig);

// Phase 8.1: server-side ad policy (entitlement-decided, never a client flag).
router.get('/policy', auth.protect, ads.getPolicy);

// Phase 8.3: log ad impression/failure for the health dashboard.
// Rate-limited (60 req / 5 min / user) to prevent flooding ad_events.
router.post('/event', auth.protect, adEventLimiter, ads.logAdEvent);

module.exports = router;
