const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Global Error Boundaries to prevent Render crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRASH PREVENTION] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('💥 [CRASH PREVENTION] Critical Uncaught Exception:', error);
});

const app = express();
const PORT = process.env.PORT || 5000;

// ─── CORS Configuration ────────────────────────────────────
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.5.50.55:3000',
  ...(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean),
]);
const localDevOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || localDevOrigin.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
}));

// ─── Standard Middleware ───────────────────────────────────
// Webhook route MUST come before express.json() so it gets raw body
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static Files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'Frontend')));
app.use('/admin', express.static(path.join(__dirname, 'AdminDashboard')));
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── Main API Endpoints ────────────────────────────────────
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/auth', require('./routes/avatarRoutes'));
app.use('/api/anime', require('./routes/animeRoutes'));
app.use('/api/watchlist', require('./routes/watchlistRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/upload', require('./routes/uploadRoutes'));
app.use('/api/download', require('./routes/downloadRoutes'));

// ─── Consumet Microservice Middleware (Optional HTTP Routes) ──
try {
  const consumetApp = require('./services/consumet/server');
  app.use('/consumet-api', consumetApp);
  console.log('✅ Consumet microservice mounted at /consumet-api');
} catch (err) {
  console.log('ℹ️ Consumet running purely in-memory via @consumet/extensions');
}

// ─── Health Check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', time: new Date(), environment: process.env.NODE_ENV || 'development' });
});

// Root route — serve the frontend entry point
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Frontend', 'index.html'));
});

// ─── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log('==================================================');
  console.log(`🚀 AniStrim2 running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log('==================================================');
});

// Start background jobs
require('./utils/premiumAutomation');

