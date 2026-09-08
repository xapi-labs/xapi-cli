interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
}

interface D1Database {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1PreparedStatement;
}

interface R2Bucket {
  put(key: string, value: string): Promise<unknown>;
}

interface QueueBinding {
  send(message: unknown): Promise<void>;
}

interface WorkflowBinding {
  create(options: { id?: string; params: unknown }): Promise<{ id: string }>;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface Env {
  AGENT_STATE: DurableObjectNamespace;
  AGENT_WORKFLOW: WorkflowBinding;
  APP_TOKEN?: string;
  CACHE: KvNamespace;
  DB: D1Database;
  FILES: R2Bucket;
  MODEL_KEY?: string;
  TASK_QUEUE: QueueBinding;
  XAPI_AI_BASE_URL?: string;
}

interface SessionState {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function home(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>My Agent · xAPI Workers</title>
  <style>
    :root { color-scheme: dark; --bg:#080b10; --panel:#111721; --line:#263244; --muted:#91a0b7; --text:#f5f8fc; --cyan:#65e6ff; --green:#62e6a7; --violet:#a58cff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--text); background:radial-gradient(circle at 15% -10%,#153247 0,transparent 36rem),radial-gradient(circle at 95% 10%,#281b4b 0,transparent 32rem),var(--bg); }
    main { width:min(1120px,calc(100% - 32px)); margin:auto; padding:52px 0 72px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:44px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:750; letter-spacing:.01em; }
    .mark { display:grid; place-items:center; width:34px; height:34px; border:1px solid #4c6b84; border-radius:10px; background:#14202d; color:var(--cyan); }
    .live { display:flex; align-items:center; gap:8px; padding:7px 11px; border:1px solid #285a49; border-radius:999px; color:#afffd6; background:#0e2a21; font-size:12px; font-weight:700; letter-spacing:.08em; }
    .dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 14px var(--green); }
    .hero { max-width:760px; margin-bottom:38px; }
    .eyebrow { color:var(--cyan); font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:12px 0 14px; font-size:clamp(42px,7vw,76px); line-height:1.02; letter-spacing:-.055em; }
    .hero p { margin:0; color:var(--muted); font-size:18px; max-width:670px; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; }
    .panel { grid-column:span 12; border:1px solid var(--line); border-radius:18px; background:linear-gradient(145deg,rgba(20,28,40,.94),rgba(13,18,27,.94)); box-shadow:0 18px 50px rgba(0,0,0,.18); }
    .capabilities { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; overflow:hidden; }
    .cap { padding:22px; background:rgba(17,23,33,.88); }
    .cap b { display:block; margin-bottom:5px; font-size:14px; }
    .cap span { color:var(--muted); font-size:13px; }
    .workbench { padding:24px; }
    .panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:20px; }
    h2 { margin:0 0 3px; font-size:18px; }
    .sub { color:var(--muted); font-size:13px; }
    label { display:block; margin-bottom:7px; color:#c8d3e2; font-size:12px; font-weight:700; }
    .token-row { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:18px; }
    input,textarea { width:100%; border:1px solid #314057; border-radius:10px; outline:none; background:#090e15; color:var(--text); padding:11px 13px; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
    input:focus,textarea:focus { border-color:#4f93b4; box-shadow:0 0 0 3px rgba(101,230,255,.09); }
    button,a.button { appearance:none; border:1px solid #35455b; border-radius:10px; background:#17202d; color:#eaf2fc; padding:10px 14px; font:700 13px/1.2 inherit; cursor:pointer; text-decoration:none; transition:.15s ease; }
    button:hover,a.button:hover { transform:translateY(-1px); border-color:#5c789a; background:#1b2939; }
    button.primary { border-color:#267286; background:#123b48; color:#b9f5ff; }
    .actions { display:flex; flex-wrap:wrap; gap:9px; margin-bottom:18px; }
    .chat-shell { margin:18px 0; overflow:hidden; border:1px solid #2b3a4f; border-radius:14px; background:#090e15; }
    .chat-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px 15px; border-bottom:1px solid #202c3c; color:#cbd8e8; font-size:12px; font-weight:700; }
    .chat-session { display:flex; align-items:center; gap:9px; color:#718198; font-weight:500; }
    .chat-session button { padding:6px 9px; font-size:11px; }
    .messages { display:flex; flex-direction:column; gap:11px; min-height:210px; max-height:420px; overflow:auto; padding:17px; }
    .message { max-width:min(78%,680px); padding:10px 13px; border-radius:13px; white-space:pre-wrap; word-break:break-word; }
    .message.assistant { align-self:flex-start; border:1px solid #2b3b50; border-bottom-left-radius:4px; background:#151e2a; color:#dce8f7; }
    .message.user { align-self:flex-end; border:1px solid #267286; border-bottom-right-radius:4px; background:#123b48; color:#c7f6ff; }
    .message.error { align-self:flex-start; border:1px solid #743d4b; background:#321923; color:#ffc6d2; }
    .composer { display:grid; grid-template-columns:1fr auto; gap:10px; padding:13px; border-top:1px solid #202c3c; background:#0d131c; }
    .composer button:disabled { cursor:wait; opacity:.55; transform:none; }
    .console { min-height:170px; max-height:360px; overflow:auto; margin:0; padding:16px; border:1px solid #202c3c; border-radius:12px; background:#070b10; color:#b9c9dd; white-space:pre-wrap; word-break:break-word; font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .meta { display:flex; justify-content:space-between; gap:12px; margin-top:12px; color:#718198; font-size:12px; }
    footer { display:flex; justify-content:space-between; gap:20px; margin-top:24px; color:#718198; font-size:12px; }
    @media (max-width:720px) { main{padding-top:28px}.capabilities{grid-template-columns:1fr}.token-row,.composer{grid-template-columns:1fr}.message{max-width:92%}.meta,footer{flex-direction:column}.hero{margin-bottom:28px} }
  </style>
</head>
<body>
  <main>
    <header><div class="brand"><span class="mark">x</span><span>xAPI Workers</span></div><div class="live"><span class="dot"></span>PREVIEW ACTIVE</div></header>
    <section class="hero"><div class="eyebrow">Persistent Agent Runtime</div><h1>My Agent is running.</h1><p>A stateful agent service deployed on Cloudflare through xAPI, with managed storage, asynchronous jobs and observable execution.</p></section>
    <section class="panel capabilities" aria-label="Managed capabilities">
      <div class="cap"><b>Durable state</b><span>Durable Objects keep each agent session isolated.</span></div>
      <div class="cap"><b>Managed data</b><span>KV, D1 and R2 are provisioned and bound automatically.</span></div>
      <div class="cap"><b>Background work</b><span>Queues and Workflows handle durable asynchronous tasks.</span></div>
    </section>
    <section class="panel workbench" style="margin-top:16px">
      <div class="panel-head"><div><h2>API workbench</h2><div class="sub">Run same-origin checks against this Preview deployment.</div></div><a class="button" href="/health" target="_blank" rel="noreferrer">Open health</a></div>
      <label for="token">APP_TOKEN · application access token, not your XAPI_KEY</label>
      <div class="token-row"><input id="token" type="password" autocomplete="off" placeholder="Paste APP_TOKEN (held only in page memory)"><button id="clear">Clear</button></div>
      <div class="actions">
        <button data-call="health">Health</button>
        <button data-call="state">Read state</button>
        <button data-call="setup">Verify storage</button>
        <button data-call="queue">Send queue task</button>
        <button data-call="workflow">Start workflow</button>
      </div>
      <div class="chat-shell">
        <div class="chat-head"><span>Agent chat</span><div class="chat-session"><span id="session-label"></span><button id="new-chat" type="button">New chat</button></div></div>
        <div id="messages" class="messages"><div class="message assistant">Hello. Add APP_TOKEN above, then send a message to start a durable AI conversation.</div></div>
        <form id="chat-form" class="composer"><input id="chat-input" autocomplete="off" placeholder="Message the agent…"><button id="send" class="primary" type="submit">Send</button></form>
      </div>
      <pre id="console" class="console">Ready. Health is public; all other actions require APP_TOKEN.</pre>
      <div class="meta"><span id="request">No request yet</span><span>Request and response bodies are excluded from platform logs.</span></div>
    </section>
    <footer><span>Environment: preview · Template: persistent-agent</span><span>Powered by xAPI Workers for Platforms</span></footer>
  </main>
  <script>
    const output = document.getElementById('console');
    const requestMeta = document.getElementById('request');
    const token = document.getElementById('token');
    const sessionLabel = document.getElementById('session-label');
    const sessionStorageKey = 'xapi-my-agent-session-v1';
    const newSession = () => 'web-' + crypto.randomUUID();
    let session = localStorage.getItem(sessionStorageKey) || newSession();
    let sessionHydrated = false;
    localStorage.setItem(sessionStorageKey, session);
    const showSession = () => { sessionLabel.textContent = 'Durable session: ' + session.slice(0, 12) + '…'; };
    showSession();
    document.getElementById('clear').onclick = () => { token.value = ''; token.focus(); };
    const specs = {
      health: { path:'/health', method:'GET' },
      state: { path:'/state', method:'GET' },
      setup: { path:'/setup', method:'POST', body:{} },
      queue: { path:'/queue', method:'POST', body:{ kind:'playground', message:'Hello from the Worker UI' } },
      workflow: { path:'/workflow', method:'POST', body:{ kind:'playground', message:'Run a durable workflow' } }
    };
    function requireToken() {
      if (token.value.trim()) return true;
      output.textContent = 'APP_TOKEN required\\n\\nPaste the application token above. XAPI_KEY is only for deployment and must not be entered here.';
      requestMeta.textContent = 'Protected route was not called';
      token.focus();
      return false;
    }
    async function invoke(name) {
      if (name !== 'health' && !requireToken()) return;
      const spec = name === 'state'
        ? { ...specs.state, path:'/state?session=' + encodeURIComponent(session) }
        : specs[name];
      const headers = { accept:'application/json' };
      if (token.value) headers.authorization = 'Bearer ' + token.value;
      if (spec.body) headers['content-type'] = 'application/json';
      const started = performance.now();
      output.textContent = spec.method + ' ' + spec.path + '\\nWaiting for response…';
      try {
        const response = await fetch(spec.path, { method:spec.method, headers, body:spec.body ? JSON.stringify(spec.body) : undefined });
        const text = await response.text();
        let rendered = text;
        try { rendered = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        output.textContent = spec.method + ' ' + spec.path + '\\nHTTP ' + response.status + '\\n\\n' + rendered;
        requestMeta.textContent = Math.round(performance.now() - started) + ' ms · request ' + (response.headers.get('x-xapi-request-id') || 'unavailable');
      } catch (error) {
        output.textContent = 'Request failed\\n\\n' + String(error);
        requestMeta.textContent = 'Network error';
      }
    }
    document.querySelectorAll('[data-call]').forEach((button) => button.onclick = () => invoke(button.dataset.call));
    const messages = document.getElementById('messages');
    const chatInput = document.getElementById('chat-input');
    const send = document.getElementById('send');
    const intro = 'Hello. Add APP_TOKEN above, then send a message to start a durable AI conversation.';
    function addMessage(role, content) {
      const item = document.createElement('div');
      item.className = 'message ' + role;
      item.textContent = content;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
      return item;
    }
    function renderHistory(history) {
      messages.replaceChildren();
      if (!history.length) addMessage('assistant', intro);
      else history.forEach((item) => addMessage(item.role === 'user' ? 'user' : 'assistant', item.content || ''));
    }
    async function hydrateSession() {
      if (sessionHydrated || !token.value.trim()) return;
      const response = await fetch('/state?session=' + encodeURIComponent(session), {
        headers:{ authorization:'Bearer ' + token.value, accept:'application/json' }
      });
      if (!response.ok) return;
      const state = await response.json().catch(() => ({}));
      renderHistory(Array.isArray(state.messages) ? state.messages : []);
      sessionHydrated = true;
    }
    token.addEventListener('change', () => { hydrateSession().catch(() => {}); });
    document.getElementById('new-chat').onclick = () => {
      session = newSession();
      sessionHydrated = true;
      localStorage.setItem(sessionStorageKey, session);
      showSession();
      renderHistory([]);
      output.textContent = 'New durable conversation created.\\n\\nSession: ' + session;
      chatInput.focus();
    };
    document.getElementById('chat-form').onsubmit = async (event) => {
      event.preventDefault();
      const message = chatInput.value.trim();
      if (!message || !requireToken()) return;
      await hydrateSession().catch(() => {});
      addMessage('user', message);
      chatInput.value = '';
      chatInput.disabled = true;
      send.disabled = true;
      const pending = addMessage('assistant', 'Thinking…');
      const started = performance.now();
      try {
        const response = await fetch('/chat', {
          method:'POST',
          headers:{ authorization:'Bearer ' + token.value, 'content-type':'application/json', accept:'application/json' },
          body:JSON.stringify({ session, message })
        });
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let answer = '';
          let frames = 0;
          const consume = (eventText) => {
            const data = eventText.split(/\\r?\\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\\n');
            if (!data || data === '[DONE]') return;
            const chunk = JSON.parse(data);
            if (chunk.error) throw new Error(chunk.error.message || chunk.error);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              answer += delta;
              frames += 1;
              pending.textContent = answer;
              messages.scrollTop = messages.scrollHeight;
            }
          };
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream:true });
            const events = buffer.split(/\\r?\\n\\r?\\n/);
            buffer = events.pop() || '';
            events.forEach(consume);
          }
          buffer += decoder.decode();
          if (buffer.trim()) consume(buffer);
          if (!answer) pending.textContent = 'The model returned an empty response.';
          output.textContent = 'POST /chat\\nHTTP ' + response.status + '\\nStreaming complete · ' + frames + ' content frames';
        } else {
          const result = await response.json().catch(() => ({}));
          pending.remove();
          if (response.ok) addMessage('assistant', result.answer || 'The model returned an empty response.');
          else if (response.status === 401 && result.error === 'model_request_failed') addMessage('error', 'The agent model credential is invalid. Configure MODEL_KEY and try again.');
          else if (response.status === 402 && result.error === 'model_request_failed') addMessage('error', 'The model account has insufficient available balance. Top up the MODEL_KEY account and try again.');
          else addMessage('error', 'Request failed (HTTP ' + response.status + '): ' + (result.error || result.message || 'Unknown error'));
          output.textContent = 'POST /chat\\nHTTP ' + response.status + '\\n\\n' + JSON.stringify(result, null, 2);
        }
        requestMeta.textContent = Math.round(performance.now() - started) + ' ms · request ' + (response.headers.get('x-xapi-request-id') || 'unavailable');
      } catch (error) {
        pending.remove();
        addMessage('error', 'Network error: ' + String(error));
      } finally {
        chatInput.disabled = false;
        send.disabled = false;
        chatInput.focus();
      }
    };
  </script>
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function sameSecret(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index += 1) {
    different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return different === 0;
}

function authorized(request: Request, token?: string): boolean {
  if (!token) return false;
  return sameSecret(
    request.headers.get("authorization") || "",
    `Bearer ${token}`,
  );
}

async function hmac(token: string, payload: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  let binary = "";
  for (const byte of signed) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifiedEnvelope(
  token: string | undefined,
  envelope: { payload?: unknown; signature?: string } | undefined,
): Promise<boolean> {
  if (!token || !envelope?.signature || envelope.payload === undefined) {
    return false;
  }
  return sameSecret(envelope.signature, await hmac(token, envelope.payload));
}

async function body<T>(request: Request): Promise<T> {
  const input: unknown = await request.json().catch(() => ({}));
  return (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as T;
}

async function record(env: Env, kind: string, payload: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO agent_events (id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), kind, JSON.stringify(payload), new Date().toISOString())
    .run();
}

export class AgentState {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return json(
        (await this.state.storage.get<SessionState>("session")) || {
          messages: [],
          updatedAt: new Date(0).toISOString(),
        },
      );
    }
    if (request.method === "PUT") {
      const next = await body<SessionState>(request);
      await this.state.storage.put("session", next);
      return json(next);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
}

function sessionStub(env: Env, session: string): DurableObjectStub {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(session));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return home();
    }
    if (url.pathname === "/health") {
      return json({ ok: true, project: "{{PROJECT_SLUG}}", template: "persistent-agent" });
    }
    const trigger = request.headers.get("x-xapi-trigger");
    const internalRoute =
      url.pathname === "/queue-consume" || url.pathname === "/workflow-step";
    const internalPayload = internalRoute
      ? await body<{ payload?: unknown; signature?: string }>(request.clone())
      : undefined;
    const internalAuthorized = await verifiedEnvelope(
      env.APP_TOKEN,
      internalPayload,
    );
    const cronAuthorized = url.pathname === "/cron" && trigger === "cron";
    if (
      !authorized(request, env.APP_TOKEN) &&
      !internalAuthorized &&
      !cronAuthorized
    ) {
      return json({ error: env.APP_TOKEN ? "unauthorized" : "APP_TOKEN_not_configured" }, env.APP_TOKEN ? 401 : 503);
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      await env.DB.exec(
        "CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
      );
      await Promise.all([
        env.CACHE.put("setup", new Date().toISOString()),
        env.FILES.put("setup.json", JSON.stringify({ project: "{{PROJECT_SLUG}}", ok: true })),
      ]);
      await record(env, "setup", { project: "{{PROJECT_SLUG}}" });
      return json({ ok: true, resources: ["KV", "D1", "R2"] });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const session = url.searchParams.get("session") || "default";
      return sessionStub(env, session).fetch(new Request("https://agent-state.local/"));
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      if (!env.MODEL_KEY) return json({ error: "MODEL_KEY_not_configured" }, 503);
      const input = await body<{ message?: string; session?: string }>(request);
      if (!input.message) return json({ error: "message_required" }, 400);
      const session = input.session || "default";
      const stub = sessionStub(env, session);
      const previous = (await (await stub.fetch(new Request("https://agent-state.local/"))).json()) as SessionState;
      const messages = [...previous.messages, { role: "user" as const, content: input.message }].slice(-20);
      const aiBaseUrl =
        env.XAPI_AI_BASE_URL && env.XAPI_AI_BASE_URL !== "https://ai.xapi.to/v1"
          ? env.XAPI_AI_BASE_URL
          : "https://ai.xapi.to/cost/v1";
      const upstream = await fetch(aiBaseUrl + "/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.MODEL_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages, stream: true }),
      });
      if (!upstream.ok) {
        const result = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
        return json({ error: "model_request_failed", upstream: result }, upstream.status);
      }
      const contentType = upstream.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") || !upstream.body) {
        const result = (await upstream.json().catch(() => ({}))) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const answer = result.choices?.[0]?.message?.content || "";
        const next: SessionState = {
          messages: [...messages, { role: "assistant" as const, content: answer }].slice(-20),
          updatedAt: new Date().toISOString(),
        };
        await stub.fetch(new Request("https://agent-state.local/", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }));
        await record(env, "chat", { session, messageCount: next.messages.length, streamed: false });
        return json({ session, answer });
      }
      const reader = upstream.body.getReader();
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      const consume = (eventText: string): void => {
        const data = eventText
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") return;
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string") answer += delta;
      };
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || "";
            events.forEach(consume);
            await writer.write(value);
          }
          buffer += decoder.decode();
          if (buffer.trim()) consume(buffer);
          const next: SessionState = {
            messages: [...messages, { role: "assistant" as const, content: answer }].slice(-20),
            updatedAt: new Date().toISOString(),
          };
          await stub.fetch(new Request("https://agent-state.local/", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(next),
          }));
          await record(env, "chat", { session, messageCount: next.messages.length, streamed: true });
          await writer.close();
        } catch (error) {
          await writer.abort(error);
        }
      })();
      return new Response(stream.readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    }

    if (url.pathname === "/queue" && request.method === "POST") {
      const task = await body<Record<string, unknown>>(request);
      const taskId = crypto.randomUUID();
      const payload = { taskId, task };
      await env.TASK_QUEUE.send({
        path: "/queue-consume",
        body: { payload, signature: await hmac(env.APP_TOKEN!, payload) },
      });
      return json({ accepted: true, taskId }, 202);
    }

    if (url.pathname === "/queue-consume" && request.method === "POST") {
      const envelope = await body<{
        payload?: { taskId?: string; task?: unknown };
      }>(request);
      await record(env, "queue", envelope.payload || {});
      return json({ processed: true });
    }

    if (url.pathname === "/workflow" && request.method === "POST") {
      const task = await body<Record<string, unknown>>(request);
      const payload = { task };
      const run = await env.AGENT_WORKFLOW.create({
        id: crypto.randomUUID(),
        params: {
          path: "/workflow-step",
          body: { payload, signature: await hmac(env.APP_TOKEN!, payload) },
        },
      });
      return json({ accepted: true, workflowRunId: run.id }, 202);
    }

    if (url.pathname === "/workflow-step" && request.method === "POST") {
      const envelope = await body<{ payload?: { task?: unknown } }>(request);
      await record(env, "workflow", envelope.payload || {});
      return json({ completed: true });
    }

    if (url.pathname === "/cron" && request.method === "POST") {
      if (!env.APP_TOKEN) return json({ error: "APP_TOKEN_not_configured" }, 503);
      const taskId = crypto.randomUUID();
      const payload = {
        taskId,
        task: { kind: "cron", at: new Date().toISOString() },
      };
      await env.TASK_QUEUE.send({
        path: "/queue-consume",
        body: {
          payload,
          signature: await hmac(env.APP_TOKEN, payload),
        },
      });
      return json({ accepted: true, taskId }, 202);
    }

    return json({ error: "not_found" }, 404);
  },
};
