import express from "express";
import dotenv from "dotenv";
import { Room, RoomEvent, AudioSource } from "@livekit/rtc-node";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// We still keep LIVEKIT_WS_URL as a fallback,
// but the primary URL + TOKEN now come from Lovable.
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL ? "✓" : "⚠️ missing");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓" : "⚠️ missing");

// -------------------------------------------------------------
// ElevenLabs TTS → PCM Buffer
// -------------------------------------------------------------
async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY is missing");
      return null;
    }

    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // default ElevenLabs voice

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
          output_format: "pcm_16000", // 16kHz PCM for LiveKit
        }),
      }
    );

    if (!res.ok) {
      console.error("❌ ElevenLabs TTS HTTP error:", res.status, res.statusText);
      console.error("Body:", await res.text());
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    console.log("🎧 ElevenLabs PCM bytes:", buffer.length);
    return buffer;
  } catch (err) {
    console.error("❌ ElevenLabs request failed:", err);
    return null;
  }
}

// -------------------------------------------------------------
// Agent joins room & speaks greeting
// NOTE: we now USE the token from Lovable (agentToken)
// -------------------------------------------------------------
async function startAgent({ roomName, agentId, livekitUrl, agentToken }) {
  try {
    if (!agentToken) {
      throw new Error("agentToken is missing in worker payload");
    }

    const urlToUse = livekitUrl || LIVEKIT_WS_URL;
    if (!urlToUse) {
      throw new Error("No LiveKit URL provided (livekitUrl or LIVEKIT_WS_URL)");
    }

    const identity = `agent_${agentId || "unknown"}`;
    console.log("🤖 startAgent -> room:", roomName);
    console.log("🤖 startAgent -> identity:", identity);
    console.log("🤖 startAgent -> url:", urlToUse);

    const room = new Room();

    // ---- LiveKit connection using token from Supabase ----
    await room.connect(urlToUse, agentToken);
    console.log("✅ Agent connected to LiveKit room:", roomName);

    // log participants / tracks
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 Participant connected:", p.identity);
    });
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log(
        "🎧 Agent subscribed to track:",
        track.kind,
        "from",
        participant.identity
      );
    });
    room.on(RoomEvent.Error, (err) => {
      console.error("❌ LiveKit room error:", err);
    });

    // ---- Publish an audio track ----
    const audioSource = new AudioSource(16000, 1); // 16kHz mono
    const track = audioSource.createTrack();
    await room.localParticipant.publishTrack(track);
    console.log("🔊 Agent audio track published");

    // ---- Send a greeting via ElevenLabs ----
    const greeting =
      "Hello, this is your twenty one A I receptionist. How can I help you today?";
    const pcm = await ttsElevenLabs(greeting);

    if (pcm) {
      console.log("📤 Sending greeting audio to LiveKit…");
      audioSource.write(pcm);
    } else {
      console.log("⚠️ No PCM data from ElevenLabs, nothing to play.");
    }

    // We leave the room open so we can later extend to a full loop.
  } catch (err) {
    console.error("❌ startAgent failed:", err);
  }
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Healthcheck
app.get("/", (_req, res) => {
  res.send("21ai Agent Worker is running ✅");
});

// Called from Supabase edge function livekit-agent-worker
app.post("/start-session", async (req, res) => {
  try {
    const { roomName, agentId, livekitUrl, agentToken } = req.body || {};

    console.log("⚡ /start-session body:", JSON.stringify(req.body));

    if (!roomName || !agentId || !agentToken) {
      console.error("❌ Invalid /start-session payload");
      return res.status(400).json({
        ok: false,
        error: "roomName, agentId and agentToken are required",
      });
    }

    // fire-and-forget
    startAgent({ roomName, agentId, livekitUrl, agentToken }).catch((err) => {
      console.error("❌ startAgent crashed:", err);
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /start-session failed:", err);
    return res.status(500).json({ ok: false, error: "worker_crash" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Worker ready on port ${PORT}`);
});
