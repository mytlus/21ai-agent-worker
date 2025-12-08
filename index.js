// index.js – 21AI Agent Worker (LiveKit + Internal Test Tone / ElevenLabs)

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
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || "(provided per request)";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TTS_MODE = process.env.TTS_MODE || "test"; // "test" | "elevenlabs"

console.log("🚀 21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL);
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓ set" : "❌ MISSING");
console.log("TTS_MODE:", TTS_MODE);

// Safety logs
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// ----------------------------------------------------
// Audio constants (16 kHz mono PCM)
// ----------------------------------------------------

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const FRAME_DURATION_MS = 20; // 20 ms
const SAMPLES_PER_FRAME = Math.floor((SAMPLE_RATE * FRAME_DURATION_MS) / 1000); // 320 samples
const BYTES_PER_SAMPLE = 2;
const FRAME_SIZE_BYTES = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;

// ----------------------------------------------------
// Helper: sleep
// ----------------------------------------------------

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ----------------------------------------------------
// INTERNAL TEST TONE (440 Hz sine, PCM 16-bit LE)
// ----------------------------------------------------

/**
 * Generate a PCM 16-bit mono test tone (sine) at 440 Hz.
 * Returns a Buffer containing raw PCM data at SAMPLE_RATE.
 */
function generateTestTonePcm(durationSeconds = 2, frequency = 440) {
  const totalSamples = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = new Int16Array(totalSamples);

  const amplitude = 0.25 * 32767; // avoid clipping
  const twoPiFDivSR = (2 * Math.PI * frequency) / SAMPLE_RATE;

  for (let i = 0; i < totalSamples; i++) {
    const sample = Math.sin(twoPiFDivSR * i);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.floor(amplitude * sample)));
  }

  console.log("🎼 Generated test tone:", {
    durationSeconds,
    frequency,
    totalSamples,
    bytes: totalSamples * BYTES_PER_SAMPLE,
  });

  // Create a Buffer that exactly wraps the Int16Array
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

// ----------------------------------------------------
// ElevenLabs TTS → PCM 16kHz mono (optional)
// ----------------------------------------------------

async function ttsElevenLabs(text) {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY missing");
      return null;
    }

    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // Default voice

    console.log("🗣 ElevenLabs TTS requested, text length:", text.length);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          // IMPORTANT: request PCM at 16 kHz mono
          output_format: "pcm_16000",
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

    // Ensure even length (2 bytes per sample)
    if (buffer.length % 2 !== 0) {
      console.warn("⚠ ElevenLabs PCM odd-length buffer, trimming 1 byte");
      buffer = buffer.subarray(0, buffer.length - 1);
    }

    const totalSamples = buffer.length / BYTES_PER_SAMPLE;

    console.log("🎧 ElevenLabs PCM stats:", {
      bytes: buffer.length,
      totalSamples,
      sampleRate: SAMPLE_RATE,
    });

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

  console.log("🎧 Streaming PCM to LiveKit:", {
    totalBytes: pcmBuffer.length,
    totalSamples: pcmBuffer.length / BYTES_PER_SAMPLE,
    frameSizeBytes: FRAME_SIZE_BYTES,
    samplesPerFrame: SAMPLES_PER_FRAME,
    frames: Math.ceil(pcmBuffer.length / FRAME_SIZE_BYTES),
  });

  let offset = 0;

  while (offset < pcmBuffer.length) {
    const endOffset = Math.min(offset + FRAME_SIZE_BYTES, pcmBuffer.length);

    // Use subarray, NOT slice
    const frameBytes = pcmBuffer.subarray(offset, endOffset);

    const int16Data = new Int16Array(
      frameBytes.buffer,
      frameBytes.byteOffset,
      frameBytes.length / BYTES_PER_SAMPLE
    );

    const frame = new AudioFrame(
      int16Data,
      SAMPLE_RATE,
      NUM_CHANNELS,
      int16Data.length // samples_per_channel
    );

    await audioSource.captureFrame(frame);
    await sleep(FRAME_DURATION_MS);
    offset = endOffset;
  }

  console.log("📤 Finished streaming audio");
}

// ----------------------------------------------------
// Agent join + greeting
// ----------------------------------------------------

async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const identity = `agent_${agentId}_${Date.now()}`;

    console.log("🤖 Agent starting:", identity);
    console.log("🔗 LiveKit URL:", livekitUrl);
    console.log("🏷  Room name:", roomName);
    console.log("TTS_MODE:", TTS_MODE);

    const room = new Room();
    await room.connect(livekitUrl, agentToken);
    console.log("✅ Agent connected to room:", roomName);

    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 User joined:", p.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      console.log("🎧 TrackSubscribed:", {
        identity: participant.identity,
        kind: track.kind,
        source: pub.source,
        trackSid: track.sid,
      });
    });

    // Init audio publishing at 16 kHz mono
    const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack("agent-audio", audioSource);

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await room.localParticipant.publishTrack(track, publishOptions);
    console.log("🔊 Agent track published");

    // ------------------------------------------------
    // Choose audio source based on TTS_MODE
    // ------------------------------------------------
    let pcm;

    if (TTS_MODE === "test") {
      console.log("🔬 Using INTERNAL TEST TONE for greeting (440 Hz)");
      pcm = generateTestTonePcm(2, 440);
    } else {
      const greeting =
        "Hello, this is your Twenty One A I voice agent. How may I assist you today?";
      pcm = await ttsElevenLabs(greeting);
    }

    if (!pcm) {
      console.warn("⚠ No PCM produced, nothing to stream");
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

app.get("/", (req, res) => {
  res.send("21AI Agent Worker is running ✅");
});

app.post("/start-session", async (req, res) => {
  try {
    const { livekitUrl, roomName, agentId, agentToken } = req.body;

    console.log("⚡ /start-session payload:", {
      agentId,
      roomName,
      hasAgentToken: !!agentToken,
      livekitUrl,
    });

    if (!livekitUrl || !roomName || !agentId) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        received: req.body,
      });
    }

    if (!agentToken) {
      console.error(
        "⚠ /start-session: agentToken missing – returning ok but NOT starting agent audio."
      );
      return res.json({
        ok: true,
        roomName,
        agentId,
        warning: "agentToken missing – agent not started",
      });
    }

    // Fire-and-forget
    startAgent({ livekitUrl, roomName, agentId, agentToken });

    res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session route error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------------------------------------
// ElevenLabs Browser TTS Endpoint (MP3 passthrough)
// ----------------------------------------------------

app.post("/tts", async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    const finalVoiceId = voiceId || "EXAVITQu4vr4xnSDxMaL";

    if (!ELEVENLABS_API_KEY) {
      return res
        .status(500)
        .json({ ok: false, error: "ELEVENLABS_API_KEY_missing" });
    }

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
