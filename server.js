import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { renderShort } from './ffmpegTemplate.js';
import { downloadFile, uploadToSupabase } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Validate required env vars
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '50mb' }));

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'frozoai-shorts-renderer' }));

// ============ POST /render-short ============
app.post('/render-short', async (req, res) => {
  const { project_id, duration, voice_url, image_urls, srt_url, render_config } = req.body;

  if (!project_id || !voice_url || !image_urls?.length) {
    return res.status(400).json({ error: 'Missing required fields: project_id, voice_url, image_urls' });
  }

  const workDir = path.join(TEMP_DIR, project_id);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log(`[render] Starting render for project: ${project_id}, duration: ${duration || 'auto'}s`);

    // 1. Download voice
    const voicePath = path.join(workDir, 'voice.mp3');
    await downloadFile(voice_url, voicePath);
    console.log('[render] Voice downloaded');

    // 2. Download images
    const imagePaths = [];
    for (let i = 0; i < image_urls.length; i++) {
      const ext = image_urls[i].split('.').pop()?.split('?')[0] || 'png';
      const imgPath = path.join(workDir, `img_${i}.${ext}`);
      await downloadFile(image_urls[i], imgPath);
      imagePaths.push(imgPath);
    }
    console.log(`[render] ${imagePaths.length} images downloaded`);

    // 3. Download SRT if provided
    let srtPath = null;
    if (srt_url) {
      srtPath = path.join(workDir, 'subtitles.srt');
      await downloadFile(srt_url, srtPath);
      console.log('[render] SRT downloaded');
    }

    // 4. Render video with FFmpeg using full render_config
    const outputPath = path.join(workDir, 'final.mp4');
    await renderShort({
      voicePath,
      imagePaths,
      srtPath,
      outputPath,
      config: render_config || {},
    });
    console.log('[render] Video rendered');

    // 5. Upload to Supabase Storage
    const videoBuffer = fs.readFileSync(outputPath);
    const storagePath = `${project_id}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from('shorts-videos')
      .upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from('shorts-videos').getPublicUrl(storagePath);
    const videoUrl = urlData.publicUrl;
    console.log(`[render] Uploaded: ${videoUrl}`);

    // 6. Update shorts_projects
    await supabase
      .from('shorts_projects')
      .update({ video_url: videoUrl, status: 'rendered', progress: 100, progress_step: 'done' })
      .eq('id', project_id);

    // 7. Cleanup temp files
    fs.rmSync(workDir, { recursive: true, force: true });

    res.json({ video_url: videoUrl });
  } catch (err) {
    console.error('[render] Error:', err);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message || 'Render failed' });
  }
});

// ============ POST /upload/youtube ============
app.post('/upload/youtube', async (req, res) => {
  const { user_id, project_id, title, description, tags } = req.body;

  if (!user_id || !project_id) {
    return res.status(400).json({ error: 'Missing user_id or project_id' });
  }

  try {
    // 1. Get channel tokens
    const { data: channel, error: chErr } = await supabase
      .from('connected_channels')
      .select('*')
      .eq('user_id', user_id)
      .eq('platform', 'youtube')
      .eq('is_active', true)
      .single();

    if (chErr || !channel) throw new Error('YouTube not connected');

    // 2. Refresh token if expired
    let accessToken = channel.access_token;
    if (channel.token_expires_at && new Date(channel.token_expires_at) < new Date()) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.YOUTUBE_CLIENT_ID || '',
          client_secret: process.env.YOUTUBE_CLIENT_SECRET || '',
          refresh_token: channel.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      if (!refreshRes.ok) throw new Error('Token refresh failed');
      const tokens = await refreshRes.json();
      accessToken = tokens.access_token;
      await supabase
        .from('connected_channels')
        .update({
          access_token: accessToken,
          token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        })
        .eq('id', channel.id);
    }

    // 3. Get video from project
    const { data: project } = await supabase
      .from('shorts_projects')
      .select('video_url')
      .eq('id', project_id)
      .single();

    if (!project?.video_url) throw new Error('No video found for this project');

    // 4. Download video to temp
    const tmpPath = path.join(TEMP_DIR, `yt_${project_id}.mp4`);
    await downloadFile(project.video_url, tmpPath);
    const videoBuffer = fs.readFileSync(tmpPath);

    // 5. Upload to YouTube using resumable upload
    const metadataRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(videoBuffer.length),
        },
        body: JSON.stringify({
          snippet: {
            title: title || 'FrozoAI Short',
            description: description || '',
            tags: tags || [],
            categoryId: '22',
          },
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        }),
      }
    );

    if (!metadataRes.ok) {
      const errText = await metadataRes.text();
      throw new Error(`YouTube metadata error: ${errText}`);
    }

    const uploadUrl = metadataRes.headers.get('Location');
    if (!uploadUrl) throw new Error('No upload URL from YouTube');

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(videoBuffer.length) },
      body: videoBuffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`YouTube upload error: ${errText}`);
    }

    const ytData = await uploadRes.json();

    // 6. Update project
    await supabase
      .from('shorts_projects')
      .update({ status: 'published' })
      .eq('id', project_id);

    // 7. Log upload
    await supabase.from('video_upload_logs').insert({
      user_id,
      project_id,
      platform: 'youtube',
      status: 'success',
      platform_video_id: ytData.id,
    });

    // Cleanup
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    res.json({ success: true, youtube_video_id: ytData.id, url: `https://youtube.com/shorts/${ytData.id}` });
  } catch (err) {
    console.error('[youtube-upload] Error:', err);
    await supabase.from('video_upload_logs').insert({
      user_id,
      project_id,
      platform: 'youtube',
      status: 'failed',
      error_message: err.message,
    });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ============ YouTube OAuth routes ============
const oauthStates = new Map();

app.get('/auth/youtube', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const state = crypto.randomUUID();
  oauthStates.set(state, { user_id, created: Date.now() });

  for (const [k, v] of oauthStates) {
    if (Date.now() - v.created > 600000) oauthStates.delete(k);
  }

  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI || '',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  const stateData = oauthStates.get(state);
  if (!stateData) return res.status(400).send('Invalid state');
  oauthStates.delete(state);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID || '',
        client_secret: process.env.YOUTUBE_CLIENT_SECRET || '',
        redirect_uri: process.env.YOUTUBE_REDIRECT_URI || '',
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokens = await tokenRes.json();

    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    const channelData = await channelRes.json();
    const channelName = channelData.items?.[0]?.snippet?.title || 'YouTube Channel';

    await supabase.from('connected_channels').upsert({
      user_id: stateData.user_id,
      platform: 'youtube',
      channel_name: channelName,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      is_active: true,
    }, { onConflict: 'user_id,platform' });

    const frontendUrl = process.env.FRONTEND_URL || 'https://frozoai.com';
    res.redirect(`${frontendUrl}/video/settings?connected=youtube`);
  } catch (err) {
    console.error('[youtube-callback] Error:', err);
    res.status(500).send('YouTube connection failed. Please try again.');
  }
});

app.post('/auth/youtube/disconnect', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  await supabase.from('connected_channels').delete().eq('user_id', user_id).eq('platform', 'youtube');
  res.json({ success: true });
});

// Placeholder routes for Facebook / Instagram
app.get('/auth/facebook', (req, res) => res.status(501).json({ error: 'Facebook OAuth not implemented yet' }));
app.get('/auth/instagram', (req, res) => res.status(501).json({ error: 'Instagram OAuth not implemented yet' }));
app.post('/upload/facebook', (req, res) => res.status(501).json({ error: 'Facebook upload not implemented yet' }));
app.post('/upload/instagram', (req, res) => res.status(501).json({ error: 'Instagram upload not implemented yet' }));

app.listen(PORT, () => console.log(`🎬 FrozoAI Shorts Renderer running on port ${PORT}`));
