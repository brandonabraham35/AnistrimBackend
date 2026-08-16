// ============================================================
//  utils/imageService.js — Centralized Image Ingestion & Normalization
//
//  PURPOSE:
//    Single source of truth for processing incoming anime images.
//    Handles the full pipeline:
//
//      incoming image
//      ↓
//      Is it already a valid public HTTP/HTTPS URL?
//          YES → validate/normalize as appropriate
//          NO  → resolve/download image
//                ↓
//                upload to Cloudinary
//                ↓
//                receive Cloudinary secure URL
//      ↓
//      store final image URL in database
//
//  Reusable by:
//    • single anime import
//    • bulk import
//    • anime update
//    • any future provider import
//
//  Uses deterministic public IDs (SHA-256 hash of the source URL) so the
//  same image is never uploaded twice.
// ============================================================
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');
const { uploadBufferToCloudinary, hasCloudinaryConfig } = require('./bunnyUpload');

// ── Image URL detection ─────────────────────────────────────

/**
 * Check if a value is a valid public HTTP/HTTPS image URL.
 * @param {string} value
 * @returns {boolean}
 */
function isValidHttpUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check if a URL looks like an image (by extension or content-type hint).
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeImageUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  // Common image extensions
  if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)(\?|#|$)/i.test(trimmed)) return true;
  // Cloudinary URLs always end with an image extension
  if (/res\.cloudinary\.com/i.test(trimmed)) return true;
  return false;
}

/**
 * Normalize a relative/provider path to an absolute URL if possible.
 * If no base URL is available, returns null (caller must upload to Cloudinary).
 *
 * @param {string} value — relative path or provider-specific path
 * @param {string} [baseUrl] — base URL to resolve against
 * @returns {string|null} absolute URL or null if not resolvable
 */
function normalizeRelativePath(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isValidHttpUrl(trimmed)) return trimmed;
  if (!baseUrl) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Compute a deterministic public ID for an image source.
 * Uses SHA-256 of the source URL so the same image is never uploaded twice.
 *
 * @param {string} source — the original image source (URL or path)
 * @param {string} folder — Cloudinary folder key (e.g. 'anime', 'banners')
 * @returns {string} deterministic public ID
 */
function deterministicPublicId(source, folder) {
  const hash = crypto.createHash('sha256').update(String(source || '')).digest('hex').slice(0, 24);
  return `${folder || 'anime'}/${hash}`;
}

/**
 * Download an image from a URL and return its buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/*,*/*;q=0.8',
    },
  });
  return Buffer.from(response.data);
}

/**
 * Upload a buffer to Cloudinary with a deterministic public ID.
 * @param {Buffer} buffer
 * @param {string} folderKey — 'anime', 'banners', 'thumbnails', etc.
 * @param {string} publicId — deterministic public ID
 * @returns {Promise<{ url: string, publicId: string }>}
 */
async function uploadBufferWithPublicId(buffer, folderKey, publicId) {
  const { cloudinary } = require('./cloudinary');
  if (!cloudinary || !hasCloudinaryConfig()) {
    throw new Error('Cloudinary is not configured.');
  }
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        public_id: publicId,
        overwrite: true,
        folder: '',
      },
      (error, uploadResult) => error ? reject(error) : resolve(uploadResult)
    );
    stream.end(buffer);
  });
  return { url: result.secure_url, publicId: result.public_id };
}

// ── Main pipeline ───────────────────────────────────────────

/**
 * Process an incoming image value into a final usable public URL.
 *
 * Logic:
 *   1. If the value is already a valid HTTP/HTTPS image URL → return as-is
 *      (normalized). This avoids re-uploading already-public images.
 *   2. If the value is a relative/provider path → try to resolve to an
 *      absolute URL. If resolvable and looks like an image → return as-is.
 *   3. Otherwise → download the image and upload to Cloudinary with a
 *      deterministic public ID. Return the Cloudinary secure URL.
 *   4. On any failure → return null (caller preserves existing image).
 *
 * @param {string|Buffer|null} value — incoming image (URL, path, or buffer)
 * @param {object} [options]
 * @param {string} [options.folder] — Cloudinary folder key ('anime', 'banners')
 * @param {string} [options.baseUrl] — base URL to resolve relative paths
 * @param {string} [options.sourceLabel] — for logging (e.g. anime title)
 * @returns {Promise<{ url: string|null, publicId: string|null, source: string }>}
 */
async function processImage(value, options = {}) {
  const folder = options.folder || 'anime';
  const baseUrl = options.baseUrl || null;
  const sourceLabel = options.sourceLabel || 'image';

  // 1. Already a valid public URL?
  if (isValidHttpUrl(value)) {
    const url = value.trim();
    // If it's already a Cloudinary URL, it's already normalized — return as-is.
    if (/res\.cloudinary\.com/i.test(url)) {
      return { url, publicId: null, source: 'cloudinary' };
    }
    // If it looks like an image URL, return as-is (already public).
    if (looksLikeImageUrl(url)) {
      return { url, publicId: null, source: 'public-url' };
    }
    // It's a valid URL but doesn't look like an image — try to download and
    // upload to Cloudinary so we store a guaranteed image URL.
    try {
      const buffer = await downloadImage(url);
      const publicId = deterministicPublicId(url, folder);
      const result = await uploadBufferWithPublicId(buffer, folder, publicId);
      logger.info('[ImageService] Uploaded non-image URL to Cloudinary', {
        source: sourceLabel,
        folder,
        publicId: result.publicId,
      });
      return { url: result.url, publicId: result.publicId, source: 'cloudinary' };
    } catch (err) {
      logger.warn('[ImageService] Failed to process non-image URL', {
        source: sourceLabel,
        url,
        error: err.message,
      });
      return { url: null, publicId: null, source: 'failed' };
    }
  }

  // 2. Relative/provider path — try to resolve to absolute URL.
  if (typeof value === 'string' && value.trim()) {
    const resolved = normalizeRelativePath(value, baseUrl);
    if (resolved && looksLikeImageUrl(resolved)) {
      return { url: resolved, publicId: null, source: 'resolved-url' };
    }
    // Could not resolve to a usable public URL — fall through to upload.
  }

  // 3. Buffer or non-URL value — upload to Cloudinary.
  try {
    let buffer;
    if (Buffer.isBuffer(value)) {
      buffer = value;
    } else if (typeof value === 'string' && value.trim()) {
      // Try to download from the raw value (could be a provider path).
      const downloadSource = normalizeRelativePath(value, baseUrl) || value.trim();
      buffer = await downloadImage(downloadSource);
    } else {
      return { url: null, publicId: null, source: 'empty' };
    }

    const publicId = deterministicPublicId(
      typeof value === 'string' ? value : `buffer-${Date.now()}`,
      folder
    );
    const result = await uploadBufferWithPublicId(buffer, folder, publicId);
    logger.info('[ImageService] Uploaded image to Cloudinary', {
      source: sourceLabel,
      folder,
      publicId: result.publicId,
    });
    return { url: result.url, publicId: result.publicId, source: 'cloudinary' };
  } catch (err) {
    logger.warn('[ImageService] Image processing failed', {
      source: sourceLabel,
      error: err.message,
    });
    return { url: null, publicId: null, source: 'failed' };
  }
}

/**
 * Process a cover image and a banner image together (common for anime).
 * Preserves existing values when processing fails.
 *
 * @param {object} images — { cover, banner }
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.sourceLabel]
 * @returns {Promise<{ cover: { url, publicId }, banner: { url, publicId } }>}
 */
async function processAnimeImages(images = {}, options = {}) {
  const [coverResult, bannerResult] = await Promise.all([
    processImage(images.cover, { ...options, folder: 'anime' }),
    processImage(images.banner, { ...options, folder: 'banners' }),
  ]);
  return {
    cover: coverResult,
    banner: bannerResult,
  };
}

module.exports = {
  processImage,
  processAnimeImages,
  isValidHttpUrl,
  looksLikeImageUrl,
  normalizeRelativePath,
  deterministicPublicId,
  downloadImage,
};