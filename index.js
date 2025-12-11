import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// URL of your Python agent on Railway
const PYTHON_AGENT_URL =
  process.env.PYTHON_AGENT_URL ||
  "https://21ai-python-agent-production.up.railway.app";

app.get("/", (req, res) => {
  res.json({ ok: true, service: "21ai-agent-worker-root" });
});

app.get("/health", (req, res) => {
  console.log("[worker] /health check");
  res.json({ status: "ok", service: "21ai-agent-worker" });
});

app.post("/start-session", async (req, res) => {
  console.log("[worker] /start-session incoming:", JSON.stringify(req.body));

  try {
    const resp = await fetch(`${PYTHON_AGENT_URL}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });

    let data = null;
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

  // Always ACK quickly to LiveKit
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[worker] 21ai-agent-worker listening on port ${PORT}`);
});
