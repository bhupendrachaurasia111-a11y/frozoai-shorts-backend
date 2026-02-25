# FrozoAI Shorts Video Renderer — Setup Guide

## Overview
This is the backend service that renders vertical 9:16 MP4 videos using FFmpeg, uploads them to Supabase Storage, and handles YouTube OAuth + publishing.

---

## Step 1: Install Dependencies

```bash
cd video-renderer
npm install
```

## Step 2: Install FFmpeg on Server

FFmpeg must be available in PATH.

**Render.com**: Add a `Dockerfile` or use an image with FFmpeg pre-installed.

Example Dockerfile for Render:
```dockerfile
FROM node:18-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

## Step 3: Deploy to Render

1. Push `video-renderer/` to a GitHub repo
2. Create a new **Web Service** on Render
3. Set **Root Directory** to `video-renderer`
4. Set **Build Command**: `npm install`
5. Set **Start Command**: `node server.js`
6. If using Docker, select **Docker** as environment

## Step 4: Add Environment Variables on Render

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | `3001` | Server port (Render auto-sets) |
| `SUPABASE_URL` | `https://mltwggrqhtzrmjkehnxg.supabase.co` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `(from Supabase dashboard)` | Settings → API → service_role key |
| `FRONTEND_URL` | `https://frozoai.com` | Your frontend URL (for CORS + OAuth redirect) |
| `YOUTUBE_CLIENT_ID` | `(from Google Cloud Console)` | OAuth 2.0 Client ID |
| `YOUTUBE_CLIENT_SECRET` | `(from Google Cloud Console)` | OAuth 2.0 Client Secret |
| `YOUTUBE_REDIRECT_URI` | `https://your-render-url.onrender.com/auth/youtube/callback` | Must match Google Console |

## Step 5: Create Supabase Storage Buckets

These should already be created via migration, but verify they exist:

1. Go to Supabase Dashboard → Storage
2. Confirm these buckets exist and are **public**:
   - `shorts-assets` — Stores voice MP3s, images, SRT files
   - `shorts-videos` — Stores rendered MP4 videos

## Step 6: Add OpenAI Key to Supabase Edge Function Secrets

1. Go to Supabase Dashboard → Settings → Edge Functions
2. Add/verify these secrets:
   - `OPENAI_API_KEY` — Your OpenAI API key (for TTS + DALL-E image generation)
   - `LOVABLE_API_KEY` — Already auto-configured by Lovable

## Step 7: Google Cloud Console Setup (YouTube OAuth)

1. Go to https://console.cloud.google.com
2. Create or select a project
3. Enable **YouTube Data API v3**
4. Go to **Credentials** → Create **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add Authorized redirect URI: `https://your-render-url.onrender.com/auth/youtube/callback`
7. Copy **Client ID** and **Client Secret** to Render env vars

## Step 8: Restart Services

1. Restart the Render service after adding env vars
2. Redeploy Supabase Edge Functions (automatic via Lovable)

## Step 9: Test the Full Flow

1. Open FrozoAI → Video → Create Shorts
2. Paste an article URL
3. Click "Generate Short"
4. Wait for script + voice + images + video
5. Preview the video
6. Click Download or Upload to YouTube

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/render-short` | Render video from assets |
| `GET` | `/auth/youtube` | Start YouTube OAuth |
| `GET` | `/auth/youtube/callback` | YouTube OAuth callback |
| `POST` | `/auth/youtube/disconnect` | Disconnect YouTube |
| `POST` | `/upload/youtube` | Upload video to YouTube |

## Troubleshooting

- **FFmpeg not found**: Ensure FFmpeg is installed on the server
- **Storage upload fails**: Check bucket exists and is public
- **YouTube upload fails**: Verify OAuth tokens and API quota
- **TTS fails**: Check OPENAI_API_KEY is set in Supabase secrets
