// utils/uploadContent.js — server-side content-type validation from magic bytes.
//
// A client-supplied MIME type is never trusted on its own. These sniffer
// helpers inspect the actual byte signatures so a renamed executable / HTML /
// polyglot cannot be stored as an "image" or "video".
'use strict';

/**
 * Detect the real image type from magic bytes.
 * @param {Buffer} buffer
 * @returns {string|null} 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | null
 */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  // WebP: RIFF .... WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // GIF87a / GIF89a
  const gif = buffer.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  // BMP: 'BM'
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'bmp';
  return null;
}

/**
 * Detect the real video container type from magic bytes.
 * @param {Buffer} buffer
 * @returns {string|null} 'mp4/quicktime' | 'mkv/webm' | null
 */
function sniffVideoType(buffer) {
  if (!buffer || buffer.length < 16) return null;
  // MP4 / QuickTime: the ISO BMFF 'ftyp' box appears at byte 4.
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4/quicktime';
  // WebM / Matroska: EBML magic 1A 45 DF A3.
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'mkv/webm';
  return null;
}

module.exports = { sniffImageType, sniffVideoType };
