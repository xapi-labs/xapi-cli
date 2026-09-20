interface Env {
  XAPI_AI_BASE_URL?: string;
  MODEL_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, product: "Agent" });
    }
    if (url.pathname !== "/chat" || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (!env.MODEL_KEY) {
      return Response.json({ error: "MODEL_KEY_not_configured" }, { status: 503 });
    }
    const input = (await request.json().catch(() => ({}))) as { message?: string };
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) {
      return Response.json({ error: "message_required" }, { status: 400 });
    }
    const aiBaseUrl = env.XAPI_AI_BASE_URL || "https://ai.xapi.to/v1";
    const upstream = await fetch(aiBaseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + env.MODEL_KEY,
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: input.message }],
      }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
    });
  },
};
