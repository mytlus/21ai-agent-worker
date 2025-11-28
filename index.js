// index.js – 21ai-agent-worker
// LiveKit rtc-node + ElevenLabs TTS (greeting only)

import express from "express";
import dotenv from "dotenv";
import {
  Room,
  RoomEvent,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- ENV VARS -------------------------------------------------

const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL; // fallback if livekitUrl not passed
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL ? "✓" : "❌ missing");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓" : "❌ missing");
console.log("🚀 Worker ready on port", PORT);

// -------------------------------------------------------------
// ElevenLabs TTS → Int16Array (PCM 16k mono)
// -------------------------------------------------------------
async function ttsElevenLabsToInt16(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing");
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
          // 16kHz mono raw PCM, required for rtc-node AudioSource(16000, 1)
          output_format: "pcm_16000",
        }),
      }
    );

    if (!res.ok) {
      console.error("❌ ElevenLabs TTS error:", await res.text());
      return null;
    }

    const uint8 = new Uint8Array(await res.arrayBuffer());
    // IMPORTANT: use subarray (not slice) when converting
    const int16 = new Int16Array(
      uint8.buffer,
      uint8.byteOffset,
      uint8.byteLength / 2
    );

    console.log("🎧 ElevenLabs PCM samples:", int16.length);
    return int16;
  } catch (err) {
    console.error("❌ ElevenLabs request failed:", err);
    return null;
  }
}

// -------------------------------------------------------------
// Agent joins room & plays greeting
// -------------------------------------------------------------
async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const url = livekitUrl || LIVEKIT_WS_URL;
    if (!url) {
      throw new Error("No LiveKit URL provided");
    }
    if (!agentToken) {
      throw new Error("No agentToken provided");
    }

    const identity = `agent_${agentId || "unknown"}_${Date.now()}`;
    console.log("🤖 startAgent -> room:", roomName);
    console.log("🤖 startAgent -> identity:", identity);
    console.log("🤖 startAgent -> url:", url);

    const room = new Room();

    // Basic event logs
    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        console.log("👤 Participant connected:", p.identity);
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        console.log(
          "🎧 Track subscribed:",
          track.kind,
          "from",
          participant.identity
        );
      })
      .on(RoomEvent.Disconnected, () => {
        console.log("👋 Agent disconnected from room:", roomName);
      });

    // 1) Connect using the token created in the Supabase edge function
    await room.connect(url, agentToken, {
      autoSubscribe: true,
      dynacast: true,
    });
    console.log("✅ Agent connected to LiveKit room:", roomName);

    // 2) Set up an AudioSource + LocalAudioTrack (correct rtc-node pattern)
    const source = new AudioSource(16000, 1); // 16kHz mono
    const track = LocalAudioTrack.createAudioTrack("agent-audio", source);

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await room.localParticipant.publishTrack(track, publishOptions);
    console.log("🔊 Agent audio track published");

    // 3) Generate greeting via ElevenLabs
    const greeting =
      "Hello, this is your twenty-one A I onboarding assistant. How can I help you set up your voice receptionist today?";
    const samples = await ttsElevenLabsToInt16(greeting);

    if (!samples) {
      console.log("⚠ No PCM from ElevenLabs, skipping greeting.");
      return;
    }

    // 4) Push one audio frame into the AudioSource
    const frame = new AudioFrame(samples, 16000, 1, samples.length);
    await source.captureFrame(frame);
    console.log("📤 Greeting audio frame sent to LiveKit");

    // We keep the room open; Railway will keep the process alive.
  } catch (err) {
    console.error("❌ startAgent failed:", err);
  }
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Healthcheck
app.get("/", (req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

// Called from Supabase start-agent-session edge function
app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentToken } = req.body || {};

    console.log("⚡ /start-session body:", JSON.stringify(req.body));

    if (!roomName || !agentId || !agentToken) {
      console.error("❌ /start-session missing fields");
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        received: { roomName, agentId, hasToken: !!agentToken },
      });
    }

    // Fire-and-forget – do not await, just start the async agent
    void startAgent({ livekitUrl, roomName, agentId, agentToken });

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /start-session failed:", err);
    return res.status(500).json({ ok: false, error: "worker_crash" });
  }
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`🚀 21AI Agent Worker listening on port ${PORT}`);
});
