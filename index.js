import express from "express";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { connect } from "@livekit/rtc-node";

dotenv.config();

// Global error logging so we see any crashes
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!LIVEKIT_WS_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.warn("⚠️ Missing LiveKit env vars in worker (LIVEKIT_WS_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
}

// --- helper: start agent in background for a room ---
async function startAgentForSession(roomName, agentId) {
  try {
    const agentIdentity = `agent_${agentId}_${Date.now()}`;

    // 1) Create agent token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: agentIdentity,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const agentToken = at.toJwt();
    console.log("🤖 Created agent token for identity:", agentIdentity);

    // 2) Connect agent to LiveKit room
    const room = await connect(LIVEKIT_WS_URL, agentToken);
    console.log("🤖 Agent joined room:", roomName);

    // 3) Basic event logging
    room.on("participantConnected", (participant) => {
      console.log("👤 Caller joined:", participant.identity);
    });

    room.on("trackSubscribed", (track, publication, participant) => {
      console.log(
        "🎧 Agent subscribed to track:",
        track.kind,
        "from",
        participant.identity,
      );
    });

    room.on("disconnected", () => {
      console.log("👋 Agent disconnected from room:", roomName);
    });

    // We keep the room connection open; Railway keeps the process alive
  } catch (err) {
    console.error("❌ Error in startAgentForSession:", err);
  }
}

// Healthcheck
app.get("/", (req, res) => {
  res.send("21ai Agent Worker is running ✅");
});

// Start-session endpoint called by Supabase edge function
app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentConfig } = req.body || {};

    console.log("⚡ New start-session request:", {
      livekitUrl,
      roomName,
      agentId,
    });

    if (!roomName || !agentId) {
      return res.status(400).json({
        ok: false,
        error: "roomName and agentId are required",
      });
    }

    // Fire-and-forget: start agent in the background
    startAgentForSession(roomName, agentId);

    // Respond back to Supabase / frontend – we don't wait for agent to fully join
    return res.json({
      ok: true,
      roomName,
      agentId,
    });
  } catch (err) {
    console.error("❌ Error in /start-session:", err);
    return res.status(500).json({
      ok: false,
      error: "worker_failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 21ai Agent Worker listening on port ${PORT}`);
});
