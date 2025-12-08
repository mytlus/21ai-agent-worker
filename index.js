/****************************************************
 * 21ai LiveKit Agent Worker (Test-Tone Diagnostic)
 ****************************************************/

import {
  Room,
  RemoteParticipant,
  AudioSource,
  AudioFrame
} from "livekit-server-sdk";
import WebSocket from "ws";
import fetch from "node-fetch";

// ENV VARS
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
const TTS_MODE = process.env.TTS_MODE || "test";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// CONSTANTS
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_DURATION_MS;

// Create audio source
const audioSource = new AudioSource(SAMPLE_RATE, CHANNELS);

/****************************************************
 * INTERNAL: Generate a pure sine tone (440Hz)
 ****************************************************/
function generateTestTonePcm(seconds = 6, freq = 440) {
  const totalSamples = SAMPLE_RATE * seconds;
  const buffer = new Int16Array(totalSamples);

  console.log(`🎵 [TEST] Generating ${seconds}s test tone at ${freq}Hz`);

  for (let i = 0; i < totalSamples; i++) {
    buffer[i] = Math.round(
      Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 32767
    );
  }

  return buffer;
}

/****************************************************
 * STREAM PCM INTO LIVEKIT TRACK
 ****************************************************/
async function streamPcmToLivekit(pcm) {
  console.log(`🔊 [TEST] Streaming PCM: ${pcm.length} samples`);

  let offset = 0;

  while (offset < pcm.length) {
    const end = offset + SAMPLES_PER_FRAME;

    const frameSamples = pcm.subarray(offset, end);

    const frame = new AudioFrame(
      frameSamples,
      SAMPLE_RATE,
      CHANNELS,
      frameSamples.length
    );

    await audioSource.captureFrame(frame);

    await new Promise((res) => setTimeout(res, FRAME_DURATION_MS));
    offset = end;
  }

  console.log("📤 Finished streaming PCM");
}

/****************************************************
 * PRIMARY HANDLER
 ****************************************************/
export default async function handler(req, res) {
  console.log("🚀 /start-session called");

  try {
    const { roomName, agentToken } = req.body;

    console.log("🔑 Token:", agentToken ? "OK" : "MISSING");
    console.log("🏷 Room:", roomName);

    if (!agentToken || !roomName) {
      return res.status(400).json({ error: "Missing token or roomName" });
    }

    // CONNECT TO LIVEKIT
    const wsUrl = `${LIVEKIT_WS_URL}/rtc?access_token=${agentToken}`;
    console.log("🔗 Connecting to LiveKit:", wsUrl);

    const room = new Room({
      audioSource,
    });

    await room.connect(wsUrl);
    console.log("✅ Agent connected to room:", roomName);

    /*******************************************
     * STEP 1: ALWAYS PLAY TEST TONE IN TEST MODE
     *******************************************/
    if (TTS_MODE === "test") {
      console.log("🎵 TEST MODE ENABLED — playing internal sine wave");
      const pcm = generateTestTonePcm(6, 440);
      await streamPcmToLivekit(pcm);
      console.log("🎉 Test tone finished");
      return res.json({ ok: true, mode: "test-tone-played" });
    }

    res.json({ ok: true, mode: "no-test" });

  } catch (err) {
    console.error("❌ Worker error:", err);
    res.status(500).json({ error: err.message });
  }
}
