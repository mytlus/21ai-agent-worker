// index.js – 21AI Agent Worker (LiveKit + ElevenLabs TTS, updated)

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

// ENV
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || ""; // fallback URL
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("🚀 21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL || "(not set, expecting per-request livekitUrl)");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓ set" : "❌ MISSING");

// Safety logs
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// ----------------------------------------------------
// Health endpoint
// ----------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    env: {
      hasLivekitWsUrl: !!LIVEKIT_WS_URL,
      hasElevenLabsKey: !!ELEVENLABS_API_KEY,
    },
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// ElevenLabs TTS → PCM 16kHz mono
// ----------------------------------------------------

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const FRAME_DURATION_MS = 20; // 20ms per frame
const SAMPLES_PER_FRAME = Math.floor((SAMPLE_RATE * FRAME_DURATION_MS) / 1000); // = 320

async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing");
      return null;
    }

    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // Default voice

    const response = await fetch(
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
          output_format: "pcm_16000",
        }),
      }
    );

    if (!response.ok) {
      console.error("❌ ElevenLabs TTS failed:", await response.text());
      return null;
    }

    const arrayBuf = await response.arrayBuffer();
    let buffer = Buffer.from(arrayBuf);

    // ⚠ Ensure buffer is even-numbered length (2 bytes per sample)
    if (buffer.length % 2 !== 0) {
      buffer = buffer.subarray(0, buffer.length - 1);
      console.warn("⚠ Trimmed odd byte for alignment");
    }

    console.log("🎧 PCM bytes:", buffer.length);
    return buffer;
  } catch (err) {
    console.error("❌ ElevenLabs request error:", err);
    return null;
  }
}

// ----------------------------------------------------
// PCM → LiveKit streaming
// ----------------------------------------------------

async function playPcmAsFrames(audioSource, pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    console.warn("⚠ Empty PCM buffer");
    return;
  }

  const totalSamples = pcmBuffer.length / 2;
  const pcmView = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    totalSamples
  );

  console.log("🎧 Total samples:", totalSamples);
  console.log("🎧 Samples per frame:", SAMPLES_PER_FRAME);

  let offset = 0;

  while (offset < totalSamples) {
    const remaining = totalSamples - offset;
    const frameSamples = Math.min(SAMPLES_PER_FRAME, remaining);

    const frameData = new Int16Array(frameSamples);
    for (let i = 0; i < frameSamples; i++) {
      frameData[i] = pcmView[offset + i];
    }

    const frame = new AudioFrame(
      frameData,
      SAMPLE_RATE,
      NUM_CHANNELS,
      frameSamples
    );

    await audioSource.captureFrame(frame);
    offset += frameSamples;

    await new Promise((res) => setTimeout(res, FRAME_DURATION_MS));
  }

  console.log("📤 Finished streaming audio");
}

// ----------------------------------------------------
// Agent join + greeting
// ----------------------------------------------------

async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const identity = `agent_${agentId || "unknown"}_${Date.now()}`;

    console.log("🤖 Agent starting:", identity);
    console.log("🔗 LiveKit URL:", livekitUrl);
    console.log("🏷  Room name:", roomName);

    if (!agentToken) {
      console.warn("⚠ No agentToken provided – cannot connect to LiveKit.");
      return;
    }

    const room = new Room();
    await room.connect(livekitUrl, agentToken);
    console.log("✅ Agent connected to room:", roomName);

    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 User joined:", p.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log("🎧 Subscribed to:", track.kind, "from", participant.identity);
    });

    // Init audio publishing
    const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack("agent-audio", audioSource);

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await room.localParticipant.publishTrack(track, publishOptions);
    console.log("🔊 Agent track published");

    // Speak greeting
    const greeting =
      "Hello, this is your Twenty One A I voice agent. How may I assist you today?";

    const pcm = await ttsElevenLabs(greeting);
    if (!pcm) {
      console.warn("⚠ No PCM produced");
      return;
    }

    await playPcmAsFrames(audioSource, pcm);
    console.log("✅ Greeting sent");
  } catch (err) {
    console.error("❌ Agent error:", err);
  }
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------

app.get("/", (_req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentToken } = req.body;

    console.log("⚡ /start-session payload:", req.body);

    // Normalise LiveKit URL: prefer request; fall back to env
    const resolvedLivekitUrl = livekitUrl || LIVEKIT_WS_URL || null;

    const missing = [];
    if (!resolvedLivekitUrl) missing.push("livekitUrl or LIVEKIT_WS_URL");
    if (!roomName) missing.push("roomName");
    if (!agentId) missing.push("agentId");
    // agentToken is optional for now (we will still warn)

    if (missing.length > 0) {
      console.warn("⚠ Missing required fields for /start-session:", missing);
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        missing,
        received: req.body,
      });
    }

    if (!agentToken) {
      console.warn(
        "⚠ /start-session: agentToken missing – returning ok but NOT starting agent audio."
      );
      return res.json({
        ok: true,
        roomName,
        agentId,
        warning: "agentToken missing – no audio started by worker",
      });
    }

    // Fire-and-forget
    startAgent({
      livekitUrl: resolvedLivekitUrl,
      roomName,
      agentId,
      agentToken,
    });

    res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session route error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------------------------------------
// ElevenLabs Browser TTS Endpoint (MP3)
// ----------------------------------------------------

app.post("/tts", async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing for /tts");
      return res.status(500).json({ ok: false, error: "tts_not_configured" });
    }

    const finalVoiceId = voiceId || "EXAVITQu4vr4xnSDxMaL";

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${finalVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          output_format: "mp3_44100_128",
        }),
      }
    );

    if (!response.ok) {
      console.error("❌ /tts error:", await response.text());
      return res.status(500).json({ ok: false, error: "tts_failed" });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);

    res.send(audioBuffer);
  } catch (err) {
    console.error("❌ /tts handler error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------------------------------------
// Start Server
// ----------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 21AI Agent Worker listening on port ${PORT}`);
});
