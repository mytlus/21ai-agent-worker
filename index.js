// index.js — Node Worker (Railway)
// PURPOSE: Dispatch a LiveKit Agent Job to join the room and speak

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const LIVEKIT_URL = process.env.LIVEKIT_URL; // e.g. https://twentyoneai-mjb9l6jc.livekit.cloud
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const base64 = (input) => Buffer.from(input).toString("base64");

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "21ai-agent-dispatcher" });
});

// -----------------------------------------------------------------------------
// START SESSION → Dispatch agent job to LiveKit
// -----------------------------------------------------------------------------
app.post("/start-session", async (req, res) => {
  console.log("[worker] Received start-session payload:", req.body);

  const { agentId, roomName, agentConfig } = req.body;

  if (!agentId || !roomName) {
    return res.status(400).json({
      ok: false,
      error: "Missing agentId or roomName",
    });
  }

  try {
    // -----------------------------------------------------------------------
    // DISPATCH AGENT JOB TO LIVEKIT
    // -----------------------------------------------------------------------
    const dispatchUrl = `${LIVEKIT_URL}/agents/dispatch`;

    const authHeader = base64(`${LIVEKIT_API_KEY}:${LIVEKIT_API_SECRET}`);

    const body = {
      id: `job_${Date.now()}`,
      agentId,
      room: roomName,
      metadata: {
        systemPrompt: agentConfig?.systemPrompt ?? "",
        model: agentConfig?.model ?? "gpt-4o-mini",
        voice: agentConfig?.voice?.voice_id ?? "verse",
      },
    };

    console.log("[worker] Dispatching job to LiveKit:", body);

    const response = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log("[worker] LiveKit dispatch response:", data);

    return res.json({ ok: true, dispatched: true, livekitResponse: data });
  } catch (err) {
    console.error("[worker] Error dispatching job:", err);
    return res.status(500).json({ ok: false, error: "dispatch_failed" });
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
app.listen(PORT, () =>
  console.log(`[worker] Dispatcher listening on port ${PORT}`)
);
