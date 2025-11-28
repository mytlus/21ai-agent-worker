import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Healthcheck – used to see if the worker is alive
app.get("/", (req, res) => {
  res.send("21ai Agent Worker is running ✅");
});

// This is what Supabase will call
app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentToken, agentConfig } = req.body || {};

    console.log("🔔 New start-session request:");
    console.log("  livekitUrl:", livekitUrl);
    console.log("  roomName:", roomName);
    console.log("  agentId:", agentConfig?.id);

    // Later: connect to LiveKit + run STT → LLM → TTS
    res.json({ ok: true, message: "Worker received session payload" });
  } catch (err) {
    console.error("❌ Error in /start-session:", err);
    res.status(500).json({ ok: false, error: "Failed in worker" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 21ai Agent Worker listening on port ${PORT}`);
});
