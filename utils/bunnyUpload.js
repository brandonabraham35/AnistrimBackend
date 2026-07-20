const multer = require('multer');
const { cloudinary, isConfigured } = require('./cloudinary');

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const FIELD_NAMES = ['image', 'file', 'avatar', 'photo', 'picture', 'thumbnail', 'thumbnail_url', 'cover', 'cover_image', 'banner', 'banner_image'];
const FOLDERS = { anime: 'anime/covers', banners: 'anime/banners', thumbnails: 'anime/thumbnails', avatars: 'avatars', profiles: 'avatars' };

const uploadParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, String(file.mimetype).startsWith('image/')),
}).fields(FIELD_NAMES.map(name => ({ name, maxCount: 1 })));

function parseUpload(req, res) {
  return new Promise((resolve, reject) => uploadParser(req, res, error => error ? reject(error) : resolve()));
}

function firstUploadedFile(req) {
  if (req.file) return req.file;
  for (const field of FIELD_NAMES) if (req.files?.[field]?.[0]) return req.files[field][0];
  return Object.values(req.files || {}).find(files => Array.isArray(files) && files[0])?.[0] || null;
}

function normalizeFolder(folderKey) { return FOLDERS[folderKey] || FOLDERS.anime; }

async function uploadBufferToCloudinary(file, folderKey) {
  if (!file?.buffer) throw new Error('No image received.');
  if (!isConfigured()) throw new Error('Cloudinary is not configured.');
  const folder = normalizeFolder(folderKey);
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: 'image', folder, use_filename: true, unique_filename: true, overwrite: false }, (error, uploadResult) => error ? reject(error) : resolve(uploadResult));
    stream.end(file.buffer);
  });
  return { url: result.secure_url, imageUrl: result.secure_url, image_url: result.secure_url, secure_url: result.secure_url, path: result.secure_url, public_id: result.public_id, folder };
}

async function deleteImage(publicId) {
  if (!publicId || !isConfigured()) return { result: 'not_found' };
  return cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}

async function handleImageUpload(req, res, folderKey) {
  try {
    if (!isConfigured()) return res.status(503).json({ success: false, message: 'Cloudinary is not configured.' });
    await parseUpload(req, res);
    const file = firstUploadedFile(req);
    if (!file) return res.status(400).json({ success: false, message: 'No image uploaded.', acceptedFields: FIELD_NAMES });
    const result = await uploadBufferToCloudinary(file, folderKey);
    return res.json({ success: true, message: 'Image uploaded successfully.', ...result });
  } catch (error) {
    console.error('Cloudinary image upload failed:', error.message);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 502;
    return res.status(status).json({ success: false, message: error.message || 'Image upload failed.' });
  }
}

module.exports = { handleImageUpload, uploadBufferToCloudinary, deleteImage, hasCloudinaryConfig: isConfigured, FIELD_NAMES, FOLDERS, MAX_FILE_SIZE };
