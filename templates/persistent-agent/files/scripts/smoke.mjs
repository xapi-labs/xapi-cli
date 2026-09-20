const workerUrl = process.env.WORKER_URL;
const appToken = process.env.APP_TOKEN;

if (!workerUrl || !appToken) {
  throw new Error("WORKER_URL and APP_TOKEN are required");
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, workerUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const health = await request("/health");
const setup = await request("/setup", { method: "POST" });
const queued = await request("/queue", {
  method: "POST",
  body: JSON.stringify({ task: "smoke-test" }),
});
const workflow = await request("/workflow", {
  method: "POST",
  body: JSON.stringify({ task: "smoke-test" }),
});

console.log(JSON.stringify({ ok: true, health, setup, queued, workflow }, null, 2));
