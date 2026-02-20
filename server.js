const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =============================
   HEALTH CHECK
============================= */

app.get("/", (req, res) => {
  res.send("FrozoAI Shorts Backend Running 🚀");
});

/* =============================
   EXISTING RENDER ROUTE
============================= */

app.post("/render-short", async (req, res) => {
  const { script } = req.body;

  if (!script) {
    return res.status(400).json({ error: "Script required" });
  }

  res.json({
    message: "Video rendering will happen here",
    scriptLength: script.length
  });
});

/* =============================
   YOUTUBE OAUTH START
============================= */

app.get("/auth/youtube", async (req, res) => {
  const { user_id } = req.query;

  if (!process.env.YOUTUBE_CLIENT_ID) {
    return res.json({ status: "setup_required", message: "YouTube not configured" });
  }

  const scope = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly"
  ].join(" ");

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      state: user_id
    });

  res.redirect(authUrl);
});

/* =============================
   YOUTUBE CALLBACK
============================= */

app.get("/auth/youtube/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const userId = state;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokens = await tokenRes.json();

    if (!tokens.access_token) {
      return res.send("OAuth failed");
    }

    // Get channel info
    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`
        }
      }
    );

    const channelData = await channelRes.json();
    const channelName =
      channelData.items?.[0]?.snippet?.title || "YouTube Channel";

    // Store in Supabase
    await supabase.from("connected_channels").upsert({
      user_id: userId,
      platform: "youtube",
      channel_name: channelName,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      is_active: true
    });

    res.redirect(`${process.env.FRONTEND_URL}/video-settings?connected=youtube`);

  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth callback error");
  }
});

/* =============================
   DISCONNECT YOUTUBE
============================= */

app.post("/auth/youtube/disconnect", async (req, res) => {
  const { user_id } = req.body;

  await supabase
    .from("connected_channels")
    .delete()
    .eq("user_id", user_id)
    .eq("platform", "youtube");

  res.json({ success: true });
});

/* =============================
   UPLOAD TO YOUTUBE
============================= */

app.post("/upload/youtube", async (req, res) => {
  try {
    const { user_id, title, description, tags } = req.body;

    const { data } = await supabase
      .from("connected_channels")
      .select("*")
      .eq("user_id", user_id)
      .eq("platform", "youtube")
      .single();

    if (!data) {
      return res.json({ success: false, message: "Channel not connected" });
    }

    const accessToken = data.access_token;

    // Placeholder upload
    // (Real upload requires file + googleapis package)
    console.log("Uploading video for user:", user_id);

    res.json({
      success: true,
      message: "Upload logic ready. Add video file integration next."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* =============================
   FACEBOOK / INSTAGRAM PLACEHOLDERS
============================= */

app.get("/auth/facebook", (req, res) => {
  res.json({ message: "Facebook OAuth coming soon" });
});

app.get("/auth/instagram", (req, res) => {
  res.json({ message: "Instagram OAuth coming soon" });
});

/* =============================
   START SERVER
============================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
