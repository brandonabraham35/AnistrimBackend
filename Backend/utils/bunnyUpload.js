const axios = require('axios');
const multer = require('multer');
const path = require('path');

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const FIELD_NAMES = [
  'image',
  'file',
  'avatar',
  'photo',
  'picture',
  'thumbnail',
  'thumbnail_url',
  'cover',
  'cover_image',
  'banner',
  'banner_image',
];

const FOLDERS = {
  anime: 'anime/covers',
  banners: 'anime/banners',
  thumbnails: 'anime/thumbnails',
  avatars: 'avatars',
  profiles: 'avatars',
};

function hasBunnyConfig() {
  return Boolean(
    process.env.BUNNY_STORAGE_ZONE &&
    process.env.BUNNY_STORAGE_PASSWORD &&
    process.env.BUNNY_CDN_URL
  );
}

const uploadParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) return cb(null, true);
    return cb(new Error('Only image files are allowed.'));
  },
}).fields(FIELD_NAMES.map((name) => ({ name, maxCount: 1 })));

function parseUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadParser(req, res, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

function firstUploadedFile(req) {
  if (req.file) return req.file;
  if (!req.files) return null;

  for (const name of FIELD_NAMES) {
    const value = req.files[name];
    if (Array.isArray(value) && value[0]) return value[0];
  }

  for (const value of Object.values(req.files)) {
    if (Array.isArray(value) && value[0]) return value[0];
  }

  return null;
}

function normalizeFolder(folderKey) {
  return FOLDERS[folderKey] || FOLDERS.anime;
}

async function uploadBufferToBunny(file, folderKey) {
  if (!file || !file.buffer) {
    throw new Error('No image file received.');
  }

  const storageZone = process.env.BUNNY_STORAGE_ZONE;
  const accessKey = process.env.BUNNY_STORAGE_PASSWORD;
  const cdnUrl = process.env.BUNNY_CDN_URL.replace(/\/$/, ''); // Remove trailing slash
  const folder = normalizeFolder(folderKey);

  const ext = path.extname(file.originalname) || '.jpg';
  const safeName = String(file.originalname || 'image')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'image';

  const filename = `${folderKey || 'image'}-${Date.now()}-${safeName}${ext}`;

  // Bunny upload endpoint format:
  // https://storage.bunnycdn.com/{BUNNY_STORAGE_ZONE}/{folder}/{filename}
  const uploadUrl = `https://storage.bunnycdn.com/${storageZone}/${folder}/${filename}`;

  await axios.put(uploadUrl, file.buffer, {
    headers: {
      AccessKey: accessKey,
      'Content-Type': file.mimetype,
    },
  });

  const publicUrl = `${cdnUrl}/${folder}/${filename}`;

  return {
    url: publicUrl,
    imageUrl: publicUrl,
    image_url: publicUrl,
    secure_url: publicUrl,
    path: publicUrl,
    public_id: filename,
    folder: folder,
  };
}

async function handleImageUpload(req, res, folderKey) {
  try {
    if (!hasBunnyConfig()) {
      return res.status(500).json({
        success: false,
        message: 'Bunny.net Storage is not configured.',
        code: 'BUNNY_NOT_CONFIGURED',
      });
    }

    await parseUpload(req, res);
    const file = firstUploadedFile(req);

    if (!file) {
      return res.status(400).json({
        success: false,
        message: `No image received. The form field must be one of: ${FIELD_NAMES.join(', ')}.`,
        code: 'NO_FILE_RECEIVED',
        acceptedFields: FIELD_NAMES,
      });
    }

    const result = await uploadBufferToBunny(file, folderKey);

    return res.status(200).json({
      success: true,
      message: 'Image uploaded successfully.',
      ...result,
    });
  } catch (err) {
    console.error('[bunnyUpload] Upload failed:', err);

    const isTooLarge = err && err.code === 'LIMIT_FILE_SIZE';
    const message = isTooLarge
      ? 'Image too large. Please upload an image smaller than 15 MB.'
      : (err && err.response && err.response.data && err.response.data.Message) || (err && err.message) || 'Upload failed. Please try again.';

    return res.status(isTooLarge ? 413 : 400).json({
      success: false,
      message,
      code: (err && err.code) || 'UPLOAD_FAILED',
    });
  }
}

module.exports = {
  handleImageUpload,
  hasBunnyConfig,
  FIELD_NAMES,
  FOLDERS,
  MAX_FILE_SIZE,
};
