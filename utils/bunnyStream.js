const { cloudinary, isConfigured } = require('./cloudinary');

function requireConfiguration() {
  if (!isConfigured()) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
  }
}

function toVideo(result) {
  return {
    public_id: result.public_id,
    secure_url: result.secure_url,
    duration: Number(result.duration) || 0,
    bytes: Number(result.bytes) || 0,
    format: result.format || null,
    resource_type: result.resource_type || 'video',
  };
}

async function uploadVideo(filePath, options = {}) {
  requireConfiguration();
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, {
      resource_type: 'video',
      folder: 'episodes',
      chunk_size: 20 * 1024 * 1024,
      use_filename: true,
      unique_filename: true,
      overwrite: false,
      ...options,
    }, (error, uploadResult) => error ? reject(error) : resolve(uploadResult));
  });
  return toVideo(result);
}

async function deleteVideo(publicId) {
  requireConfiguration();
  if (!publicId) return { result: 'not_found' };
  return cloudinary.uploader.destroy(publicId, { resource_type: 'video', invalidate: true });
}

async function getVideo(publicId) {
  requireConfiguration();
  const result = await cloudinary.api.resource(publicId, { resource_type: 'video' });
  return toVideo(result);
}

module.exports = { uploadVideo, deleteVideo, getVideo };
