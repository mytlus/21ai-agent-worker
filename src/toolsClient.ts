// src/toolsClient.ts
import axios from "axios";

export interface AgentToolCallArgs {
  tool: string;
  agentId?: string;
  sessionId?: string;
  args?: Record<string, any>;
}

export interface AgentToolResult {
  ok: boolean;
  tool?: string;
  result?: any;
  error?: string;
  [key: string]: any;
}

const AGENT_TOOLS_URL = process.env.AGENT_TOOLS_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!AGENT_TOOLS_URL) {
  console.warn("[toolsClient] AGENT_TOOLS_URL is not set; tools will fail if called.");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[toolsClient] SUPABASE_SERVICE_ROLE_KEY is not set; tools will fail if called.");
}

export async function callAgentTool(
  payload: AgentToolCallArgs
): Promise<AgentToolResult> {
  if (!AGENT_TOOLS_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[toolsClient] Missing config, cannot call agent-tools");
    return { ok: false, error: "missing_agent_tools_config" };
  }

  try {
    const res = await axios.post(
      AGENT_TOOLS_URL,
      {
        tool: payload.tool,
        agent_id: payload.agentId,
        session_id: payload.sessionId,
        args: payload.args ?? {}
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        timeout: 15000
      }
    );

    return res.data as AgentToolResult;
  } catch (err: any) {
    console.error("[toolsClient] Error calling agent-tools:", err?.message || err);
    return {
      ok: false,
      error: "agent_tools_request_failed",
      details: err?.message || String(err)
    };
  }
}