// services/apiDtoService.js — reusable camelCase API DTO / serializer utilities.
// Public responses emit camelCase regardless of snake_case DB columns. Columns
// are never renamed. Mappers strip sensitive/internal fields (password_hash,
// verification_code, provider keys) and return NEW objects.

const USER_SENSITIVE = new Set([
  'password_hash', 'verification_code', 'otp_hash', 'otp_expires_at',
  'verification_expires', 'verification_last_sent', 'verification_attempts',
  'otp_attempts', 'refresh_token', 'token_version', 'google_refresh_token',
  'stripe_customer_id', 'reset_token', 'verification_token',
]);

const INTERNAL_ID_FIELDS = new Set([
  'cloudinary_public_id', 'banner_public_id', 'cover_public_id',
  'thumbnail_public_id', 'animeheaven_episode_key', 'consumet_id', 'mal_id',
  'anime_mappings', 'provider_episode_key', 'provider_slug',
]);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function toBool(v) {
  return v === true || v === 1 || v === '1' || (Buffer.isBuffer(v) && v[0] === 1);
}

function camel(key) {
  return String(key).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function list(mapper, rows) {
  return (rows || []).map(mapper).filter(Boolean);
}

// Anime DTO
function animeDto(row) {
  if (!row) return null;
  const cover = row.cover_image || row.poster_url || row.thumbnail_url || null;
  return {
    id: row.id,
    title: row.title,
    titleJapanese: row.title_japanese || null,
    description: row.description || null,
    coverImage: cover,
    posterUrl: cover,
    thumbnailUrl: cover,
    bannerUrl: row.banner_image || row.banner_url || null,
    rating: row.rating,
    year: row.year,
    studio: row.studio || null,
    status: row.status || 'unknown',
    viewCount: row.view_count,
    genres: row.genres || [],
    cover_image: cover,
    poster_url: cover,
    thumbnail_url: cover,
    banner_url: row.banner_image || row.banner_url || null,
  };
}

// Admin anime DTO
function adminAnimeDto(row) {
  const dto = animeDto(row);
  if (dto && Array.isArray(row.genres)) dto.genres = row.genres;
  return dto;
}

// Episode DTO
function episodeDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.episode_number,
    season: row.season || 1,
    seasonNumber: row.season || 1,
    title: row.title || null,
    description: row.description || null,
    thumbnailUrl: row.thumbnail_url || null,
    thumbnail_url: row.thumbnail_url || null,
    videoUrl: row.video_url || null,
    video_url: row.video_url || null,
    durationSec: row.duration_sec,
    duration_sec: row.duration_sec,
    viewCount: row.view_count,
    view_count: row.view_count,
    locked: !!row.locked,
    effectiveTier: row.effectiveTier || 'unknown',
    availableAt: row.availableAt || null,
    accessState: row.accessState || null,
    accessTier: row.access_tier || 'inherit',
  };
}

// Watch progress DTO
function watchProgressDto(row) {
  if (!row) return null;
  return {
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    percent: Number(row.percent) || 0,
    completed: !!row.completed,
    updatedAt: row.updated_at || null,
  };
}

// Watchlist DTO
function watchlistDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    animeId: row.anime_id,
    title: row.anime_title || row.title,
    poster: row.anime_cover || row.poster,
    status: row.status,
    episodesWatched: Number(row.episodes_watched || 0),
    totalEpisodes: Number(row.total_episodes || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

// Watchlist stats DTO
function watchlistStatsDto(row) {
  return {
    watching: Number(row?.watching || 0),
    completed: Number(row?.completed || 0),
    planToWatch: Number(row?.plan_to_watch || 0),
    plan_to_watch: Number(row?.plan_to_watch || 0),
    total: Number(row?.total || 0),
  };
}

// Subscription verification DTO
function subscriptionVerifyDto(row) {
  if (!row) return null;
  return {
    status: row.status,
    state: row.state,
    plan: row.plan,
    amount: row.amount,
    currency: row.currency,
    isPremium: toBool(row.is_premium),
    is_premium: toBool(row.is_premium),
    name: row.name,
    email: row.email,
    endsAt: row.ends_at || null,
    ends_at: row.ends_at || null,
    paidAt: row.paid_at || null,
    paid_at: row.paid_at || null,
  };
}

// Checkout DTO
function checkoutDto(row) {
  return {
    paymentLink: row.payment_link,
    payment_link: row.payment_link,
    txRef: row.tx_ref,
    tx_ref: row.tx_ref,
    orderTrackingId: row.order_tracking_id,
    order_tracking_id: row.order_tracking_id,
  };
}

module.exports = {
  pick, toBool, camel, list, USER_SENSITIVE, INTERNAL_ID_FIELDS,
  animeDto, adminAnimeDto, episodeDto, watchProgressDto, watchlistDto,
  watchlistStatsDto, subscriptionVerifyDto, checkoutDto,
};
