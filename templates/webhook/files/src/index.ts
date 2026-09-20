interface Env {}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const event = await request.json().catch(() => null);
    return Response.json(
      { accepted: true, eventId: crypto.randomUUID(), event },
      { status: 202 },
    );
  },
};
