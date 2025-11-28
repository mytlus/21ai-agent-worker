import express from "express";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { Room, RoomEvent, createLocalAudioTrack } from "@livekit/rtc-node";

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
  console.warn(
    "⚠️ Missing LiveKit env vars in worker (LIVEKIT_WS_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)",
  );
}

// ------------------------------------------------------------
// Agent joins the LiveKit room as a server-side participant
// ------------------------------------------------------------
async function startAgent(roomName, livekitUrl, agentId) {
  try {
    const agentIdentity = `agent_${agentId}`;

    // 1) Create agent token using LiveKit Server SDK (v2)
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: agentIdentity,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const agentToken = await at.toJwt();
    console.log("🤖 Created agent token for identity:", agentIdentity);

    // 2) Connect to LiveKit as the agent
    const room = new Room();

    // Debug event logging
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 Participant connected:", p.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log(
        "🎧 Agent subscribed to track:",
        track.kind,
        "from",
        participant.identity,
      );
    });

    room.on(RoomEvent.Error, (err) => {
      console.error("❌ Room error:", err);
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log("👋 Agent disconnected from room:", roomName);
    });

    await room.connect(livekitUrl || LIVEKIT_WS_URL, agentToken);
    console.log("🤖 Agent joined room as:", agentIdentity);

    // 3) Publish a silent audio track to keep the agent "present"
    const silenceTrack = await createLocalAudioTrack({ silence: true });
    await room.localParticipant.publishTrack(silenceTrack);
    console.log("🔊 Agent audio track published (silent)");
  } catch (err) {
    console.error("❌ Failed to connect agent:", err);
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

    console.log("⚡ New start-session request:");
    console.log("livekitUrl:", livekitUrl);
    console.log("roomName:", roomName);
    console.log("agentId:", agentId);
    console.log("agentConfig:", agentConfig ? "received" : "none");

    if (!roomName || !agentId) {
      return res.status(400).json({
        ok: false,
        error: "roomName and agentId are required",
      });
    }

    // Fire-and-forget: start agent in the background
    startAgent(roomName, livekitUrl || LIVEKIT_WS_URL, agentId);

    // Respond back quickly – frontend already has its own token from Supabase
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
