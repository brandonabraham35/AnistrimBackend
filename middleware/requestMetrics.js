// middleware/requestMetrics.js — per-request latency + status logging.
//
// This is the source of truth for p50/p95 latency and the 5xx/total-per-hour
// rate widgets on the admin dashboard. Every API request that passes through
// this middleware records method, path, status_code and latency_ms into
// api_request_log (best-effort — a slow/failed write must never add latency
// to, or break, the request it is measuring).
//
// Sampling is intentionally NOT applied: the widgets read "last 24 h" and a
// small fraction of traffic (~a few thousand req/day) is cheap to insert.
// If volume ever grows, apply a deterministic sample BEFORE this file grows
// unbounded — but do NOT change the widget math, which assumes an unbiased
// sample of the real request population.
const db = require('../config/db');

function requestMetrics(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const latencyMs = Date.now() - started;
    const path = (req.originalUrl || req.url || '').split('?')[0].slice(0, 255);
    // Include the per-request requestId (set by middleware/requestId) so each
    // api_request_log row can be correlated with error/observability logs.
    const requestId = req.requestId || null;
    // Fire-and-forget; the INSERT is independent of the response lifecycle.
    // Swallow/log any failure — request timing must never break the request.
    db.query(
      'INSERT INTO api_request_log (request_id, method, path, status_code, latency_ms) VALUES (?, ?, ?, ?, ?)',
      [requestId, req.method, path, res.statusCode, latencyMs]
    ).catch(err => {
      if (process.env.NODE_ENV !== 'production') {
        // Avoid flooding prod logs on every request; surface in dev only.
        console.warn('[RequestMetrics] api_request_log write failed (non-fatal):', err && err.message);
      }
    });
  });
  next();
}

module.exports = requestMetrics;