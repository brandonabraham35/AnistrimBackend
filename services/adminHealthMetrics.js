// services/adminHealthMetrics.js — admin dashboard health/metrics aggregations.
//
// Provides the SQL-backed widgets that power the reliability views:
//   1. health history sparklines (component, status, latency_ms) from
//      health_samples — used for sparklines + "degraded since <ts>".
//   2. p50/p95 latency + 5xx/total per hour from api_request_log.
//   3. stream failures by provider + top failing episodes from stream_reports
//      (plus live providerHealthMonitor counters on the side).
//   4. failed payments by state/day from payment_events.
//   5. email failures by day from email_events.
//
// Every query is defensive: gate on the table/column existing in the live
// schema (migrations may not have run yet on some replica), and cap the
// time-window so a mis-typed hours param can't do a table scan.
const db = require('../config/db');
const streamCacheMetrics = require('./streamCacheMetrics');

const MAX_HOURS = 24 * 30; // cap the window at 30 days

function clampHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(Math.floor(n), MAX_HOURS);
}

function jsonDate(value) {
  // mysql2 returns Date objects for DATETIME; the frontend wants ISO/epoch.
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// Schema gate — memoized so repeated widget calls don't re-query per widget.
let schemaPromise = null;
async function getSchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(
      'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE()'
    ).then(([rows]) => rows.reduce((acc, r) => {
      if (!acc[r.t]) acc[r.t] = new Set();
      acc[r.t].add(r.c);
      return acc;
    }, {})).catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

const hasTable = (schema, t) => Boolean(schema[t]);
const hasCol = (schema, t, c) => Boolean(schema[t] && schema[t].has(c));

// ── 1. Health history ─────────────────────────────────────────
// component, status, latency_ms, sampled_at FROM health_samples.
// Uses idx_component_time (component, sampled_at) for the range scan.
async function getHealthHistory({ component = null, hours = 24 } = {}) {
  const schema = await getSchema();
  if (!hasTable(schema, 'health_samples')) return { component, hours, points: [], source: 'unmigrated' };

  const h = clampHours(hours);
  const params = [];
  let where = 'sampled_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)';
  params.push(h);
  if (component) {
    where += ' AND component = ?';
    params.push(component);
  }
  const [rows] = await db.query(
    `SELECT component, status, latency_ms, sampled_at
     FROM health_samples
     WHERE ${where}
     ORDER BY sampled_at ASC`,
    params
  );
  return {
    component: component || null,
    hours: h,
    points: rows.map(r => ({
      component: r.component,
      status: r.status,
      latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
      sampledAt: jsonDate(r.sampled_at),
    })),
    source: 'health_samples',
  };
}

// "degraded since <ts>" — the earliest sample where this component stopped
// being strictly 'up'. Computed client-side from the LIFO (ASC) history, so
// we return the first non-up point as degradedSince when present.
function degradedSince(points, component) {
  const target = component || null;
  const row = points.find(p => (target ? p.component === target : p.status !== 'up'));
  if (!row) return null;
  return row.sampledAt;
}

// ── 2. Latency p50/p95 + 5xx per hour ────────────────────────
// p50/p95 computed via a window function over the last `hours` (widest
// available). MySQL 8+ supports PERCENTILE via NTILE/ordered-offset.
async function getLatencyPercentiles({ hours = 24 } = {}) {
  const schema = await getSchema();
  if (!hasTable(schema, 'api_request_log')) {
    return { hours, p50: null, p95: null, samples: 0, source: 'unmigrated' };
  }

  const h = clampHours(hours);
  // Ordered-offset percentile (MySQL 8): rank by latency, pick the @p50/@p95
  // row via a window row_number. This is unbiased over the window.
  const [rows] = await db.query(
    `WITH timed AS (
       SELECT latency_ms,
              ROW_NUMBER() OVER (ORDER BY latency_ms) AS rn,
              COUNT(*) OVER () AS total
       FROM api_request_log
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     )
     SELECT
       MAX(CASE WHEN rn >= CEIL(0.50 * total) THEN latency_ms END) AS p50,
       MAX(CASE WHEN rn >= CEIL(0.95 * total) THEN latency_ms END) AS p95,
       MAX(total) AS samples
     FROM timed`,
    [h]
  );
  const row = rows[0] || {};
  return {
    hours: h,
    p50: row.p50 != null ? Number(row.p50) : null,
    p95: row.p95 != null ? Number(row.p95) : null,
    samples: Number(row.samples) || 0,
    source: 'api_request_log',
  };
}

// 5xx/total per hour bucket over the last `hours`.
async function get5xxRate({ hours = 24 } = {}) {
  const schema = await getSchema();
  if (!hasTable(schema, 'api_request_log')) {
    return { hours, buckets: [], source: 'unmigrated' };
  }

  const h = clampHours(hours);
  const [rows] = await db.query(
    `SELECT
       DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour,
       COUNT(*) AS total,
       SUM(status_code >= 500) AS server_errors
     FROM api_request_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY hour
     ORDER BY hour ASC`,
    [h]
  );
  return {
    hours: h,
    buckets: rows.map(r => ({
      hour: String(r.hour),
      total: Number(r.total) || 0,
      serverErrors: Number(r.server_errors) || 0,
    })),
    source: 'api_request_log',
  };
}

// ── 3. Stream failures by provider + top failing episodes ────
async function getStreamFailures({ hours = 24, limit = 20 } = {}) {
  const schema = await getSchema();
  const hasReports = hasTable(schema, 'stream_reports');
  const hasProvider = hasReports && hasCol(schema, 'stream_reports', 'provider');
  const hasEpisode = hasReports && hasCol(schema, 'stream_reports', 'episode_id');

  const h = clampHours(hours);
  const n = Math.min(Number(limit) || 20, 100);
  const liveMonitor = (() => {
    try {
      const monitor = require('./providerHealthMonitor');
      return monitor.getSnapshot() || null;
    } catch { return null; }
  })();

  // Provider breakdown (stream_reports grouped by best-available key).
  let byProvider = [];
  if (hasReports) {
    const providerKey = hasProvider ? 'provider' : "'unknown' AS provider";
    const [rows] = await db.query(
      `SELECT COALESCE(NULLIF(${providerKey}, ''), 'unknown') AS provider,
              COUNT(*) AS failures
       FROM stream_reports
       WHERE status = 'PENDING' AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY provider
       ORDER BY failures DESC`,
      [h]
    );
    byProvider = rows.map(r => ({ provider: r.provider || 'unknown', failures: Number(r.failures) || 0 }));
  }

  // Top failing episodes (stream_reports grouped by episode_id when available).
  let topEpisodes = [];
  if (hasReports && hasEpisode) {
    const [rows] = await db.query(
      `SELECT episode_id,
              COUNT(*) AS failures,
              MAX(sr.created_at) AS lastReportedAt,
              COALESCE(a.title, CONCAT('Episode #', sr.episode_id)) AS title
       FROM stream_reports sr
       LEFT JOIN episodes e ON e.id = sr.episode_id
       LEFT JOIN anime a ON a.id = e.anime_id
       WHERE sr.status = 'PENDING' AND sr.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND sr.episode_id IS NOT NULL
       GROUP BY sr.episode_id, title
       ORDER BY failures DESC
       LIMIT ?`,
      [h, n]
    );
    topEpisodes = rows.map(r => ({
      episodeId: r.episode_id,
      failures: Number(r.failures) || 0,
      lastReportedAt: jsonDate(r.lastReportedAt),
      title: r.title || null,
    }));
  }

  return {
    hours: h,
    limit: n,
    byProvider,
    topEpisodes,
    liveProvider: {
      provider: liveMonitor?.provider || null,
      status: liveMonitor?.status || null,
      failureRate: liveMonitor?.failureRate != null ? liveMonitor.failureRate : null,
      failureCount: liveMonitor?.counts?.failureCount != null ? liveMonitor.counts.failureCount : null,
    },
    source: 'stream_reports',
  };
}

// ── 4. Failed payments by state/day (payment_events) ─────────
async function getPaymentFailures({ hours = 24 } = {}) {
  const schema = await getSchema();
  if (!hasTable(schema, 'payment_events')) {
    return { hours, buckets: [], source: 'unmigrated' };
  }

  const h = clampHours(hours);
  // payment_events has event + payload(JSON). We classify "failure" by event
  // name and, where available, by payload.state in failed states.
  const [rows] = await db.query(
    `SELECT
       DATE(created_at) AS day,
       event,
       COUNT(*) AS count,
       SUM(
         CASE
           WHEN event LIKE 'payment.failed%' OR event LIKE 'payment.error%' OR event LIKE '%failed%' THEN 1
           ELSE 0
         END
       ) AS failed
     FROM payment_events
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY day, event
     ORDER BY day ASC, count DESC`,
    [h]
  );
  return {
    hours: h,
    buckets: rows.map(r => ({
      day: jsonDate(r.day),
      event: r.event || 'unknown',
      count: Number(r.count) || 0,
      failed: Number(r.failed) || 0,
    })),
    source: 'payment_events',
  };
}

// ── 5. Email failures by day (email_events) ──────────────────
async function getEmailFailures({ hours = 24 } = {}) {
  const schema = await getSchema();
  if (!hasTable(schema, 'email_events')) {
    return { hours, buckets: [], source: 'unmigrated' };
  }

  const h = clampHours(hours);
  const [rows] = await db.query(
    `SELECT
       DATE(created_at) AS day,
       status,
       COUNT(*) AS count
     FROM email_events
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY day, status
     ORDER BY day ASC`,
    [h]
  );
  return {
    hours: h,
    buckets: rows.map(r => ({
      day: jsonDate(r.day),
      status: r.status || 'unknown',
      count: Number(r.count) || 0,
    })),
    source: 'email_events',
  };
}

module.exports = {
  getHealthHistory,
  degradedSince,
  getLatencyPercentiles,
  get5xxRate,
  getStreamFailures,
  getPaymentFailures,
  getEmailFailures,
  getStreamCacheMetrics: () => streamCacheMetrics.getSnapshot(db),
  _clampHours: clampHours, // exposed for tests
};