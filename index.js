// index.js - LiveKit test agent worker (Railway)

const express = require('express');
const cors = require('cors');

const {
  Room,
  RoomEvent,
  dispose,
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} = require('@livekit/rtc-node');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate an Int16 PCM sine wave buffer
function generateSinePcmInt16(frequency, durationSec, sampleRate) {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const data = new Int16Array(totalSamples);

  const amplitude = 0.25 * 0x7fff; // 25% of full scale to avoid clipping

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    data[i] = Math.round(sample * amplitude);
  }

  return data;
}

// ---------- Health check ----------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'livekit-test-worker',
    uptimeSeconds: Math.round(process.uptime()),
    livekitUrlConfigured: !!LIVEKIT_WS_URL,
  });
});

// ---------- Start session ----------

app.post('/start-session', async (req, res) => {
  const startTime = Date.now();
  console.log('[worker] POST /start-session payload:', JSON.stringify(req.body, null, 2));

  if (!LIVEKIT_WS_URL) {
    console.error('[worker] LIVEKIT_WS_URL is not set');
    return res.status(500).json({ ok: false, error: 'LIVEKIT_WS_URL not configured' });
  }

  const { agentToken } = req.body || {};

  if (!agentToken) {
    console.error('[worker] Missing agentToken in request body');
    return res.status(400).json({ ok: false, error: 'Missing agentToken' });
  }

  // Fire-and-forget so Supabase isn’t blocked
  runTestAgentSession(agentToken).catch((err) => {
    console.error('[worker] Unhandled error in runTestAgentSession:', err);
  });

  const elapsed = Date.now() - startTime;
  console.log(`[worker] /start-session returning ok in ${elapsed}ms`);
  return res.json({ ok: true });
});

// ---------- Core: join room & play test tone ----------

async function runTestAgentSession(agentToken) {
  const connectStarted = Date.now();
  console.log('[worker] ▶ Starting test agent session');

  const room = new Room();

  try {
    console.log('[worker] Connecting to LiveKit...', {
      livekitUrl: LIVEKIT_WS_URL,
    });

    await room.connect(LIVEKIT_WS_URL, agentToken, {
      autoSubscribe: true,
      dynacast: true,
    });

    console.log(
      '[worker] ✅ Connected to room as',
      room.localParticipant?.identity || '(no identity)',
      `in ${Date.now() - connectStarted}ms`
    );

    room.on(RoomEvent.Disconnected, () => {
      console.log('[worker] RoomEvent.Disconnected');
    });

    // ---- Publish test audio track ----
    const SAMPLE_RATE = 48000;       // 48kHz
    const DURATION_SEC = 6;          // 6 second tone
    const FREQUENCY_HZ = 440;        // A4

    console.log('[worker] Generating test tone PCM buffer...', {
      sampleRate: SAMPLE_RATE,
      durationSec: DURATION_SEC,
      frequencyHz: FREQUENCY_HZ,
    });

    const pcm = generateSinePcmInt16(FREQUENCY_HZ, DURATION_SEC, SAMPLE_RATE);
    console.log('[worker] Test tone generated', {
      samples: pcm.length,
    });

    const source = new AudioSource(SAMPLE_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-test-audio', source);

    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;

    console.log('[worker] Publishing local audio track...');
    await room.localParticipant.publishTrack(track, options);
    console.log('[worker] ✅ Local audio track published');

    // Create a single AudioFrame with the whole tone
    const frame = new AudioFrame(pcm, SAMPLE_RATE, 1, pcm.length);

    console.log('[worker] Capturing AudioFrame (sending test tone to room)...');
    await source.captureFrame(frame);
    console.log('[worker] ✅ AudioFrame captured (tone should be playing in the room)');

    // Keep the participant alive long enough for tone to play
    await sleep(DURATION_SEC * 1000 + 1500);

    console.log('[worker] Closing track & disconnecting...');
    await track.close();
    await room.disconnect();
    await dispose();

    console.log('[worker] ✅ Test agent session complete');
  } catch (err) {
    console.error('[worker] ❌ Error in runTestAgentSession:', err);
    try {
      await room.disconnect();
      await dispose();
    } catch (cleanupErr) {
      console.error('[worker] Error during cleanup:', cleanupErr);
    }
  }
}

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`[worker] LiveKit test worker listening on port ${PORT}`);
});
