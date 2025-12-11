// index.js - 21ai agent worker (no TypeScript, pure JS)

const express = require("express");

// Node 18+ has global fetch, so we don't need node-fetch
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// URL of your Python agent on Railway
const PYTHON_AGENT_URL =
  process.env.PYTHON_AGENT_URL ||
  "https://21ai-python-agent-production.up.railway.app";

// -----------------------------------------------------------------------------
// Root + Health
// -----------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "21ai-agent-worker-root" });
});

app.get("/health", (req, res) => {
  console.log("[worker] /health check");
  res.json({ status: "ok", service: "21ai-agent-worker" });
});

// -----------------------------------------------------------------------------
// LiveKit /start-session → forward to Python /start
// -----------------------------------------------------------------------------
app.post("/start-session", async (req, res) => {
  console.log("[worker] /start-session incoming:", JSON.stringify(req.body));

  try {
    const resp = await fetch(`${PYTHON_AGENT_URL}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      data = { ok: false, error: "non_json_response" };
    }

    console.log(
      "[worker] Python /start response:",
      resp.status,
      JSON.stringify(data)
    );
  } catch (err) {
    console.error("[worker] Error calling Python /start:", err);
  }

  // Always ACK LiveKit quickly
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[worker] 21ai-agent-worker listening on port ${PORT}`);
});
