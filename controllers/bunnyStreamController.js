const fs = require('fs');
const fetch = require('node-fetch');

const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const API_KEY = process.env.BUNNY_STREAM_API_KEY;
const CDN_HOSTNAME = process.env.BUNNY_STREAM_CDN_HOSTNAME;

exports.uploadVideo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No video file uploaded.' });
        }

        const title = req.body.title || req.file.originalname;

        const createRes = await fetch(`https://video.bunnycdn.com/library/${LIBRARY_ID}/videos`, {
            method: 'POST',
            headers: {
                AccessKey: API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ title }),
        });

        const created = await createRes.json();

        if (!createRes.ok) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create Bunny video.',
                error: created,
            });
        }

        const videoId = created.guid;

        const uploadRes = await fetch(`https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${videoId}`, {
            method: 'PUT',
            headers: {
                AccessKey: API_KEY,
                'Content-Type': 'application/octet-stream',
            },
            body: fs.createReadStream(req.file.path),
        });

        fs.unlinkSync(req.file.path);

        if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            return res.status(500).json({
                success: false,
                message: 'Failed to upload video to Bunny Stream.',
                error: errText,
            });
        }

        return res.json({
            success: true,
            videoId,
            playbackUrl: `https://${CDN_HOSTNAME}/${videoId}/playlist.m3u8`,
            embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}`,
            message: 'Video uploaded. Bunny is processing it.',
        });
    } catch (err) {
        console.error('Bunny Stream upload error:', err);
        return res.status(500).json({
            success: false,
            message: 'Server error during Bunny Stream upload.',
        });
    }
};