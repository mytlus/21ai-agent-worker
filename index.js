// index.js – MINIMAL STABLE 21ai agent worker (ESM / Express)

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SERVICE_NAME = '21ai-agent-worker';

// --- Health check ----------------------------------------------------------

app.get('/health', (req, res) => {
  console.log('[worker] GET /health');
  res.json({
    ok: true,
    service: SERVICE_NAME,
    uptimeSeconds: Math.round(process.uptime()),
    env: {
      nodeVersion: process.version,
    },
  });
});

// --- Start session (no LiveKit yet – just logs & returns ok) --------------

app.post('/start-session', async (req, res) => {
  const startTime = Date.now();
  console.log('[worker] POST /start-session payload:', JSON.stringify(req.body, null, 2));

  res.json({
    ok: true,
    receivedAt: new Date().toISOString(),
    latencyMs: Date.now() - startTime,
  });
});

// --- Start server ----------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[worker] ${SERVICE_NAME} listening on port ${PORT}`);
});
