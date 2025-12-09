// index.js
import express from "express";
import cors from "cors";
import { Agent, LiveKitTransport } from "@livekit/agents";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Simple healthcheck
app.get("/health", (req, res) => {
  return res.json({ ok: true });
});

// ---- LiveKit agent runner ----
async function runAgentSession(agentToken, roomName, agentConfig = {}, livekitUrl) {
  console.log("[worker] Starting agent session…");

  try {
    // 1 — Create LiveKit transport
    const transport = await LiveKitTransport.create({
      url: livekitUrl,
      token: agentToken,
      room: {
        autoSubscribe: true,
      },
    });

    console.log("[worker] Connected to LiveKit room:", roomName);

    // 2 — Create an AI Agent instance
    const agent = new Agent({
      transport,
      model: {
        provider: "openai",
        model: agentConfig?.model || "gpt-4o-mini",
        systemPrompt:
          agentConfig?.systemPrompt || "You are a helpful assistant.",
      },
      voice: {
        provider: "openai",
        voiceId: agentConfig?.voice?.voice_id || "verse",
      },
    });

    // 3 — Start the agent realtime loop
    await agent.start();
    console.log("[worker] Agent started and publishing audio.");
  } catch (err) {
    console.error("[worker] ERROR in runAgentSession:", err);
  }
}

// ---- HTTP endpoint ----
app.post("/start-session", async (req, res) => {
  try {
    console.log(
      "[worker] /start-session body:",
      JSON.stringify(req.body, null, 2)
    );

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

    // Normalise API keys (if you ever need them on server side)
    const lkApiKey =
      livekitApiKey || livekit_api_key || process.env.LIVEKIT_API_KEY || null;
    const lkApiSecret =
      livekitApiSecret ||
      livekit_api_secret ||
      process.env.LIVEKIT_API_SECRET ||
      null;

    // (Optional) log that we resolved them, but **never** log actual secrets
    if (lkApiKey) console.log("[worker] LiveKit API key available (server-side).");

    // ---- Start agent session (do NOT await, so HTTP returns immediately) ----
    runAgentSession(agentToken, roomName, agentConfig, lkUrl).catch((err) =>
      console.error("[worker] runAgentSession top-level error:", err)
    );

    // ---- Respond to client (no secrets) ----
    return res.json({
      ok: true,
      agentId,
      roomName,
      livekitUrl: lkUrl,
    });
  } catch (err) {
    console.error("[worker] Error in /start-session:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err?.message ?? String(err),
    });
  }
});

// ---- Start HTTP server ----
app.listen(PORT, () => {
  console.log(`[worker] Dispatcher listening on port ${PORT}`);
});
