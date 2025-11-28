import express from "express";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { Room, RoomEvent, AudioSource } from "@livekit/rtc-node";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- ENV VARS (from Railway) ---
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL ? "✓" : "❌ missing");
console.log("LIVEKIT_API_KEY:", LIVEKIT_API_KEY ? "✓" : "❌ missing");
console.log("LIVEKIT_API_SECRET:", LIVEKIT_API_SECRET ? "✓" : "❌ missing");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓" : "❌ missing");

// -------------------------------------------------------------
// ElevenLabs TTS → PCM 16k audio buffer
// -------------------------------------------------------------
async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing, cannot call TTS");
      return null;
    }

    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // default voice

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
          },
          output_format: "pcm_16000", // required for LiveKit
        }),
      }
    );

    if (!res.ok) {
      console.error("❌ ElevenLabs TTS HTTP error:", res.status);
      console.error(await res.text());
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    console.log("🎧 ElevenLabs PCM bytes:", buf.length);
    return buf;
  } catch (err) {
    console.error("❌ ElevenLabs TTS failed:", err);
    return null;
  }
}

// -------------------------------------------------------------
// Join LiveKit room & play a greeting
// -------------------------------------------------------------
async function startAgent(roomName, agentLabel, livekitUrlOverride) {
  try {
    const wsUrl = livekitUrlOverride || LIVEKIT_WS_URL;
    if (!wsUrl) {
      console.error("❌ No LiveKit WS URL provided");
      return;
    }

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      console.error("❌ LiveKit API key/secret missing");
      return;
    }

    const identity = `agent_${agentLabel || "default"}_${Date.now()}`;

    // 1) Create LiveKit token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: 60 * 30, // 30 mins
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = at.toJwt();

    // 2) Connect to room
    const room = new Room();

    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 Participant connected:", p.identity);
    });

    room.on(RoomEvent.Error, (err) => {
      console.error("❌ Room error:", err);
    });

    await room.connect(wsUrl, token);
    console.log("🤖 Agent joined room:", roomName, "as", identity);

    // 3) Create audio source & publish track
    const audioSource = new AudioSource(16000, 1);
    const track = audioSource.createTrack();
    await room.localParticipant.publishTrack(track);
    console.log("🔊 Agent audio track published");

    // 4) Generate greeting via ElevenLabs
    const greeting =
      "Hi, this is your twenty one A I receptionist. How can I help you today?";
    const pcm = await ttsElevenLabs(greeting);

    if (pcm) {
      console.log("📤 Sending greeting audio to room...");
      audioSource.write(pcm);
    } else {
      console.log("⚠ No PCM returned from ElevenLabs");
    }
  } catch (err) {
    console.error("❌ startAgent failed:", err);
  }
}

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

// Healthcheck
app.get("/", (req, res) => {
  res.send("21ai Agent Worker is running ✅");
});

// Called by Supabase edge function
app.post("/start-session", async (req, res) => {
  try {
    console.log("⚡ /start-session body:", JSON.stringify(req.body || {}));

    const body = req.body || {};

    // Lovable sends: livekitUrl, roomName, agentToken, agentConfig, ...
    const roomName =
      body.roomName || body.room || body.room_name || body.room_id;
    const agentId =
      body.agentId ||
      (body.agentConfig && (body.agentConfig.id || body.agentConfig.name)) ||
      "onboarding";
    const livekitUrl = body.livekitUrl; // optional override

    if (!roomName) {
      console.error("❌ /start-session missing roomName");
      return res.status(400).json({
        ok: false,
        error: "missing_roomName",
      });
    }

    // Fire-and-forget: don’t block the HTTP response
    startAgent(roomName, agentId, livekitUrl).catch((err) =>
      console.error("❌ startAgent error:", err)
    );

    return res.json({
      ok: true,
      roomName,
      agentId,
    });
  } catch (err) {
    console.error("❌ /start-session crashed:", err);
    return res.status(500).json({
      ok: false,
      error: "worker_crash",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Worker ready on port ${PORT}`);
});
