// index.js – 21AI Agent Worker (LiveKit + ElevenLabs TTS)
// -------------------------------------------------------
// Expects POST /start-session with:
//   { livekitUrl, roomName, agentId, agentToken }
//
// Env vars in Railway:
//   LIVEKIT_WS_URL      (optional, mainly for logging)
//   ELEVENLABS_API_KEY  (required for TTS)

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

// We only *need* ELEVENLABS_API_KEY here. LiveKit URL and token come from Supabase.
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || "(provided per-request)";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Basic boot logs
console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL (env):", LIVEKIT_WS_URL);
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓ set" : "❌ MISSING");

// Global error logging
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// -------------------------------------------------------------
// ElevenLabs TTS → PCM 16k mono
// -------------------------------------------------------------
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

// Call ElevenLabs and get raw PCM 16k audio buffer
async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY is not set");
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
          // IMPORTANT: 16k mono PCM
          output_format: "pcm_16000",
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("❌ ElevenLabs TTS error response:", errText);
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    console.log("🎧 ElevenLabs PCM bytes:", buffer.length);

    return buffer;
  } catch (err) {
    console.error("❌ ElevenLabs request failed:", err);
    return null;
  }
}

// -------------------------------------------------------------
// Stream PCM to LiveKit in small frames (to avoid crackling)
// -------------------------------------------------------------
//
// We split the PCM into 20ms chunks:
//   16,000 samples/sec * 0.02s = 320 samples per frame (per channel)
// Each sample is Int16 (2 bytes), mono.

const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = Math.floor(
  (SAMPLE_RATE * FRAME_DURATION_MS) / 1000
);

// Push PCM buffer into LiveKit AudioSource as sequential frames
async function playPcmAsFrames(audioSource, pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    console.warn("⚠ playPcmAsFrames called with empty buffer");
    return;
  }

  // total samples (mono) = bytes / 2
  const totalSamples = Math.floor(pcmBuffer.length / 2);
  const pcmView = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    totalSamples
  );

  console.log("🎧 PCM total samples:", totalSamples);
  console.log("🎧 Using frame size (samples):", SAMPLES_PER_FRAME);

  let offset = 0;

  while (offset < totalSamples) {
    const remaining = totalSamples - offset;
    const frameSamples = Math.min(SAMPLES_PER_FRAME, remaining);

    // Create AudioFrame with sampleRate, channels, and samples per channel
    const frame = new AudioFrame(SAMPLE_RATE, NUM_CHANNELS, frameSamples);
    const frameView = new Int16Array(frame.data.buffer);

    // Copy this chunk
    for (let i = 0; i < frameSamples; i++) {
      frameView[i] = pcmView[offset + i];
    }

    // Send frame to LiveKit
    await audioSource.captureFrame(frame);

    offset += frameSamples;
  }

  console.log("📤 Finished streaming PCM frames to LiveKit");
}

// -------------------------------------------------------------
// Agent: join room + speak greeting once
// -------------------------------------------------------------
async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const identity = `agent_${agentId}_${Date.now()}`;

    console.log("🤖 startAgent -> room:", roomName);
    console.log("🤖 startAgent -> identity:", identity);
    console.log("🤖 startAgent -> url:", livekitUrl);

    const room = new Room();

    // Connect using the token generated by Supabase (start-agent-session)
    await room.connect(livekitUrl, agentToken);
    console.log("✅ Agent connected to LiveKit room:", roomName);

    // Debug events
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 Participant connected:", p.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log(
        "🎧 Track subscribed:",
        track.kind,
        "from",
        participant.identity
      );
    });

    // Create an AudioSource for 16k mono and publish as a "microphone" track
    const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack("agent-audio", audioSource);

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await room.localParticipant.publishTrack(track, publishOptions);
    console.log("🔊 Agent audio track published");

    // Generate greeting from ElevenLabs
    const greeting =
      "Hello, this is your twenty one A I voice receptionist. How can I help you today?";

    const pcm = await ttsElevenLabs(greeting);

    if (!pcm) {
      console.warn("⚠ No PCM from ElevenLabs, skipping greeting.");
      return;
    }

    console.log("🎧 ElevenLabs PCM samples:", pcm.length / 2);

    // Stream the greeting PCM as frames into LiveKit
    await playPcmAsFrames(audioSource, pcm);

    console.log("✅ Greeting audio sent to LiveKit");
  } catch (err) {
    console.error("❌ startAgent failed:", err);
  }
}

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

// Healthcheck
app.get("/", (req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

// Called by Supabase edge function: /start-session
app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentToken } = req.body || {};

    console.log("⚡ /start-session body:", JSON.stringify(req.body));

    if (!livekitUrl || !roomName || !agentId || !agentToken) {
      console.error("❌ Missing required fields in /start-session");
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        details: { livekitUrl, roomName, agentId, hasToken: !!agentToken },
      });
    }

    // Fire-and-forget: start the agent in the background
    startAgent({ livekitUrl, roomName, agentId, agentToken });

    return res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session failed:", err);
    return res.status(500).json({ ok: false, error: "worker_crash" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 21AI Agent Worker listening on port ${PORT}`);
});
