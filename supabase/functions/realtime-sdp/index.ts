// Supabase Edge Function: realtime-sdp
// Proxies a WebRTC SDP offer to OpenAI Realtime and returns the SDP answer.
// Runtime: Deno

// Ensure OPENAI_API_KEY is set in Supabase functions secrets:
// supabase functions secrets set OPENAI_API_KEY=... --project-ref <ref>

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// IDE shim: declare Deno for TypeScript when editing in a Node/Vite workspace
// This has no effect in the deployed Edge runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Deno: any;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return json({ error: "Expected application/json" }, 400);
    }

    const body = await req.json();
    const model = body?.model as string | undefined;
    const offerSdp = body?.sdp as string | undefined;

    if (!model || !offerSdp) {
      return json({ error: "Missing required fields: model, sdp" }, 400);
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      return json({ error: "OPENAI_API_KEY not configured" }, 500);
    }

    const oaiRes = await fetch(
      `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
      }
    );

    const text = await oaiRes.text();
    if (!oaiRes.ok) {
      return json(
        { error: "OpenAI Realtime error", status: oaiRes.status, detail: text },
        502
      );
    }

    // Success: return the SDP answer in JSON
    return json({ sdp: text }, 200);
  } catch (err) {
    return json({ error: "Unhandled", detail: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as Record<string, string>;
}
