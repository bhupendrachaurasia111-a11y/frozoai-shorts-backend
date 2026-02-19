const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("FrozoAI Shorts Backend Running");
});

app.post("/render-short", async (req, res) => {
  const { script } = req.body;

  if (!script) {
    return res.status(400).json({ error: "Script required" });
  }

  // Placeholder response
  res.json({
    message: "Video rendering will happen here",
    scriptLength: script.length
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
