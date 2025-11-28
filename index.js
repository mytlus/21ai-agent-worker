import express from "express";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { Room, RoomEvent, AudioSource } from "@livekit/rtc-node";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ENV VARS FROM RAILWAY
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("LiveKit Worker Booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL ? "✓" : "❌ missing");
console.log("LIVEKIT_API_KEY:", LIVEKIT_API_KEY ? "✓" : "❌ missing");
console.log("LIVEKIT_API_SECRET:", LIVEKIT_API_SECRET ? "✓" : "❌ missing");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓" : "❌ missing");

// Audio config for ElevenLabs + LiveKit
const SAMPLE_RATE = 16000;
const CHANNELS = 1;

// simple sleep helper for pacing frames
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// ElevenLabs TTS → Int16Array PCM (16kHz mono)
// -------------------------------------------------------------
async function ttsElevenLabs(text) {
  try {
    const voiceId = "EXAVITQu4vr4xnSDxMaL"; // Default ElevenLabs voice

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
      console.error("❌ ElevenLabs TTS Error:", await res.text());
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const pcm16 = new Int16Array(arrayBuffer);

    console.log("🎧 ElevenLabs PCM samples:", pcm16.length);
    return pcm16;
  } catch (err) {
    console.error("❌ ElevenLabs request failed:", err);
    return null;
  }
}

// -------------------------------------------------------------
// Agent joins room & speaks greeting
// -------------------------------------------------------------
async function startAgent(roomName, agentId) {
  try {
    const identity = `agent_${agentId}_${Date.now()}`;

    // 1) Create LiveKit token
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const agentToken = token.toJwt();

    // 2) Connect to room
    const room = new Room();
    await room.connect(LIVEKIT_WS_URL, agentToken);

    console.log("🤖 Agent joined room:", roomName, "as", identity);

    // Log participants
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("👤 Caller connected:", p.identity);
    });

    // 3) Create an audio source (16kHz mono)
    const audioSource = new AudioSource(SAMPLE_RATE, CHANNELS);
    const track = audioSource.createTrack();
    await room.localParticipant.publishTrack(track);

    console.log("🔊 Agent audio track published");

    // 4) Generate greeting via ElevenLabs
    const greeting =
      "Hello, this is your twenty one A I voice assistant. How can I help you today?";
    const pcm = await ttsElevenLabs(greeting);

    if (!pcm) {
      console.log("⚠ No PCM from ElevenLabs");
      return true;
    }

    console.log("📤 Streaming greeting audio to room...");

    // 20ms of audio at 16kHz mono = 320 samples per frame
    const frameSamples = SAMPLE_RATE * CHANNELS * 0.02; // 320
    for (let i = 0; i < pcm.length; i += frameSamples) {
      const frame = pcm.subarray(i, i + frameSamples);
      audioSource.write(frame);
      await sleep(20); // pace to real time
    }

    console.log("✅ Finished sending greeting audio");
    return true;
  } catch (err) {
    console.error("❌ Agent connection failed:", err);
  }
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Healthcheck
app.get("/", (req, res) => {
  res.send("21ai Agent Worker is running ✅");
});

// 🔍 LiveKit Connectivity Test
app.get("/livekit-test", async (req, res) => {
  const report = {
    env: {
      LIVEKIT_WS_URL: !!LIVEKIT_WS_URL,
      LIVEKIT_API_KEY: !!LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: !!LIVEKIT_API_SECRET,
    },
    token: {
      ok: false,
      error: null,
    },
    connect: {
      ok: false,
      error: null,
    },
  };

  // 1) Check envs
  if (!LIVEKIT_WS_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    report.token.error = "Missing one or more LiveKit env vars";
    return res.status(500).json(report);
  }

  // 2) Try to generate a token
  const testRoom = "livekit-test-room";
  const testIdentity = `test_client_${Date.now()}`;

  let jwt;
  try {
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: testIdentity,
    });

    token.addGrant({
      roomJoin: true,
      room: testRoom,
      canPublish: true,
      canSubscribe: true,
    });

    jwt = token.toJwt();
    report.token.ok = true;
  } catch (err) {
    console.error("❌ LiveKit test – token error:", err);
    report.token.error = String(err);
    return res.status(500).json(report);
  }

  // 3) Try to connect & disconnect
  try {
    const room = new Room();

    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("🔍 [livekit-test] Participant connected:", p.identity);
    });

    console.log("🔍 [livekit-test] Connecting to", LIVEKIT_WS_URL);
    await room.connect(LIVEKIT_WS_URL, jwt);
    console.log("✅ [livekit-test] Connected as", testIdentity);

    await room.disconnect();
    console.log("✅ [livekit-test] Disconnected cleanly");

    report.connect.ok = true;
    return res.json(report);
  } catch (err) {
    console.error("❌ LiveKit test – connect error:", err);
    report.connect.error = String(err);
    return res.status(500).json(report);
  }
});

// Supabase -> worker
app.post("/start-session", async (req, res) => {
  try {
    const { roomName, agentId } = req.body;

    console.log("⚡ start-session received:");
    console.log("room:", roomName);
    console.log("agent:", agentId);
    ...
  } catch (err) {
    ...
  }
});
    // Fire and forget (join room + speak greeting)
    startAgent(roomName, agentId);

    return res.json({ ok: true, roomName, agentId });
  } catch (err) {
    console.error("❌ /start-session failed:", err);
    return res.status(500).json({ ok: false, error: "worker_crash" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 21ai Agent Worker listening on port ${PORT}`);
});
