# AniStrim CMS Setup Instructions

## 1. Database Migration
Run the SQL commands in `sql/migrations_v5.sql` on your MySQL database to add the required columns and tables for Bunny Stream, Settings, Ads, and Activity Logs.

## 2. Environment Variables
Add the following variables to your `.env` file:

```env
# Bunny Stream
BUNNY_STREAM_LIBRARY_ID=your_library_id
BUNNY_STREAM_API_KEY=your_api_key
BUNNY_STREAM_CDN_HOSTNAME=your_pull_zone_hostname (e.g. vz-xxxx.b-cdn.net)

# Previous variables (Ensure they are set)
BUNNY_STORAGE_ZONE=anistrim
BUNNY_STORAGE_PASSWORD=your_password
BUNNY_CDN_URL=https://anistrim.b-cdn.net
JWT_SECRET=your_secret
```

## 3. Deployment
- The backend is ready to be redeployed to Render.
- The `AdminDashboard` folder can be hosted as static files or served by the Express app (not modified here as per instructions, but ready for any static host).

## 4. Testing Checklist
- [ ] Login with `is_admin=1` user.
- [ ] Verify Dashboard stats load correctly.
- [ ] Create a new Anime, upload Cover and Banner.
- [ ] Manage Episodes for an anime.
- [ ] Upload an MP4 video to an episode (verify Bunny Stream upload).
- [ ] Check video processing status.
- [ ] Create/Delete Genres.
- [ ] Search and Ban a user.
- [ ] Update System Settings.
- [ ] Verify Activity Logs record actions.
