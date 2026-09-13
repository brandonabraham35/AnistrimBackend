// config/validateEnv.js — production configuration validation.
//
// Fails clearly when essential production configuration is missing. Optional
// features' credentials are only required when that feature is actually enabled
// (configured) — never for features that are off.
'use strict';

// Core env vars required in production regardless of optional features.
const CORE_REQUIRED_PRODUCTION = [
  'NODE_ENV',
  'JWT_SECRET',
  'JWT_RESET_SECRET',
  'STREAM_TOKEN_SECRET',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
];

/**
 * Validate the environment.
 * @param {object} [env] - environment object (defaults to process.env).
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProd = env.NODE_ENV === 'production';

  // ── Core required (production only) ───────────────────────
  if (isProd) {
    for (const k of CORE_REQUIRED_PRODUCTION) {
      if (!env[k] || !String(env[k]).trim()) errors.push(`${k} is required in production`);
    }
  } else if (!env.NODE_ENV) {
    warnings.push('NODE_ENV is not set; defaulting to development');
  }

  // ── Optional features: require credentials only when enabled ──
  // Google OAuth: the client id and secret must be configured together.
  if (env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) {
    (isProd ? errors : warnings).push('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set');
  }
  if (!env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    (isProd ? errors : warnings).push('GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set');
  }

  // Postmark (email delivery): required in production unless test mode is on.
  if (isProd && env.POSTMARK_TEST_MODE !== 'true' && !env.POSTMARK_SERVER_TOKEN) {
    errors.push('POSTMARK_SERVER_TOKEN is required in production (email delivery), unless POSTMARK_TEST_MODE=true');
  }
  if (env.POSTMARK_SERVER_TOKEN && !env.POSTMARK_FROM_EMAIL) {
    warnings.push('POSTMARK_FROM_EMAIL is recommended when Postmark is configured');
  }

  // Pesapal: payment credentials are only required if payments are configured.
  const pesapalConfigured = env.PESAPAL_CONSUMER_KEY || env.PESAPAL_CONSUMER_SECRET || env.PESAPAL_ENV;
  if (pesapalConfigured) {
    if (!env.PESAPAL_CONSUMER_KEY) (isProd ? errors : warnings).push('PESAPAL_CONSUMER_KEY is required to enable Pesapal payments');
    if (!env.PESAPAL_CONSUMER_SECRET) (isProd ? errors : warnings).push('PESAPAL_CONSUMER_SECRET is required to enable Pesapal payments');
    if (env.PESAPAL_ENV === 'live' && !env.PESAPAL_IPN_ID) {
      warnings.push('PESAPAL_IPN_ID should be set for Pesapal live to reuse the registered IPN');
    }
  }

  // Flutterwave: require the key set if any FLW key is set.
  const flwConfigured = env.FLW_PUBLIC_KEY || env.FLW_SECRET_KEY || env.FLW_ENCRYPTION_KEY;
  if (flwConfigured) {
    if (!env.FLW_PUBLIC_KEY) (isProd ? errors : warnings).push('FLW_PUBLIC_KEY is required when Flutterwave is enabled');
    if (!env.FLW_SECRET_KEY) (isProd ? errors : warnings).push('FLW_SECRET_KEY is required when Flutterwave is enabled');
    if (!env.FLW_ENCRYPTION_KEY) (isProd ? errors : warnings).push('FLW_ENCRYPTION_KEY is required when Flutterwave is enabled');
  }

  return { errors, warnings };
}

module.exports = { validateConfig, CORE_REQUIRED_PRODUCTION };
