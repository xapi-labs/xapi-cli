import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkerProject } from '../workers-init.ts';
import { loadWorkerProject } from '../workers-project.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const workspace = () => { const root = mkdtempSync(join(tmpdir(), 'xapi-agent-auth-')); roots.push(root); return root; };

describe('new Agent and Chat application authentication', () => {
  for (const template of ['agent', 'chat']) {
    test(`${template}: unauthorized traffic never reaches the model; valid requests preserve JSON/SSE`, async () => {
      const project = initWorkerProject({ cwd: workspace(), target: template, template });
      const build = await Bun.build({ entrypoints: [join(project.rootDir, 'src/index.ts')], outdir: join(project.rootDir, 'dist'), target: 'browser', format: 'esm' });
      expect(build.success).toBe(true);
      const worker = (await import(build.outputs[0].path)).default;
      const config = loadWorkerProject(project.rootDir).config;
      expect(config.environments.preview.dailyBudgetUsd).toBe(0.25);
      expect(config.environments.preview.secrets).toEqual(['APP_TOKEN', 'MODEL_KEY']);
      const original = globalThis.fetch;
      const requests: any[] = [];
      const responseBody = template === 'chat' ? 'data: {"choices":[]}\n\ndata: [DONE]\n\n' : '{"choices":[]}';
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        requests.push({ url, headers: opts.headers, body: JSON.parse(String(opts.body)) });
        return new Response(responseBody, { headers: { 'content-type': template === 'chat' ? 'text/event-stream' : 'application/json' } });
      }) as any;
      const env = { APP_TOKEN: 'application-only', MODEL_KEY: 'model-only' };
      const request = (authorization?: string) => new Request('https://fixture.test/chat', { method: 'POST', headers: authorization ? { authorization } : {}, body: JSON.stringify({ message: 'hello' }) });
      try {
        expect((await worker.fetch(new Request('https://fixture.test/health'), {})).status).toBe(200);
        expect((await worker.fetch(request(), {})).status).toBe(503);
        for (const header of [undefined, 'Bearer wrong', 'Basic application-only', 'Bearer model-only']) {
          expect((await worker.fetch(request(header), env)).status).toBe(401);
        }
        expect(requests).toHaveLength(0);
        expect((await worker.fetch(request('Bearer application-only'), { APP_TOKEN: env.APP_TOKEN })).status).toBe(503);
        expect(requests).toHaveLength(0);
        const response = await worker.fetch(request('Bearer application-only'), env);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(responseBody);
        expect(requests).toHaveLength(1);
        expect(requests[0].headers.authorization).toBe('Bearer model-only');
        expect(JSON.stringify(requests[0])).not.toContain('application-only');
        if (template === 'chat') expect(requests[0].body.stream).toBe(true);
      } finally { globalThis.fetch = original; }
    });
    test(`${template}: explicit budget values, including none, are preserved`, () => {
      for (const budget of [null, 0, 1]) {
        const project = initWorkerProject({ cwd: workspace(), target: template, template, previewDailyBudgetUsd: budget });
        expect(loadWorkerProject(project.rootDir).config.environments.preview.dailyBudgetUsd).toBe(budget);
      }
    });
  }
  test('ordinary Worker budgets remain unchanged', () => {
    const project = initWorkerProject({ cwd: workspace(), target: 'ordinary', template: 'worker' });
    expect(loadWorkerProject(project.rootDir).config.environments.preview.dailyBudgetUsd).toBeNull();
  });
});
