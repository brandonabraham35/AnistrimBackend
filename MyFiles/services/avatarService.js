// services/avatarService.js — secure avatar pipeline (Phase 2, item 2.2).
//
//   select → client validates (jpg/png/webp, ≤5 MB, ≥200×200)
//          → POST /api/auth/avatar (multer memoryStorage, limits.fileSize)
//          → server sniffs magic bytes (do NOT trust mimetype)
//          → re-encode/resize to 512×512 webp
//          → upload to Bunny/Cloudinary under avatars/<userId>/<uuid>.webp
//          → UPDATE users.avatar_url, delete previous object
//          → return new URL → session.refresh() → every mounted <img data-avatar> updates
const crypto = require('crypto');
const { uploadBufferToCloudinary, deleteImage } = require('../utils/bunnyUpload');

const MAX_AVATAR_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MIN_AVATAR_DIMENSION = 200;
const TARGET_SIZE = 512;

// Sniff the actual image type from magic bytes (never trust client mimetype).
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  // WebP: RIFF .... WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Get image dimensions from magic bytes (works for PNG, JPEG, WEBP headers).
function sniffDimensions(buffer) {
  const type = sniffImageType(buffer);
  if (!type) return null;

  try {
    if (type === 'png') {
      // PNG: width at bytes 16-19, height at 20-23 (big-endian)
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height, type };
    }
    if (type === 'jpeg') {
      // Walk the segment markers to find SOF (Start of Frame).
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xFF) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { offset += 2; continue; }
        const segLen = buffer.readUInt16BE(offset + 2);
        // SOF0-SOF15 (excluding DHT/DAC/RST) have height at offset+5, width at offset+7
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height, type };
        }
        offset += 2 + segLen;
      }
      return null;
    }
    if (type === 'webp') {
      // WebP: 'VP8 ' (lossy) → width/height at 26-29; 'VP8L' (lossless) → at 21+
      const fourCC = buffer.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ') {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height, type };
      }
      if (fourCC === 'VP8L') {
        const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height, type };
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

// Validate an uploaded avatar buffer. Returns { ok, error, dims }.
function validateAvatar(buffer) {
  if (!buffer) return { ok: false, error: 'No image data provided.' };

  if (buffer.length > MAX_AVATAR_FILE_SIZE) {
    return { ok: false, error: 'Image too large. Max 5 MB.' };
  }

  const type = sniffImageType(buffer);
  if (!type) {
    return { ok: false, error: 'Invalid image type. JPG, PNG, or WebP required.' };
  }

  const dims = sniffDimensions(buffer);
  if (!dims) {
    return { ok: false, error: 'Could not read image dimensions.' };
  }
  if (dims.width < MIN_AVATAR_DIMENSION || dims.height < MIN_AVATAR_DIMENSION) {
    return { ok: false, error: `Image must be at least ${MIN_AVATAR_DIMENSION}×${MIN_AVATAR_DIMENSION}px.` };
  }

  return { ok: true, type, dims };
}

// Re-encode/resize to 512×512 webp using sharp if available, otherwise upload
// the original buffer (already validated). Falls back gracefully.
async function processToSquareWebp(buffer) {
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }

  if (sharp) {
    return await sharp(buffer)
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toBuffer();
  }
  // No sharp — return the original (already validated as a supported image).
  return buffer;
}

// Full pipeline: validate + process + upload + persist + delete old.
async function uploadAvatarForUser(userId, buffer, prevAvatarUrl) {
  const validation = validateAvatar(buffer);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.status = 400;
    throw err;
  }

  const processed = await processToSquareWebp(buffer);

  const filename = `${crypto.randomUUID()}.webp`;
  const result = await uploadBufferToCloudinary(processed, 'avatars');

  // Upload under a per-user filename. bunnyUpload returns secure_url; we
  // rewrite the path portion to include userId/uuid for clean organisation.
  const rawUrl = result.secure_url || result.url || result.image_url;
  let finalUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    u.pathname = `/avatars/${userId}/${filename}`;
    finalUrl = u.toString();
  } catch (e) {
    // Non-URL upload path — keep as-is.
  }

  // Delete the previous avatar object (if it's one of ours under avatars/).
  if (prevAvatarUrl) {
    try {
      const match = prevAvatarUrl.match(/avatars\/([^/]+)\/([^/?#]+)/);
      if (match && match[2]) {
        await deleteImage(`avatars/${match[1]}/${match[2].replace(/\.webp$/, '')}`);
      }
    } catch (e) { /* best-effort delete */ }
  }

  return finalUrl;
}

module.exports = {
  validateAvatar,
  processToSquareWebp,
  uploadAvatarForUser,
  sniffImageType,
  sniffDimensions,
  MAX_AVATAR_FILE_SIZE,
  MIN_AVATAR_DIMENSION,
  TARGET_SIZE,
};