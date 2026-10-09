import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importWranglerProject, readWranglerDeploymentSettings } from "../workers-wrangler-import.ts";
import { loadWorkerProject } from "../workers-project.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-wrangler-")));
  roots.push(root);
  return root;
}

describe("Wrangler project import", () => {
  test('keeps a package-less explicit project inside its own directory', () => {
    const parent=workspace(), root=join(parent,'standalone');
    writeFileSync(join(parent,'package.json'),'{}');
    mkdirSync(root);
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'standalone-worker',main:'index.mjs'}));
    const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
    expect(result.rootDir).toBe(root);
    expect(result.configPath).toBe(join(root,'xapi.worker.json'));
    expect(result.wrote).toBe(true);
    expect(existsSync(join(parent,'xapi.worker.json'))).toBe(false);
  });

  test('imports native long, Unicode, dollar, hyphen and prototype binding names and long Unicode classes', () => {
    const root = workspace();
    const names = ['B'+'x'.repeat(199), '中文绑定', '$binding', 'binding-hyphen', '__proto__'];
    const className = '中文类'+'y'.repeat(197);
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'native-names', main: 'index.mjs',
      durable_objects: { bindings: names.map(name => ({ name, class_name: className })) } }));
    const result = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' });
    expect(result.wrote).toBe(true);
    const resources = loadWorkerProject(root).config.environments.preview.resources;
    expect(resources).toHaveLength(names.length);
    expect(resources).toEqual(expect.arrayContaining(names.map(bindingName => ({ type: 'durable_object', bindingName, className }))));
    expect(Object.prototype).not.toHaveProperty('className');
  });
  test('retains explicit observability and selected environment override', () => {
    const root=workspace();
    writeFileSync(join(root,'package.json'),'{}');
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'observed-worker',main:'src/index.ts',observability:{enabled:true,logs:{enabled:true,persist:false}},env:{preview:{observability:{enabled:false}}}}));
    const imported=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
    expect(imported.report.entries.find(e=>e.path==='observability')?.category).toBe('SUPPORTED');
    const project=loadWorkerProject(root);
    expect(readWranglerDeploymentSettings(project,'production').observability).toEqual({enabled:true,logs:{enabled:true,persist:false}});
    expect(readWranglerDeploymentSettings(project,'preview').observability).toEqual({enabled:false});
  });
  test('imports a prebuilt native Container application and its Durable Object link', () => {
    const root = workspace();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({
      name: 'container-worker',
      main: 'src/index.ts',
      compatibility_date: '2026-09-21',
      durable_objects: {
        bindings: [{ name: 'TRADER', class_name: 'TraderContainer' }],
      },
      containers: [{
        name: 'trader',
        class_name: 'TraderContainer',
        image: 'docker.io/example/trader:v1',
        instance_type: 'lite',
        max_instances: 3,
        constraints: { regions: ['APAC'] },
      }],
    }, null, 2));
    const result = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' });
    expect(result.wrote).toBe(true);
    expect(result.report.entries).toContainEqual(expect.objectContaining({
      category: 'MANAGED', path: 'containers[0]',
    }));
    expect(loadWorkerProject(root).config.containers).toEqual([expect.objectContaining({
      name: 'trader', className: 'TraderContainer', instanceType: 'lite', maxInstances: 3,
    })]);
  });

  test('imports unnamed native Containers with stable distinct identities', () => {
    const root = workspace();
    const classes = ['HttpContainer', 'HTTPContainer'];
    const config = {name:'unnamed-containers',main:'src/index.ts',
      durable_objects:{bindings:classes.map((class_name,index)=>({name:`HTTP_${index}`,class_name}))},
      containers:classes.map(class_name=>({class_name,image:'docker.io/library/nginx:alpine',max_instances:1}))};
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(config));
    expect(importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'}).wrote).toBe(true);
    const first = loadWorkerProject(root).config.containers!;
    expect(first).toHaveLength(2);
    expect(new Set(first.map(item=>item.name)).size).toBe(2);
    config.containers.forEach(item=>item.image='docker.io/library/nginx:stable');
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(config));
    expect(importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true}).wrote).toBe(true);
    expect(loadWorkerProject(root).config.containers!.map(item=>item.name)).toEqual(first.map(item=>item.name));
  });

  test('does not silently import a local Dockerfile as a remotely deployable image', () => {
    const root = workspace();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({
      name: 'container-worker', main: 'src/index.ts',
      durable_objects: { bindings: [{ name: 'APP', class_name: 'AppContainer' }] },
      containers: [{ name: 'app', class_name: 'AppContainer', image: './Dockerfile' }],
    }));
    const result = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' });
    expect(result.wrote).toBe(false);
    expect(result.report.entries).toContainEqual(expect.objectContaining({
      category: 'UNSUPPORTED', path: 'containers[0]',
    }));
  });

  test("reports every JSONC decision and delegates new config fields to the native compiler", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    const original = `{
      // Existing provider-owned deployment settings must not be copied.
      "name": "existing-worker",
      "main": "src/index.ts",
      "compatibility_date": "2026-08-26",
      "compatibility_flags": ["nodejs_compat"],
      "assets": {
        "directory": "dist/client",
        "binding": "ASSETS",
        "html_handling": "auto-trailing-slash",
        "not_found_handling": "single-page-application",
        "run_worker_first": ["/api/*"]
      },
      "account_id": "provider-account-id",
      "routes": ["old.example/*"],
      "kv_namespaces": [{ "binding": "STATE", "id": "physical-kv-id" }],
      "d1_databases": [{ "binding": "DB", "database_id": "physical-d1-id" }],
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "physical-r2" }],
      "durable_objects": {
        "bindings": [{ "name": "AGENT", "class_name": "AgentState", "script_name": "old-script" }]
      },
      "queues": {
        "producers": [{ "binding": "EVENTS", "queue": "physical-queue" }]
      },
      "workflows": [{ "binding": "FLOW", "name": "physical-workflow", "class_name": "OldFlow" }],
      "vars": { "MODEL_KEY": "must-not-be-copied" },
      "hyperdrive": [{ "binding": "CACHE", "id": "physical-hyperdrive" }],
    }`;
    writeFileSync(path, original);

    const blocked = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.jsonc",
    });
    expect(blocked.wrote).toBe(true);
    expect(existsSync(join(root, "xapi.worker.json"))).toBe(true);
    expect(blocked.report.compatible).toBe(true);
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({ category: "REENTER", path: "hyperdrive" }),
    );
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({ category: "IGNORED", path: "account_id" }),
    );
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({
        category: "SUPPORTED",
        path: "vars",
      }),
    );
    expect(blocked.report.summary.MANAGED).toBe(12);
    expect(JSON.stringify(blocked.report)).not.toContain("physical-");
    expect(JSON.stringify(blocked.report)).not.toContain("must-not-be-copied");
    expect(readFileSync(path, "utf8")).toBe(original);

    const accepted = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.jsonc",
      acceptPartial: true,force:true,
    });
    expect(accepted.wrote).toBe(true);
    const project = loadWorkerProject(root);
    expect(
      project.config.environments.preview.resources.map(
        (resource) => resource.bindingName,
      ),
    ).toEqual(["AGENT", "DB", "EVENTS", "FILES", "FLOW", "STATE"]);
    expect(project.config.environments.preview.secrets).toEqual([]);
    expect(project.config.assets).toEqual({
      directory: "dist/client",
      binding: "ASSETS",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });
    const generated = readFileSync(join(root, "xapi.worker.json"), "utf8");
    expect(generated).not.toContain("provider-account-id");
    const generatedConfig=JSON.parse(generated);
    // A logical queue name links producer aliases; its original provider Queue
    // is not reused. Native IDs remain absent from all resource declarations.
    expect(generatedConfig.environments.preview.queueBindings).toEqual({'physical-queue':'EVENTS'});
    expect(JSON.stringify(generatedConfig.environments.preview.resources)).not.toContain('physical-');
    expect(generated).not.toContain("must-not-be-copied");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("imports TOML base and environment bindings without copying physical IDs", () => {
    const root = workspace();
    const path = join(root, "wrangler.toml");
    const original = `name = "toml-agent"
main = "src/index.ts"
compatibility_date = "2026-08-26"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[[kv_namespaces]]
binding = "STATE"
id = "old-kv-id"

[env.preview.vars]
MODEL_KEY = "never-copy-this"

[[env.production.d1_databases]]
binding = "DB"
database_id = "old-d1-id"
`;
    writeFileSync(path, original);
    const result = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.toml",
    });
    expect(result.wrote).toBe(true);
    expect(result.report.format).toBe("toml");
    const project = loadWorkerProject(root);
    expect(project.config.wrangler).toBe("wrangler.toml");
    expect(project.config.environments.preview.resources).toEqual([]);
    expect(project.config.environments.preview.secrets).toEqual([]);
    expect(readWranglerDeploymentSettings(project, 'preview').variables).toEqual({vars:{MODEL_KEY:'never-copy-this'}});
    expect(
      project.config.environments.production.resources.map(
        (resource) => resource.bindingName,
      ),
    ).toEqual(["DB"]);
    const generated = readFileSync(join(root, "xapi.worker.json"), "utf8");
    expect(generated).not.toContain("old-kv-id");
    expect(generated).not.toContain("old-d1-id");
    expect(generated).not.toContain("never-copy-this");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("requires force to replace only an existing xAPI project config", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    writeFileSync(path, '{ "name": "safe", "main": "src/index.ts" }');
    importWranglerProject({ cwd: root, wranglerPath: path });
    expect(() =>
      importWranglerProject({ cwd: root, wranglerPath: path }),
    ).toThrow("already exists");
    expect(
      importWranglerProject({ cwd: root, wranglerPath: path, force: true })
        .wrote,
    ).toBe(true);
  });

  test("reports compiler-owned environment fields and malformed input", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    writeFileSync(
      path,
      `{
        "name": "safe",
        "main": "src/index.ts",
        "env": { "preview": { "hyperdrive": [{ "binding": "CACHE" }] } }
      }`,
    );
    const report = importWranglerProject({ cwd: root, wranglerPath: path });
    expect(report.wrote).toBe(true);
    expect(report.report.entries).toContainEqual(
      expect.objectContaining({
        category: "REENTER",
        path: "env.preview.hyperdrive",
      }),
    );
    writeFileSync(path, "{ invalid jsonc");
    expect(() =>
      importWranglerProject({ cwd: root, wranglerPath: path }),
    ).toThrow("Invalid Wrangler JSONC");
  });

  test("imports a generated framework Wrangler config from a nested build directory", () => {
    const root = workspace();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "framework-app", scripts: { build: "vinext build" } }),
    );
    const serverDir = join(root, "dist", "server");
    const clientDir = join(root, "dist", "client");
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(clientDir, { recursive: true });
    const path = join(serverDir, "wrangler.json");
    writeFileSync(
      path,
      JSON.stringify({
        topLevelName: "framework-app",
        name: "framework-app",
        main: "index.js",
        compatibility_date: "2026-09-10",
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "../client" },
        durable_objects: { bindings: [] },
        queues: { producers: [], consumers: [] },
        workflows: [],
        services: [],
        exports: {},
        migrations: [],
        jsx_factory: "React.createElement",
        jsx_fragment: "React.Fragment",
        python_modules: { exclude: ["**/*.pyc"] },
      }),
    );

    const result = importWranglerProject({
      cwd: root,
      wranglerPath: "dist/server/wrangler.json",
    });

    expect(result.wrote).toBe(true);
    expect(result.rootDir).toBe(root);
    expect(result.report.summary.UNSUPPORTED).toBe(0);
    const project = loadWorkerProject(root);
    expect(project.config.wrangler).toBe("dist/server/wrangler.json");
    expect(project.config.assets).toEqual({ directory: "dist/client" });
    expect(existsSync(join(serverDir, "xapi.worker.json"))).toBe(false);
  });
});


describe('Container configurations per environment', () => {
  test('imports different preview and production specifications without discarding either', () => {
    const root=workspace();
    const declaration=(instance_type:string)=>[{name:'app',class_name:'AppContainer',image:'docker.io/library/nginx:alpine',instance_type,max_instances:1}];
    const durable_objects={bindings:[{name:'APP',class_name:'AppContainer'}]};
    writeFileSync(join(root,'package.json'),'{}');
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'env-container',main:'src/index.ts',env:{preview:{durable_objects,containers:declaration('lite')},production:{durable_objects,containers:declaration('basic')}}}));
    const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
    expect(result.wrote).toBe(true);
    const project=loadWorkerProject(root);
    expect(project.config.containers).toBeUndefined();
    expect(project.config.environments.preview.containers?.[0]?.instanceType).toBe('lite');
    expect(project.config.environments.production.containers?.[0]?.instanceType).toBe('basic');
    expect(result.report.entries.some(e=>e.category==='UNSUPPORTED')).toBe(false);
  });
  test('an explicitly empty environment does not inherit the other environment applications', () => {
    const root=workspace();
    writeFileSync(join(root,'package.json'),'{}');
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'env-container',main:'src/index.ts',env:{preview:{durable_objects:{bindings:[{name:'APP',class_name:'AppContainer'}]},containers:[{name:'app',class_name:'AppContainer',image:'docker.io/library/nginx:alpine'}]},production:{containers:[]}}}));
    const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
    expect(result.wrote).toBe(true);
    expect(loadWorkerProject(root).config.environments.production.containers).toEqual([]);
  });
});
