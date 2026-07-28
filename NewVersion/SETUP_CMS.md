# AniStrim CMS Setup Instructions

## 1. Database Migration
Run `sql/migrations_v5.sql`, `sql/migrations_v6_dashboard.sql`, and `sql/migrations_v7_cloudinary.sql` on your MySQL database.

## 2. Environment Variables
Add the following variables to your `.env` file:

```env
# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
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
- [ ] Upload an MP4 video to an episode (verify Cloudinary upload).
- [ ] Check uploaded video metadata.
- [ ] Create/Delete Genres.
- [ ] Search and Ban a user.
- [ ] Update System Settings.
- [ ] Verify Activity Logs record actions.
