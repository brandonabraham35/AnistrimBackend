const axios = require("axios");
const multer = require("multer");
const path = require("path");

const MAX_FILE_SIZE = 15 * 1024 * 1024; //15MB

const FIELD_NAMES = [
    "image",
    "file",
    "avatar",
    "photo",
    "picture",
    "thumbnail",
    "thumbnail_url",
    "cover",
    "cover_image",
    "banner",
    "banner_image",
];

const FOLDERS = {
    anime: "anime/covers",
    banners: "anime/banners",
    thumbnails: "anime/thumbnails",
    avatars: "avatars",
    profiles: "avatars",
};

function hasBunnyConfig() {
    return Boolean(
        process.env.BUNNY_STORAGE_ZONE?.trim() &&
        process.env.BUNNY_STORAGE_PASSWORD?.trim() &&
        process.env.BUNNY_CDN_URL?.trim()
    );
}

const uploadParser = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
    },
    fileFilter: (_req, file, cb) => {
        if (String(file.mimetype).startsWith("image/")) {
            return cb(null, true);
        }

        cb(new Error("Only image files are allowed."));
    },
}).fields(FIELD_NAMES.map(name => ({
    name,
    maxCount: 1
})));

function parseUpload(req, res) {
    return new Promise((resolve, reject) => {
        uploadParser(req, res, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function firstUploadedFile(req) {

    if (req.file) return req.file;

    if (!req.files) return null;

    for (const field of FIELD_NAMES) {
        if (req.files[field] && req.files[field][0]) {
            return req.files[field][0];
        }
    }

    for (const value of Object.values(req.files)) {
        if (Array.isArray(value) && value[0]) {
            return value[0];
        }
    }

    return null;
}

function normalizeFolder(folderKey) {
    return FOLDERS[folderKey] || FOLDERS.anime;
}

async function uploadBufferToBunny(file, folderKey) {

    if (!file || !file.buffer) {
        throw new Error("No image received.");
    }

    const storageZone = process.env.BUNNY_STORAGE_ZONE.trim();
    const accessKey = process.env.BUNNY_STORAGE_PASSWORD.trim();
    const storageRegion = (process.env.BUNNY_STORAGE_REGION || "").trim();
    const cdnUrl = process.env.BUNNY_CDN_URL.trim().replace(/\/$/, "");

    const folder = normalizeFolder(folderKey);

    const uploadHost = storageRegion
        ? `https://${storageRegion}.storage.bunnycdn.com`
        : "https://storage.bunnycdn.com";

    const ext =
        path.extname(file.originalname || "") ||
        ".jpg";

    const safeName =
        (file.originalname || "image")
            .replace(/\.[^/.]+$/, "")
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .replace(/-+/g, "-")
            .substring(0, 60);

    const filename =
        `${folderKey}-${Date.now()}-${safeName}${ext}`;

    const uploadUrl =
        `${uploadHost}/${storageZone}/${folder}/${filename}`;

    console.info(`[BunnyStorage] Uploading ${file.buffer.length} bytes to ${folder}/${filename}`);

    try {

        let uploadError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await axios.put(uploadUrl, file.buffer, {
                    headers: { AccessKey: accessKey, "Content-Type": file.mimetype, "Content-Length": file.buffer.length },
                    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000,
                    validateStatus: status => status >= 200 && status < 300,
                });
                uploadError = null;
                break;
            } catch (error) {
                uploadError = error;
                const status = error.response?.status;
                if (attempt === 3 || (status && ![408, 429, 500, 502, 503, 504].includes(status))) break;
                await new Promise(resolve => setTimeout(resolve, 400 * (2 ** (attempt - 1))));
            }
        }
        if (uploadError) throw uploadError;

        const publicUrl =
            `${cdnUrl}/${folder}/${filename}`;

        return {
            url: publicUrl,
            imageUrl: publicUrl,
            image_url: publicUrl,
            secure_url: publicUrl,
            path: publicUrl,
            public_id: filename,
            folder,
        };

    } catch (err) {

        console.error('[BunnyStorage] Upload failed:', err.response?.status || 'network', err.message);

        throw err;
    }
}

async function handleImageUpload(req, res, folderKey) {

    try {

        if (!hasBunnyConfig()) {
            return res.status(500).json({
                success: false,
                message: "Bunny Storage is not configured."
            });
        }

        await parseUpload(req, res);

        const file = firstUploadedFile(req);

        if (!file) {
            return res.status(400).json({
                success: false,
                message: "No image uploaded.",
                acceptedFields: FIELD_NAMES
            });
        }

        const result =
            await uploadBufferToBunny(file, folderKey);

        return res.json({
            success: true,
            message: "Image uploaded successfully.",
            ...result
        });

    } catch (err) {

        console.error("[bunnyUpload]", err);

        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.response?.status >= 400 && err.response?.status < 500 ? 502 : 503);
        return res.status(status).json({
            success: false,
            message:
                err.response?.data?.Message ||
                err.response?.data ||
                err.message ||
                "Upload failed."
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
