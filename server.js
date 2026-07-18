// server.js — AniStrim2 Main Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ────────────────────────────────────────────
// File Path: server.js

// ─── Middleware ────────────────────────────────────────────
const allowedOrigins = new Set([
  'http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.5.50.55:3000',
  ...(process.env.FRONTEND_URL || '').split(',').map(origin => origin.trim()).filter(Boolean),
]);
// `npx serve` is commonly opened from another device on the same private network.
// Keep that development flow working without having to add each changing LAN IP to
// Render. Public production origins must still be declared in FRONTEND_URL.
const localDevelopmentOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || localDevelopmentOrigin.test(origin)) return callback(null, true);
    // Do not throw here: throwing turns a rejected browser origin into a noisy 500
    // and fills Render logs. The CORS middleware simply omits CORS headers instead.
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true
}));

// Webhook route MUST come before express.json() so it gets raw body
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static files ──────────────────────────────────────────
// Serve uploaded images/avatars with permissive CORS so <img> previews
// load cross-origin from the frontend without being blocked.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── API Routes ────────────────────────────────────────────
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/auth', require('./routes/avatarRoutes'));   // POST /api/auth/avatar
app.use('/api/anime', require('./routes/animeRoutes'));
app.use('/api/watchlist', require('./routes/watchlistRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/upload', require('./routes/uploadRoutes'));
app.use('/api/download', require('./routes/downloadRoutes'));
app.use('/api/admin', require('./routes/bunnyStreamRoutes'));

// ─── Health check ─────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

app.get('/', (req, res) => {
  res.json({ message: 'AniStrim API is running!', version: '2.0' });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log(`  ║  🎬 AniStrim2 running on port ${PORT}   ║`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});
