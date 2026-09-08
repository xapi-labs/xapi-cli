interface Env {
  XAPI_AI_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, runtime: "xAPI Workers", project: "{{PROJECT_SLUG}}" });
    }
    return Response.json({
      message: "Hello from {{PROJECT_NAME}}",
      aiBaseUrl: env.XAPI_AI_BASE_URL,
    });
  },
};
