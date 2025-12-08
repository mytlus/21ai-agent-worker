// index.js – 21AI Agent Worker (LiveKit + ElevenLabs TTS, with test-tone switch)

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

const PORT = process.env.PORT || 8080;

// -------------------------
// ENV
// -------------------------
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || "(provided per request)";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Simple toggle: true = play sine beep, false = use ElevenLabs TTS
const USE_TEST_TONE = false;

console.log("🚀 21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL);
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓ set" : "❌ MISSING");

// Safety logs
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// ----------------------------------------------------
// Audio constants
// ----------------------------------------------------
const SAMPLE_RATE = 16000;       // must match ElevenLabs PCM format
const NUM_CHANNELS = 1;
const FRAME_DURATION_MS = 20;    // 20ms per frame
const SAMPLES_PER_FRAME = Math.floor(
  (SAMPLE_RATE * FRAME_DURATION_MS) / 1000
); // 320 samples @ 16kHz

// Small helper
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ----------------------------------------------------
// ElevenLabs TTS → PCM 16kHz mono
// ----------------------------------------------------
async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing");
      return null;
    }

    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // default voice

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
          output_format: "pcm_16000", // ← CRITICAL: raw PCM, 16kHz mono
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
          },
        }),
      }
    );

    if (!response.ok) {
      console.error("❌ ElevenLabs TTS failed:", await response.text());
      return null;
    }

    const arrayBuf = await response.arrayBuffer();
    let buffer = Buffer.from(arrayBuf);

    // Ensure even number of bytes (2 bytes per 16-bit sample)
    if (buffer.length % 2 !== 0) {
      buffer = buffer.subarray(0, buffer.length - 1);
      console.warn("⚠ Trimmed odd byte for alignment");
    }

    console.log("🎧 PCM bytes from ElevenLabs:", buffer.length);
    return buffer;
  } catch (err) {
    console.error("❌ ElevenLabs request error:", err);
    return null;
  }
}

// ----------------------------------------------------
// Optional: generate a simple sine beep for testing
// ----------------------------------------------------
function generateSinePcm(durationMs = 1000, frequency = 440) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const pcm = new Int16Array(totalSamples);

  const amplitude = 0.3 * 32767; // 30% to avoid clipping
  const twoPiF = 2 * Math.PI * frequency;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    pcm[i] = Math.round(Math.sin(twoPiF * t) * amplitude);
  }

  // Return as Buffer so we reuse playPcmAsFrames
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

// ----------------------------------------------------
// PCM → LiveKit streaming
// ----------------------------------------------------
async function playPcmAsFrames(audioSource, pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    console.warn("⚠ Empty PCM buffer");
    return;
  }

  const totalSamples = pcmBuffer.length / 2; // 2 bytes per Int16 sample
  const pcmView = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    totalSamples
  );

  console.log("🎧 Total samples:", totalSamples);
  console.log("🎧 Samples per frame:", SAMPLES_PER_FRAME);
  console.log(
    "🎧 Approx total frames:",
    Math.ceil(totalSamples / SAMPLES_PER_FRAME)
  );

  let offset = 0;

  while (offset < totalSamples) {
    const remaining = totalSamples - offset;
    const frameSamples = Math.min(SAMPLES_PER_FRAME, remaining);

    // Copy this frame’s samples into a new Int16Array
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

    // Pace frames to real-time (~20ms per frame)
    await sleep(FRAME_DURATION_MS);
  }

  console.log("📤 Finished streaming audio");
}

// ----------------------------------------------------
// Agent join + greeting / test tone
// ----------------------------------------------------
async function startAgent({ livekitUrl, roomName, agentId, agentToken, agentConfig }) {
  try {
    const identity = `agent_${agentId}_${Date.now()}`;
    console.log("🤖 Agent starting:", identity);
    console.log("🔗 LiveKit URL:", livekitUrl);
    console.log("🏷  Room name:", roomName);
    console.log("🛡  Agent token present:", !!agentToken);

    const room = new Room();

    // Connect to LiveKit room using agent token
    await room.connect(livekitUrl, agentToken);
    console.log("✅ Agent connected to room:", roomName);

    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 User joined:", p.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log("🎧 TrackSubscribed:", {
        participant: participant.identity,
        kind: track.kind,
        source: pub.source,
      });
    });

    // Init audio publishing
    const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack("agent-audio", audioSource);

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await room.localParticipant.publishTrack(track, publishOptions);
    console.log("🔊 Agent audio track published");

    // --- Choose between test tone and real TTS ---

    if (USE_TEST_TONE) {
      console.log("🔊 Playing TEST TONE (440Hz, 1s) instead of TTS...");
      const pcm = generateSinePcm(1000, 440);
      await playPcmAsFrames(audioSource, pcm);
      console.log("✅ Test tone sent");
    } else {
      const greeting =
        "Hello, this is your Twenty One A I voice agent. How may I assist you today?";

      const pcm = await ttsElevenLabs(greeting);
      if (!pcm) {
        console.warn("⚠ No PCM produced from ElevenLabs – skipping playback");
        return;
      }

      await playPcmAsFrames(audioSource, pcm);
      console.log("✅ Greeting sent");
    }
  } catch (err) {
    console.error("❌ Agent error:", err);
  }
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------
app.get("/", (req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

app.post("/start-session", async (req, res) => {
  try {
    const {
      livekitUrl,
      roomName,
      agentId,
      agentToken,
      agentConfig,
      // passthrough keys from Supabase if needed:
      livekitApiKey,
      livekitApiSecret,
      wsUrl,
    } = req.body || {};

    console.log("⚡ /start-session payload:", {
      agentId,
      roomName,
      hasAgentToken: !!agentToken,
      livekitUrl: livekitUrl || LIVEKIT_WS_URL,
      hasAgentConfig: !!agentConfig,
      voiceProvider: agentConfig?.voice?.provider,
      voiceId: agentConfig?.voice?.voice_id,
    });

    if (!livekitUrl && !LIVEKIT_WS_URL) {
      return res.status(400).json({
        ok: false,
        error: "missing_livekit_url",
      });
    }

    if (!roomName || !agentId) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        received: { roomName, agentId },
      });
    }

    if (!agentToken) {
      console.error("❌ /start-session: agentToken missing – cannot start agent");
      return res.status(400).json({
        ok: false,
        error: "missing_agent_token",
      });
    }

    const finalLivekitUrl = livekitUrl || LIVEKIT_WS_URL;

    // Fire-and-forget start
    startAgent({
      livekitUrl: finalLivekitUrl,
      roomName,
      agentId,
      agentToken,
      agentConfig,
      livekitApiKey,
      livekitApiSecret,
      wsUrl,
    });

    res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session route error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------------------------------------
// ElevenLabs Browser TTS Endpoint (MP3 for web UI)
// ----------------------------------------------------
app.post("/tts", async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};

    if (!text) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    if (!ELEVENLABS_API_KEY) {
      return res
        .status(500)
        .json({ ok: false, error: "missing_elevenlabs_api_key" });
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
