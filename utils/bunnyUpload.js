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

    const storageZone = process.env.BUNNY_STORAGE_ZONE;
    const accessKey = process.env.BUNNY_STORAGE_PASSWORD;
    const storageRegion = (process.env.BUNNY_STORAGE_REGION || "").trim();
    const cdnUrl = process.env.BUNNY_CDN_URL.replace(/\/$/, "");

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

    console.log("\n============================");
    console.log("BUNNY IMAGE UPLOAD");
    console.log("============================");
    console.log("Storage Zone :", storageZone);
    console.log("Region       :", storageRegion || "(default)");
    console.log("Upload Host  :", uploadHost);
    console.log("Folder       :", folder);
    console.log("Filename     :", filename);
    console.log("Upload URL   :", uploadUrl);
    console.log("Content Type :", file.mimetype);
    console.log("File Size    :", file.buffer.length);
    console.log("============================\n");

    try {

        await axios.put(
            uploadUrl,
            file.buffer,
            {
                headers: {
                    AccessKey: accessKey,
                    "Content-Type": file.mimetype,
                    "Content-Length": file.buffer.length,
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: 60000,
            }
        );

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

        console.error("\n========== BUNNY ERROR ==========");
        console.error("Status :", err.response?.status);
        console.error("Data   :", err.response?.data);
        console.error("Message:", err.message);
        console.error("=================================\n");

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

        return res.status(500).json({
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