import express from "express";
import dotenv from "dotenv";
import { Room, RoomEvent, AudioSource } from "@livekit/rtc-node";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

console.log("21AI Agent Worker booted");
console.log("LIVEKIT_WS_URL:", LIVEKIT_WS_URL ? "✓" : "❌ missing");
console.log("ELEVENLABS_API_KEY:", ELEVENLABS_API_KEY ? "✓" : "❌ missing");

// ElevenLabs → PCM (16kHz mono)
async function ttsElevenLabs(text) {
  try {
    const voiceId = "EXAVITQu4vr4xnSDxMaL";

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          output_format: "pcm_16000"
        })
      }
    );

    if (!res.ok) {
      console.error("❌ ElevenLabs error:", await res.text());
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("❌ ElevenLabs failed:", err);
    return null;
  }
}

// Connect agent to room and speak greeting
async function startAgent({ livekitUrl, roomName, agentId, agentToken }) {
  try {
    const url = livekitUrl || LIVEKIT_WS_URL;

    const room = new Room();
    await room.connect(url, agentToken);
    console.log("🤖 Agent joined:", roomName);

    const audioSource = new AudioSource(16000, 1);
    const track = audioSource.createTrack();
    await room.localParticipant.publishTrack(track);

    const greeting =
      "Hello, this is your twenty one A I receptionist. How can I help you today?";

    const pcm = await ttsElevenLabs(greeting);
    if (pcm) {
      audioSource.write(pcm);
      console.log("🎧 Greeting sent");
    }
  } catch (err) {
    console.error("❌ Agent failed:", err);
  }
}

// Healthcheck
app.get("/", (req, res) => {
  res.send("21ai Agent Worker running");
});

// Supabase → Worker
app.post("/start-session", async (req, res) => {
  const { livekitUrl, roomName, agentId, agentToken } = req.body || {};

  if (!roomName || !agentToken) {
    return res.status(400).json({ ok: false, error: "missing parameters" });
  }

  console.log("⚡ start-session received", roomName);

  startAgent({ livekitUrl, roomName, agentId, agentToken });

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 Worker ready on port", PORT);
});
