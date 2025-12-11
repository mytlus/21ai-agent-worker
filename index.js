import express from "express";
import type { Request, Response } from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// URL of your Python agent on Railway
const PYTHON_AGENT_URL =
  process.env.PYTHON_AGENT_URL ||
  "https://21ai-python-agent-production.up.railway.app";

app.get("/health", (_req: Request, res: Response) => {
  console.log("[worker] /health check");
  res.json({ status: "ok", service: "21ai-agent-worker" });
});

app.post("/start-session", async (req: Request, res: Response) => {
  console.log("[worker] /start-session incoming:", JSON.stringify(req.body));

  try {
    const resp = await fetch(`${PYTHON_AGENT_URL}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await resp
      .json()
      .catch(() => ({ ok: false, error: "non_json_response" }));

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
