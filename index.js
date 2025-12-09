// index.js  (21ai-agent-worker)

// -------------------------
// Imports & basic setup
// -------------------------
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // or axios if you prefer

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------
// Middleware
// -------------------------
app.use(cors());
app.use(express.json());

// -------------------------
// Health check
// -------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "21ai-agent-worker" });
});

// -------------------------
// Helper: validate payload
// -------------------------
const REQUIRED_FIELDS = ["agentId", "roomName", "livekitUrl", "agentConfig"];

function validatePayload(body) {
  const missing = REQUIRED_FIELDS.filter(
    (field) => body[field] === undefined || body[field] === null
  );
  return missing;
}

// -------------------------
// Main route: start agent
// (You can change the path, but make sure your Python
// code calls THIS exact path/URL.)
// -------------------------
app.post("/run-agent", async (req, res) => {
  try {
    const body = req.body || {};

    const missing = validatePayload(body);
    if (missing.length > 0) {
      return res.status(400).json({
        error: "missing_fields",
        missing,
        received: Object.keys(body),
      });
    }

    const { agentId, roomName, livekitUrl, agentConfig } = body;

    console.log("🔵 Starting agent with payload:", {
      agentId,
      roomName,
      livekitUrl,
      hasAgentConfig: !!agentConfig,
    });

    // ----------------------------------------------------
    // TODO: Your agent logic goes here.
    // Example (pseudo-code):
    //
    // const response = await fetch(process.env.PIPECAT_URL, {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     Authorization: `Bearer ${process.env.PIPECAT_API_KEY}`,
    //   },
    //   body: JSON.stringify({
    //     agentId,
    //     roomName,
    //     livekitUrl,
    //     agentConfig,
    //   }),
    // });
    //
    // const result = await response.json();
    // if (!response.ok) {
    //   console.error("❌ Pipecat error:", result);
    //   return res.status(500).json({ error: "pipecat_error", detail: result });
    // }
    //
    // return res.json({ ok: true, result });
    // ----------------------------------------------------

    // Temporary stub so the route works even without Pipecat wired up:
    return res.json({
      ok: true,
      message: "Agent worker received payload and would start LiveKit session here.",
      debug: {
        agentId,
        roomName,
        livekitUrl,
        agentConfigKeys: Object.keys(agentConfig || {}),
      },
    });
  } catch (err) {
    console.error("🔥 Worker error:", err);
    return res.status(500).json({
      error: "internal_error",
      detail: err?.message || String(err),
    });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`🚀 21ai-agent-worker listening on port ${PORT}`);
});
