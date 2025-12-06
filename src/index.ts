import express, { Request, Response } from "express";
import dotenv from "dotenv";

// Load env variables from .env in local dev (Railway injects env vars automatically)
dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface StartSessionRequestBody {
  agentId?: string;
  roomName?: string;
  agentConfig?: any;
  livekitUrl?: string;
  livekit_url?: string;
  wsUrl?: string;
}

interface NormalisedStartSession {
  agentId: string;
  roomName: string;
  agentConfig: any;
  livekitUrl: string | null;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Normalise the incoming body and deduplicate LiveKit URL field names.
 */
function normaliseStartSessionBody(body: StartSessionRequestBody): NormalisedStartSession {
  const {
    agentId,
    roomName,
    agentConfig,
    livekitUrl,
    livekit_url,
    wsUrl,
  } = body;

  // Accept any of these as the LiveKit URL
  const resolvedLivekitUrl =
    livekitUrl ||
    livekit_url ||
    wsUrl ||
    process.env.LIVEKIT_URL || // optional fallback
    null;

  return {
    agentId: agentId || "",
    roomName: roomName || "",
    agentConfig: agentConfig ?? {},
    livekitUrl: resolvedLivekitUrl,
  };
}

/**
 * This is where you will eventually put your LiveKit + LLM + tools logic.
 * It runs in the background and does NOT block the HTTP response.
 */
async function startAgentSessionInBackground(session: NormalisedStartSession) {
  const { agentId, roomName, agentConfig, livekitUrl } = session;

  console.log("[worker] startAgentSessionInBackground called with:", {
    agentId,
    roomName,
    hasAgentConfig: !!agentConfig,
    livekitUrl,
  });

  // ───────────────────────────────────────────────────────────
  // TODO: IMPLEMENT YOUR ACTUAL AGENT LOGIC HERE
  //
  // Typical steps:
  // 1. Use LiveKit server SDK or Agents SDK to connect as an AI participant:
  //    - authenticate with LIVEKIT_API_KEY / LIVEKIT_API_SECRET
  //    - join room `roomName` using `livekitUrl`
  //
  // 2. Set up:
  //    - STT → convert user audio to text
  //    - LLM → run your prompt + tools
  //    - TTS → send audio back into LiveKit
  //
  // 3. For tools (booking, leads, etc.), call your Supabase edge function:
  //    POST https://<YOUR-SUPABASE-URL>/functions/v1/agent-tools
  //    with { tool, args, agent_id, session_id } and use the response.
  //
  // 4. Handle errors robustly so a failure in one call doesn't crash the worker.
  // ───────────────────────────────────────────────────────────

  try {
    // Example: just log and simulate small delay for now
    console.log("[worker] (stub) connecting AI agent to LiveKit room...");
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("[worker] (stub) AI agent session initialised.");
  } catch (err) {
    console.error("[worker] Error in startAgentSessionInBackground:", err);
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

/**
 * Simple health check for Railway / your own debugging.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    status: "healthy",
    env: {
      hasWorkerSecret: !!process.env.AGENT_WORKER_SECRET,
      hasLivekitUrl: !!process.env.LIVEKIT_URL,
    },
  });
});

/**
 * Main endpoint called by Supabase `livekit-agent-worker` edge function.
 * It validates auth, normalises fields, logs everything, and then starts
 * the agent logic in the background.
 */
app.post("/start-session", async (req: Request, res: Response) => {
  const rawBody: StartSessionRequestBody = (req.body ?? {}) as StartSessionRequestBody;

  // 1) Auth check using x-worker-secret
  const headerSecret = req.header("x-worker-secret");
  const expectedSecret = process.env.AGENT_WORKER_SECRET;

  if (expectedSecret && headerSecret !== expectedSecret) {
    console.warn("[worker] Invalid or missing x-worker-secret header");
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Invalid worker secret",
    });
  }

  // 2) Log raw body for debugging
  console.log("[worker] /start-session raw body:", JSON.stringify(rawBody));

  // 3) Normalise fields
  const session = normaliseStartSessionBody(rawBody);
  const missing: string[] = [];

  if (!session.agentId) missing.push("agentId");
  if (!session.roomName) missing.push("roomName");
  if (!session.agentConfig) missing.push("agentConfig");
  if (!session.livekitUrl) missing.push("livekitUrl (or LIVEKIT_URL env)");

  if (missing.length > 0) {
    // ⚠️ While debugging, we do NOT block. We just warn.
    console.warn("[worker] Missing fields:", missing);
    console.warn("[worker] Received body:", rawBody);

    // If you want strict validation later, you can uncomment this:
    /*
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      missing,
      received: rawBody,
    });
    */
  }

  // 4) Start the agent logic in background (non-blocking)
  //    We do NOT await, so the HTTP response can return quickly.
  startAgentSessionInBackground(session).catch((err) => {
    console.error("[worker] Background session error:", err);
  });

  // 5) Respond immediately so Supabase / frontend doesn’t wait
  return res.json({
    ok: true,
    message: "Agent worker started (background).",
  });
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[worker] Server listening on port ${PORT}`);
  console.log(`[worker] Health: GET http://localhost:${PORT}/health`);
});