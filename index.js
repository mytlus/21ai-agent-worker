import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// URL of your Python service on Railway, e.g.
// https://21ai-python-agent.up.railway.app
const PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL;

if (!PYTHON_AGENT_URL) {
  console.warn(
    "[worker] WARNING: PYTHON_AGENT_URL is not set. Set it in Railway env."
  );
}

app.use(cors());
app.use(express.json());

// Simple health check
app.get("/", (req, res) => {
  return res.json({ ok: true, service: "21ai-agent-worker" });
});

app.post("/start", async (req, res) => {
  const body = req.body || {};
  const { agentId, roomName, livekitUrl, agentConfig } = body;

  // 🔎 Minimal validation (this is where "missing_fields" was coming from before)
  const missing = [];
  if (!agentId) missing.push("agentId");
  if (!roomName) missing.push("roomName");
  if (!agentConfig) missing.push("agentConfig");
  if (!agentConfig?.agentToken) missing.push("agentConfig.agentToken");

  if (missing.length > 0) {
    console.error("[worker] missing required fields:", missing);
    return res.status(400).json({
      error: "missing_fields",
      missing,
      received: body,
    });
  }

  if (!PYTHON_AGENT_URL) {
    return res.status(500).json({
      error: "PYTHON_AGENT_URL_not_set",
    });
  }

  const payloadForPython = {
    agentId,
    roomName,
    livekitUrl: livekitUrl || process.env.LIVEKIT_URL || null,
    agentConfig: {
      agentToken: agentConfig.agentToken,
      systemPrompt:
        agentConfig.systemPrompt ||
        "You are a friendly receptionist for a small business.",
      model: agentConfig.model || "gpt-4o-mini",
      voiceId: agentConfig.voiceId || "alloy",
    },
  };

  console.log("[worker] Forwarding payload to python:", payloadForPython);

  try {
    const url = `${PYTHON_AGENT_URL}/run-agent`;
    const resp = await axios.post(url, payloadForPython, {
      timeout: 10_000,
    });

    console.log("[worker] Python service response:", resp.data);

    return res.json({
      ok: true,
      from: "21ai-agent-worker",
      pythonResponse: resp.data,
    });
  } catch (err) {
    console.error("[worker] Error calling python agent:", err.message);

    const status = err.response?.status || 500;
    const data = err.response?.data || { error: "unknown_error" };

    return res.status(status).json({
      error: "python_agent_error",
      detail: data,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[worker] 21ai-agent-worker listening on port ${PORT}`);
});
