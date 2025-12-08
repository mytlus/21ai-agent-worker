// supabase/functions/livekit-agent-worker/index.ts

// Edge function that calls the Railway LiveKit worker
// - GET /health on the worker (with timeout + diagnostics)
// - POST /start-session with the original payload (with timeout + diagnostics)

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const WORKER_BASE_URL =
  Deno.env.get('LIVEKIT_AGENT_WORKER_URL') ??
  'https://glistening-truth-production-61ed.up.railway.app';

const HEALTH_TIMEOUT_MS = 8000;
const START_SESSION_TIMEOUT_MS = 20000;

interface EdgeResponseBody {
  ok: boolean;
  phaseTimings?: {
    healthCheck?: number;
    startSession?: number;
    total: number;
  };
  health?: unknown;
  worker?: unknown;
  errorClass?: string;
  errorMessage?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const t0 = Date.now();
  console.log('[livekit-agent-worker] Incoming request:', {
    url: req.url,
    method: req.method,
  });

  try {
    const body = await req.json().catch(() => ({}));
    console.log('[livekit-agent-worker] Payload from frontend:', body);

    const phaseTimings: EdgeResponseBody['phaseTimings'] = {
      total: 0,
    };

    // ---------- Phase 1: Worker health check ----------

    const healthStart = Date.now();
    let healthResult: unknown = null;
    let healthErrorClass: string | undefined;

    try {
      const healthController = new AbortController();
      const healthTimeout = setTimeout(
        () => healthController.abort(),
        HEALTH_TIMEOUT_MS,
      );

      const healthUrl = `${WORKER_BASE_URL.replace(/\/$/, '')}/health`;
      console.log('[livekit-agent-worker] ▶ Calling worker /health:', {
        healthUrl,
        timeoutMs: HEALTH_TIMEOUT_MS,
      });

      const healthRes = await fetch(healthUrl, {
        method: 'GET',
        signal: healthController.signal,
      }).catch((err) => {
        throw err;
      });

      clearTimeout(healthTimeout);

      const healthText = await healthRes.text();
      const healthHeaders: Record<string, string> = {};
      healthRes.headers.forEach((v, k) => {
        if (['x-railway-request-id', 'x-request-id', 'content-type'].includes(k.toLowerCase())) {
          healthHeaders[k] = v;
        }
      });

      console.log('[livekit-agent-worker] ◀ /health response:', {
        status: healthRes.status,
        headers: healthHeaders,
        bodySnippet: healthText.slice(0, 300),
      });

      try {
        healthResult = JSON.parse(healthText);
      } catch {
        healthResult = { raw: healthText };
      }

      if (!healthRes.ok) {
        healthErrorClass = `WORKER_HEALTH_HTTP_${healthRes.status}`;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.error(
          '[livekit-agent-worker] ❌ /health timed out (AbortError)',
          { timeoutMs: HEALTH_TIMEOUT_MS },
        );
        healthErrorClass = 'WORKER_HEALTH_TIMEOUT';
      } else {
        console.error('[livekit-agent-worker] ❌ /health network/error:', err);
        healthErrorClass = 'WORKER_HEALTH_NETWORK_ERROR';
      }
    }

    phaseTimings.healthCheck = Date.now() - healthStart;

    // ---------- Phase 2: /start-session on worker ----------

    const startSessionStart = Date.now();
    let workerResponse: unknown = null;
    let startErrorClass: string | undefined;
    let startHttpStatus = 0;

    try {
      const startController = new AbortController();
      const startTimeout = setTimeout(
        () => startController.abort(),
        START_SESSION_TIMEOUT_MS,
      );

      const startUrl = `${WORKER_BASE_URL.replace(/\/$/, '')}/start-session`;
      console.log('[livekit-agent-worker] ▶ Calling worker /start-session:', {
        startUrl,
        timeoutMs: START_SESSION_TIMEOUT_MS,
      });

      const startRes = await fetch(startUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: startController.signal,
      });

      clearTimeout(startTimeout);
      startHttpStatus = startRes.status;

      const headers: Record<string, string> = {};
      startRes.headers.forEach((v, k) => {
        if (['x-railway-request-id', 'x-request-id', 'content-type'].includes(k.toLowerCase())) {
          headers[k] = v;
        }
      });

      const text = await startRes.text();

      console.log('[livekit-agent-worker] ◀ /start-session response:', {
        status: startRes.status,
        headers,
        bodySnippet: text.slice(0, 300),
      });

      try {
        workerResponse = JSON.parse(text);
      } catch {
        workerResponse = { raw: text };
      }

      if (!startRes.ok) {
        startErrorClass = `WORKER_START_HTTP_${startRes.status}`;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.error(
          '[livekit-agent-worker] ❌ /start-session timed out (AbortError)',
          { timeoutMs: START_SESSION_TIMEOUT_MS },
        );
        startErrorClass = 'WORKER_START_TIMEOUT';
      } else {
        console.error('[livekit-agent-worker] ❌ /start-session network/error:', err);
        startErrorClass = 'WORKER_START_NETWORK_ERROR';
      }
    }

    phaseTimings.startSession = Date.now() - startSessionStart;
    phaseTimings.total = Date.now() - t0;

    // ---------- Error classification & response ----------

    const errorClass = startErrorClass || healthErrorClass;

    console.log('[livekit-agent-worker] Phase timings:', phaseTimings);
    console.log('[livekit-agent-worker] Error classification:', errorClass ?? 'NONE');

    const responseBody: EdgeResponseBody = {
      ok: !errorClass,
      phaseTimings,
      health: healthResult,
      worker: workerResponse,
      errorClass: errorClass,
      errorMessage:
        errorClass === 'WORKER_START_TIMEOUT'
          ? 'Worker /start-session timed out'
          : errorClass === 'WORKER_HEALTH_TIMEOUT'
          ? 'Worker /health timed out'
          : errorClass ?? undefined,
    };

    // Decide HTTP status for the edge response
    const status =
      errorClass && startHttpStatus >= 500
        ? 502
        : errorClass && startHttpStatus >= 400
        ? startHttpStatus
        : 200;

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('[livekit-agent-worker] ❌ Unhandled error:', err);

    const body: EdgeResponseBody = {
      ok: false,
      phaseTimings: { total: Date.now() - t0 },
      errorClass: 'EDGE_UNHANDLED_ERROR',
      errorMessage: err instanceof Error ? err.message : String(err),
    };

    return new Response(JSON.stringify(body), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }
});
