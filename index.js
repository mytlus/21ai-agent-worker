// index.js – 21AI Agent Worker (LiveKit + ElevenLabs TTS, streamed frames)

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

// ENV – LiveKit URL here is just for logging; frontend sends its own
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || "(provided per request)";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL (env):", LIVEKIT_WS_URL);
console.log(
  "ELEVENLABS_API_KEY:",
  ELEVENLABS_API_KEY ? "✓ set" : "❌ MISSING (no voice)"
);

// basic safety logging
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// -------------------------------------------------------------
// ElevenLabs TTS → raw PCM 16k mono (Buffer)
// -------------------------------------------------------------
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY not set – cannot do TTS");
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
          output_format: "pcm_16000", // 16kHz mono PCM
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("❌ ElevenLabs TTS error:", errText);
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
// Stream PCM to LiveKit in 20ms AudioFrame chunks
// -------------------------------------------------------------
const FRAME_DURATION_MS = 20; // 20ms frames
const SAMPLES_PER_FRAME = Math.floor(
  (SAMPLE_RATE * FRAME_DURATION_MS) / 1000
); // 16000 * 0.02 = 320 samples

async function playPcmAsFrames(audioSource, pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    console.warn("⚠ playPcmAsFrames called with empty buffer");
    return;
  }

  // PCM16 => 2 bytes per sample
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

    // Build a new Int16Array for this frame
    const frameData = new Int16Array(frameSamples);
    for (let i = 0; i < frameSamples; i++) {
      frameData[i] = pcmView[offset + i];
    }

    // IMPORTANT: correct AudioFrame ctor:
    // new AudioFrame(buffer:Int16Array, sampleRate, numChannels, samplesPerChannel)
    const frame = new AudioFrame(
      frameData,
      SAMPLE_RATE,
      NUM_CHANNELS,
      frameSamples
    );

    await audioSource.captureFrame(frame);
    offset += frameSamples;
  }

  console.log("📤 Finished streaming PCM frames to LiveKit");
}

// -------------------------------------------------------------
// Agent: join room using token from Supabase + speak greeting
// -------------------------------------------------------------
async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const identity = `agent_${agentId}_${Date.now()}`;

    console.log("🤖 startAgent -> room:", roomName);
    console.log("🤖 startAgent -> identity:", identity);
    console.log("🤖 startAgent -> url:", livekitUrl);

    const room = new Room();
    await room.connect(livekitUrl, agentToken);
    console.log("✅ Agent connected to LiveKit room:", roomName);

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

    // Create an AudioSource + track to publish TTS
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

    await playPcmAsFrames(audioSource, pcm);

    console.log("✅ Greeting audio sent to LiveKit");
  } catch (err) {
    console.error("❌ startAgent failed:", err);
  }
}

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

// Healthcheck
app.get("/", (req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

// Supabase → Worker hook
app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentToken } = req.body || {};

    console.log("⚡ /start-session body:", JSON.stringify(req.body));

    if (!livekitUrl || !roomName || !agentId || !agentToken) {
      console.error("❌ Missing fields in /start-session");
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        details: {
          livekitUrl: !!livekitUrl,
          roomName,
          agentId,
          hasToken: !!agentToken,
        },
      });
    }

    // Fire-and-forget agent join + greet
    startAgent({ livekitUrl, roomName, agentId, agentToken });

    return res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session failed:", err);
    return res.status(500).json({ ok: false, error: "worker_crash" });
  }
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`🚀 21AI Agent Worker listening on port ${PORT}`);
});
