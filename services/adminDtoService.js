// services/adminDtoService.js - explicit admin API DTOs (whitelist, camelCase).
'use strict';

function num(v) { return v === null || v === undefined ? null : Number(v); }
function bool(v) { return v === true || v === 1 || v === '1' || (Buffer.isBuffer(v) && v[0] === 1); }

function userDto(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name != null ? r.name : r.email, email: r.email,
    isAdmin: bool(r.is_admin), isPremium: bool(r.is_premium),
    premiumExpiresAt: r.premium_expires_at || null, status: r.status || 'active',
    createdAt: r.created_at || null, updatedAt: r.updated_at || null, avatarUrl: r.avatar_url || null,
    is_admin: bool(r.is_admin), is_premium: bool(r.is_premium),
    premium_expires_at: r.premium_expires_at || null, created_at: r.created_at || null,
    updated_at: r.updated_at || null, avatar_url: r.avatar_url || null,
  };
}

function animeDto(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title, titleJapanese: r.title_japanese || null,
    description: r.description || null, coverImage: r.cover_image || r.poster_url || null,
    bannerImage: r.banner_image || null, bannerUrl: r.banner_image || null,
    trailerUrl: r.trailer_url || null, rating: num(r.rating), year: r.year ? Number(r.year) : null,
    studio: r.studio || null, status: r.status || 'unknown', mediaType: r.media_type || 'anime',
    season: r.season || null, isPremium: bool(r.is_premium), isFeatured: bool(r.is_featured),
    isPublished: bool(r.is_published), accessTier: r.access_tier || 'free',
    episodeCount: Number(r.episode_count || r.episodeCount || 0), viewCount: num(r.view_count),
    totalEpisodeViews: num(r.total_episode_views), createdAt: r.created_at || null, updatedAt: r.updated_at || null,
    animeheavenSlug: r.animeheaven_slug || null, genres: Array.isArray(r.genres) ? r.genres : [],
    title_japanese: r.title_japanese || null, cover_image: r.cover_image || r.poster_url || null,
    banner_image: r.banner_image || null, trailer_url: r.trailer_url || null, media_type: r.media_type || 'anime',
    is_premium: bool(r.is_premium), is_featured: bool(r.is_featured), is_published: bool(r.is_published),
    access_tier: r.access_tier || 'free', episode_count: Number(r.episode_count || r.episodeCount || 0),
    view_count: num(r.view_count), total_episode_views: num(r.total_episode_views),
    created_at: r.created_at || null, updated_at: r.updated_at || null,
    animeheaven_slug: r.animeheaven_slug || null,
    video_source: r.video_source || null, cloudinary_status: r.cloudinary_status || null,
  };
}

function episodeDto(r) {
  if (!r) return null;
  return {
    id: r.id, animeId: r.anime_id, animeTitle: r.anime_title || null,
    number: num(r.episode_number), title: r.title || null, description: r.description || null,
    thumbnailUrl: r.thumbnail_url || null, videoUrl: r.video_url || null,
    manualVideoUrl: r.manual_video_url || null,
    durationSec: num(r.duration_sec), viewCount: num(r.view_count),
    isPremium: bool(r.is_premium), accessTier: r.access_tier || 'inherit',
    premiumUntil: r.premium_until || null, createdAt: r.created_at || null, updatedAt: r.updated_at || null,
    anime_id: r.anime_id, anime_title: r.anime_title || null, episode_number: num(r.episode_number),
    thumbnail_url: r.thumbnail_url || null, video_url: r.video_url || null,
    manual_video_url: r.manual_video_url || null,
    duration_sec: num(r.duration_sec), view_count: num(r.view_count),
    is_premium: bool(r.is_premium), access_tier: r.access_tier || 'inherit',
    premium_until: r.premium_until || null, created_at: r.created_at || null, updated_at: r.updated_at || null,
  };
}

function genreDto(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, ...(r.name ? { name: r.name } : {}) };
}

function adDto(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title || null, type: r.type || 'banner', imageUrl: r.image_url || null,
    bannerUrl: r.banner_url || r.image_url || null, videoUrl: r.video_url || null, targetUrl: r.target_url || null,
    frequencyMinutes: num(r.frequency || r.frequency_minutes), isActive: bool(r.is_active),
    targetFreeOnly: bool(r.target_free_only), startDate: r.start_date || null, endDate: r.end_date || null,
    createdAt: r.created_at || null, updatedAt: r.updated_at || null,
    image_url: r.image_url || null, banner_url: r.banner_url || r.image_url || null,
    video_url: r.video_url || null, target_url: r.target_url || null,
    frequency: num(r.frequency || r.frequency_minutes), frequency_minutes: num(r.frequency || r.frequency_minutes),
    is_active: bool(r.is_active), target_free_only: bool(r.target_free_only),
    start_date: r.start_date || null, end_date: r.end_date || null,
    created_at: r.created_at || null, updated_at: r.updated_at || null,
  };
}

function paymentDto(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, name: r.name || '', email: r.email || '',
    amount: num(r.amount), currency: r.currency || 'UGX', plan: r.plan || null,
    status: r.status || 'pending', reference: r.reference || r.flw_tx_ref || null,
    flwTxRef: r.flw_tx_ref || null, createdAt: r.created_at || null, paidAt: r.paid_at || null,
    user_id: r.user_id, flw_tx_ref: r.flw_tx_ref || null,
    created_at: r.created_at || null, paid_at: r.paid_at || null,
  };
}

function logDto(r) {
  if (!r) return null;
  return {
    id: r.id, userName: r.user_name || 'System', action: r.action,
    targetType: r.target_type || null, targetId: r.target_id || null,
    details: r.details || r.detail || null, createdAt: r.created_at || r.timestamp || null,
    ipAddress: r.ip_address || null,
    user_name: r.user_name || 'System', target_type: r.target_type || null,
    target_id: r.target_id || null, created_at: r.created_at || r.timestamp || null,
    ip_address: r.ip_address || null,
  };
}

const SENSITIVE_KEYS = new Set(['password_hash', 'verification_code', 'otp_hash', 'refresh_token', 'reset_token', 'stripe_customer_id', 'google_refresh_token']);
function redactedDiff(json) {
  if (!json) return null;
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    if (obj && typeof obj === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(obj)) if (!SENSITIVE_KEYS.has(k)) clean[k] = v;
      return clean;
    }
    return obj;
  } catch (e) { return null; }
}
function auditDto(r) {
  if (!r) return null;
  return {
    id: r.id, adminId: r.admin_id, adminName: r.admin_name || r.user_name || null,
    action: r.action, entityType: r.entity_type || r.target_type || null,
    entityId: r.entity_id || r.target_id || null, before: redactedDiff(r.before_json),
    after: redactedDiff(r.after_json), ipHash: r.ip_hash || null, createdAt: r.created_at || null,
    admin_id: r.admin_id, admin_name: r.admin_name || r.user_name || null,
    entity_type: r.entity_type || r.target_type || null, entity_id: r.entity_id || r.target_id || null,
    before_json: r.before_json ? redactedDiff(r.before_json) : null,
    after_json: r.after_json ? redactedDiff(r.after_json) : null,
    ip_hash: r.ip_hash || null, created_at: r.created_at || null,
  };
}

module.exports = {
  userDto, animeDto, episodeDto, genreDto, adDto, paymentDto, logDto, auditDto, bool, num,
};