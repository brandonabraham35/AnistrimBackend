let cloudinary = null;
try {
  cloudinary = require('cloudinary').v2;
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function isConfigured() {
  return Boolean(
    cloudinary &&
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
    process.env.CLOUDINARY_API_KEY?.trim() &&
    process.env.CLOUDINARY_API_SECRET?.trim()
  );
}

if (cloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

module.exports = { cloudinary, isConfigured };
