import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";
import { initWorkerProject } from "../workers-init.ts";
import { loadWorkerProject } from "../workers-project.ts";
import { listWorkerTemplates, loadWorkerTemplate } from "../workers-templates.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-worker-init-")));
  roots.push(root);
  return root;
}

describe("workers init", () => {
  for (const template of ["chat", "agent"] as const) {
    test(`${template} rejects JSON null and non-string messages without invoking AI`, async () => {
      const result = initWorkerProject({ cwd: workspace(), target: `invalid-${template}`, template });
      const build = await Bun.build({ entrypoints: [join(result.rootDir, "src/index.ts")], outdir: join(result.rootDir, "dist"), format: "esm", target: "browser" });
      const module = await import(build.outputs[0].path);
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = Object.assign(async () => { calls++; throw new Error("Unexpected AI request"); }, { preconnect: originalFetch.preconnect });
      try {
        for (const input of [null, [], { message: 42 }, { message: " " }]) {
          const response = await module.default.fetch(new Request("https://example.test/chat", { method: "POST", body: JSON.stringify(input) }), { MODEL_KEY: "test" });
          expect(response.status).toBe(400);
        }
        expect(calls).toBe(0);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
  for (const template of listWorkerTemplates().map((item) => item.id)) {
    test(`creates a buildable ${template} project without Git or network access`, async () => {
      const cwd = workspace();
      const result = initWorkerProject({
        cwd,
        target: `demo-${template}`,
        template,
        compatibilityDate: "2026-08-26",
      });
      expect(existsSync(join(result.rootDir, ".git"))).toBe(false);
      const project = loadWorkerProject(result.rootDir);
      expect(project.config.worker.slug).toBe(`demo-${template}`);
      expect(project.config.worker.template).toBe(
        loadWorkerTemplate(template).productTemplate,
      );
      const sourcePath = join(result.rootDir, "src/index.ts");
      const source = readFileSync(sourcePath, "utf8");
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
        reportDiagnostics: true,
      });
      expect(transpiled.diagnostics || []).toHaveLength(0);
      expect(transpiled.outputText).toContain("export default");
      const program = ts.createProgram([sourcePath], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      });
      expect(ts.getPreEmitDiagnostics(program)).toHaveLength(0);
      const build = await Bun.build({
        entrypoints: [sourcePath],
        outdir: join(result.rootDir, "dist"),
        format: "esm",
        target: "browser",
      });
      expect(build.success).toBe(true);
      expect(build.outputs).toHaveLength(1);
      expect(readFileSync(build.outputs[0].path, "utf8")).toContain(
        "as default",
      );
    });
  }

  test("persistent-agent declares managed resources, secrets, and support files", () => {
    const cwd = workspace();
    const result = initWorkerProject({
      cwd,
      target: "persistent-demo",
      template: "persistent-agent",
      compatibilityDate: "2026-08-26",
    });
    const project = loadWorkerProject(result.rootDir);
    expect(project.config.environments.preview.resources.map((item) => item.type)).toEqual([
      "kv_namespace",
      "d1_database",
      "r2_bucket",
      "durable_object",
      "queue",
      "workflow",
    ]);
    expect(project.config.environments.preview.secrets).toEqual([
      "APP_TOKEN",
      "MODEL_KEY",
    ]);
    expect(existsSync(join(result.rootDir, "migrations/0001_init.sql"))).toBe(true);
    expect(existsSync(join(result.rootDir, "scripts/smoke.mjs"))).toBe(true);
    const packageJson = JSON.parse(readFileSync(join(result.rootDir, "package.json"), "utf8"));
    expect(packageJson.scripts["test:remote"]).toBe("node scripts/smoke.mjs");
  });

  test("chat requests a streaming OpenAI-compatible completion", () => {
    const cwd = workspace();
    const result = initWorkerProject({
      cwd,
      target: "streaming-chat",
      template: "chat",
      compatibilityDate: "2026-08-26",
    });
    const source = readFileSync(join(result.rootDir, "src/index.ts"), "utf8");
    expect(source).toContain('stream: true');
    expect(source).toContain('new Response(upstream.body');
  });

  test("persistent-agent public home renders and ships parseable workbench JavaScript", async () => {
    const cwd = workspace();
    const result = initWorkerProject({
      cwd,
      target: "persistent-ui",
      template: "persistent-agent",
      compatibilityDate: "2026-08-26",
    });
    const build = await Bun.build({
      entrypoints: [join(result.rootDir, "src/index.ts")],
      outdir: join(result.rootDir, "dist"),
      format: "esm",
      target: "browser",
    });
    expect(build.success).toBe(true);
    const worker = await import(`${build.outputs[0].path}?test=${Date.now()}`);
    const response = await worker.default.fetch(
      new Request("https://persistent-ui-preview.example.test/"),
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("My Agent is running.");
    expect(html).toContain("application access token, not your XAPI_KEY");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  test("rejects an unknown template before creating the target", () => {
    const cwd = workspace();
    expect(() =>
      initWorkerProject({ cwd, target: "unknown-demo", template: "missing-template" }),
    ).toThrow("Unknown Worker template 'missing-template'");
    expect(existsSync(join(cwd, "unknown-demo"))).toBe(false);
  });

  test("refuses a non-empty target by default", () => {
    const cwd = workspace();
    const target = join(cwd, "existing");
    initWorkerProject({
      cwd,
      target: "existing",
      compatibilityDate: "2026-08-26",
    });
    expect(() =>
      initWorkerProject({
        cwd,
        target: "existing",
        compatibilityDate: "2026-08-26",
      }),
    ).toThrow("Refusing to replace existing project file");
    expect(existsSync(join(target, "xapi.worker.json"))).toBe(true);
  });

  test("adopts an existing React Vite project without replacing its application files", () => {
    const cwd = workspace();
    const target = join(cwd, "existing-vite");
    mkdirSync(target);
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        name: "existing-vite",
        private: true,
        scripts: { dev: "vite", build: "vite build", test: "vitest" },
        dependencies: { react: "latest" },
        devDependencies: { vite: "latest", "@vitejs/plugin-react": "latest" },
      }),
    );
    writeFileSync(join(target, "app-marker.txt"), "preserved");
    const result = initWorkerProject({
      cwd,
      target: "existing-vite",
      compatibilityDate: "2026-09-17",
    });
    expect(result.mode).toBe("existing");
    expect(result.framework).toBe("react-vite");
    expect(readFileSync(join(target, "app-marker.txt"), "utf8")).toBe("preserved");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(pkg.scripts.dev).toBe("vite");
    expect(pkg.scripts.build).toBe("vite build");
    expect(pkg.scripts.test).toBe("vitest");
    expect(pkg.scripts["xapi:build"]).toBe(
      "npm run build && npm run xapi:worker:build",
    );
    expect(pkg.scripts["xapi:worker:dev"]).toContain("wrangler dev");
    const project = loadWorkerProject(target);
    expect(project.config.assets?.directory).toBe("dist");
    expect(project.config.assets?.runWorkerFirst).toEqual(["/api/*", "/health"]);
    expect(project.config.build.output).toBe(".xapi/worker/index.mjs");
    expect(existsSync(join(target, "xapi-worker/index.ts"))).toBe(true);
  });

  test("writes APAC data defaults and Smart Placement into both environments", () => {
    const cwd = workspace();
    initWorkerProject({
      cwd,
      target: "apac-worker",
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
    const project = loadWorkerProject(join(cwd, "apac-worker"));
    expect(project.config.environments.preview).toMatchObject({
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
    expect(project.config.environments.production).toMatchObject({
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
  });

  test("adopts a statically exported Next project and rejects SSR without mutation", () => {
    const cwd = workspace();
    const staticTarget = join(cwd, "next-static");
    mkdirSync(staticTarget);
    writeFileSync(
      join(staticTarget, "package.json"),
      JSON.stringify({
        name: "next-static",
        scripts: { build: "next build" },
        dependencies: { next: "latest", react: "latest" },
      }),
    );
    writeFileSync(
      join(staticTarget, "next.config.mjs"),
      "export default { output: 'export' };\n",
    );
    const adopted = initWorkerProject({ cwd, target: "next-static" });
    expect(adopted.framework).toBe("next-static");
    expect(loadWorkerProject(staticTarget).config.assets).toMatchObject({
      directory: "out",
      notFoundHandling: "404-page",
    });

    const ssrTarget = join(cwd, "next-ssr");
    mkdirSync(ssrTarget);
    const original = JSON.stringify({
      name: "next-ssr",
      scripts: { build: "next build" },
      dependencies: { next: "latest", react: "latest" },
    });
    writeFileSync(join(ssrTarget, "package.json"), original);
    expect(() => initWorkerProject({ cwd, target: "next-ssr" })).toThrow(
      "Next.js SSR requires a Workers adapter",
    );
    expect(readFileSync(join(ssrTarget, "package.json"), "utf8")).toBe(original);
    expect(existsSync(join(ssrTarget, "xapi.worker.json"))).toBe(false);
  });

  test("force overwrites managed files but preserves unknown files", () => {
    const cwd = workspace();
    const first = initWorkerProject({
      cwd,
      target: "existing",
      compatibilityDate: "2026-08-26",
    });
    const note = join(first.rootDir, "notes.txt");
    writeFileSync(note, "keep me");
    writeFileSync(join(first.rootDir, "src/index.ts"), "old source");
    initWorkerProject({
      cwd,
      target: "existing",
      template: "agent",
      force: true,
      compatibilityDate: "2026-08-26",
    });
    expect(readFileSync(note, "utf8")).toBe("keep me");
    expect(readFileSync(join(first.rootDir, "src/index.ts"), "utf8")).not.toBe(
      "old source",
    );
  });

  test("rejects traversal, absolute targets, and symbolic-link escapes", () => {
    const cwd = workspace();
    expect(() => initWorkerProject({ cwd, target: "../outside" })).toThrow(
      "'..'",
    );
    expect(() =>
      initWorkerProject({ cwd, target: join(cwd, "absolute") }),
    ).toThrow("relative path");
    const outside = workspace();
    symlinkSync(outside, join(cwd, "linked"));
    expect(() => initWorkerProject({ cwd, target: "linked/project" })).toThrow(
      "symbolic link",
    );
  });

  test("refuses to overwrite a managed symbolic-link file even with force", () => {
    const cwd = workspace();
    const project = initWorkerProject({
      cwd,
      target: "safe",
      compatibilityDate: "2026-08-26",
    });
    const outside = join(cwd, "outside.txt");
    writeFileSync(outside, "outside");
    rmSync(join(project.rootDir, "README.md"));
    symlinkSync(outside, join(project.rootDir, "README.md"));
    expect(() =>
      initWorkerProject({
        cwd,
        target: "safe",
        force: true,
        compatibilityDate: "2026-08-26",
      }),
    ).toThrow("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  test("preflights nested symbolic links before overwriting any managed file", () => {
    const cwd = workspace();
    const project = initWorkerProject({
      cwd,
      target: "safe",
      compatibilityDate: "2026-08-26",
    });
    const originalReadme = readFileSync(
      join(project.rootDir, "README.md"),
      "utf8",
    );
    const outside = workspace();
    rmSync(join(project.rootDir, "src"), { recursive: true });
    symlinkSync(outside, join(project.rootDir, "src"));
    expect(() =>
      initWorkerProject({
        cwd,
        target: "safe",
        template: "agent",
        force: true,
        compatibilityDate: "2026-08-26",
      }),
    ).toThrow("symbolic link");
    expect(readFileSync(join(project.rootDir, "README.md"), "utf8")).toBe(
      originalReadme,
    );
    expect(existsSync(join(outside, "index.ts"))).toBe(false);
  });

  test("validates direct module options before creating files", () => {
    const cwd = workspace();
    expect(() =>
      initWorkerProject({
        cwd,
        target: "bad-budget",
        previewDailyBudgetUsd: 0,
      }),
    ).toThrow("preview daily budget");
    expect(existsSync(join(cwd, "bad-budget", "xapi.worker.json"))).toBe(false);
  });
});
