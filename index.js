// index.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Simple healthcheck
app.get("/health", (req, res) => {
  return res.json({ ok: true });
});

app.post("/start-session", (req, res) => {
  try {
    console.log("[worker] /start-session body:", JSON.stringify(req.body, null, 2));

    const {
      agentId,
      roomName,
      agentConfig = {},
      agentToken,
      livekitUrl,
      livekit_url,
      livekitApiKey,
      livekitApiSecret,
      livekit_api_key,
      livekit_api_secret,
      voice = {},
    } = req.body;

    // ---- basic validation ----
    const missing = [];
    if (!agentId) missing.push("agentId");
    if (!roomName) missing.push("roomName");
    if (!agentToken) missing.push("agentToken");

    if (missing.length) {
      console.error("[worker] missing required fields:", missing);
      return res.status(400).json({
        error: "missing_fields",
        missing,
        received: Object.keys(req.body),
      });
    }

    // Normalise LiveKit URL
    const lkUrl =
      livekitUrl ||
      livekit_url ||
      voice.livekitUrl ||
      voice.livekit_url ||
      process.env.LIVEKIT_URL;

    if (!lkUrl) {
      console.error("[worker] missing livekit URL");
      return res.status(400).json({
        error: "missing_livekit_url",
      });
    }

    // Normalise API keys (optional)
    const lkApiKey =
      livekitApiKey || livekit_api_key || process.env.LIVEKIT_API_KEY || null;
    const lkApiSecret =
      livekitApiSecret ||
      livekit_api_secret ||
      process.env.LIVEKIT_API_SECRET ||
      null;

    // ---- IMPORTANT: echo back config in a frontend-friendly shape ----
    return res.json({
      ok: true,

      // core identifiers
      agentId,
      roomName,

      // full config back to client
      agentConfig,

      // token fields (give both names, in case frontend expects one)
      token: agentToken,
      agentToken,

      // URL fields – AGAIN, give both
      livekitUrl: lkUrl,
      wsUrl: lkUrl,

      // Optional keys
      livekitApiKey: lkApiKey,
      livekitApiSecret: lkApiSecret,
    });
  } catch (err) {
    console.error("[worker] Error in /start-session:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err?.message ?? String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`[worker] Dispatcher listening on port ${PORT}`);
});
