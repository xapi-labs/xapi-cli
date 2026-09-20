import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  WORKER_PROJECT_SCHEMA_URL,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  workerProjectConfigSchema,
} from "./workers-project.ts";

type PackageJson = Record<string, unknown> & {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type ExistingFramework =
  | "react-vite"
  | "vue-vite"
  | "vite"
  | "react"
  | "vue"
  | "next-static";

export interface InitExistingFrameworkOptions {
  rootDir: string;
  name: string;
  slug: string;
  compatibilityDate: string;
  previewDailyBudgetUsd: number;
  productionDailyBudgetUsd: number;
  framework?: string;
}

export interface InitExistingFrameworkResult {
  framework: ExistingFramework;
  files: string[];
  configPath: string;
  nextSteps: string[];
}

const XAPI_SCRIPTS = {
  "xapi:worker:build":
    "esbuild xapi-worker/index.ts --bundle --format=esm --platform=neutral --target=es2022 --outfile=.xapi/worker/index.mjs",
  "xapi:worker:dev":
    "wrangler dev --config wrangler.jsonc --persist-to .wrangler/state",
} as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPackage(path: string): PackageJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_package_json",
      `Unable to parse package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_package_json",
      "package.json must contain a JSON object",
    );
  }
  return parsed as PackageJson;
}

function dependencies(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(object(pkg.dependencies)),
    ...Object.keys(object(pkg.devDependencies)),
  ]);
}

function hasStaticNextExport(rootDir: string): boolean {
  for (const name of [
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
    "next.config.ts",
  ]) {
    const path = join(rootDir, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const source = readFileSync(path, "utf8");
    if (/\boutput\s*:\s*["']export["']/.test(source)) return true;
  }
  return false;
}

function detectFramework(
  rootDir: string,
  pkg: PackageJson,
  requested = "auto",
): ExistingFramework {
  const deps = dependencies(pkg);
  const selected = requested.toLowerCase();
  if (!["auto", "react", "vite", "vue", "next"].includes(selected)) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_framework",
      "--framework must be auto, react, vite, vue, or next",
    );
  }
  const next = selected === "next" || (selected === "auto" && deps.has("next"));
  if (next) {
    if (!hasStaticNextExport(rootDir)) {
      throw new WorkerProjectConfigError(
        "worker_init_next_adapter_required",
        "Next.js SSR requires a Workers adapter. Run `npx vinext check` and `npx vinext init`, then import its generated Wrangler configuration with `xapi workers init --from-wrangler ./wrangler.jsonc`. Automatic init currently accepts Next.js only when next.config.* declares output: 'export'.",
      );
    }
    return "next-static";
  }
  const vite = deps.has("vite");
  const vue = deps.has("vue") || deps.has("@vue/cli-service");
  const react =
    deps.has("react") ||
    deps.has("react-scripts") ||
    deps.has("@vitejs/plugin-react") ||
    deps.has("@vitejs/plugin-react-swc");
  if (selected === "vite") return "vite";
  if (selected === "vue") return vite ? "vue-vite" : "vue";
  if (selected === "react") return vite ? "react-vite" : "react";
  if (vite && vue) return "vue-vite";
  if (vite && react) return "react-vite";
  if (vite) return "vite";
  if (deps.has("react-scripts")) return "react";
  if (deps.has("@vue/cli-service")) return "vue";
  if (react) return "react";
  if (vue) return "vue";
  throw new WorkerProjectConfigError(
    "worker_init_framework_not_detected",
    "Unable to detect React, Vite, Vue, or Next.js from package.json; pass --framework explicitly or use --from-wrangler for an existing Worker project",
  );
}

function packageManager(rootDir: string): { command: string; install: string } {
  if (existsSync(join(rootDir, "pnpm-lock.yaml")))
    return { command: "pnpm", install: "pnpm install" };
  if (existsSync(join(rootDir, "yarn.lock")))
    return { command: "yarn", install: "yarn install" };
  if (
    existsSync(join(rootDir, "bun.lock")) ||
    existsSync(join(rootDir, "bun.lockb"))
  )
    return { command: "bun", install: "bun install" };
  return { command: "npm", install: "npm install" };
}

function outputDirectory(framework: ExistingFramework): string {
  if (framework === "react") return "build";
  if (framework === "next-static") return "out";
  return "dist";
}

function appendGitignore(rootDir: string): string {
  const path = join(rootDir, ".gitignore");
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new WorkerProjectConfigError(
      "worker_init_symlink_file",
      `Refusing to write through symbolic link: ${path}`,
    );
  }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  for (const line of [".xapi", ".wrangler", ".dev.vars*"]) lines.add(line);
  return `${[...lines].join("\n")}\n`;
}

function assertAvailable(path: string): void {
  if (existsSync(path)) {
    throw new WorkerProjectConfigError(
      "worker_init_existing_file_conflict",
      `Refusing to replace existing project file: ${path}`,
    );
  }
}

function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new WorkerProjectConfigError(
      "worker_init_symlink_file",
      `Refusing to write through symbolic link: ${path}`,
    );
  }
}

export function initExistingFrameworkProject(
  options: InitExistingFrameworkOptions,
): InitExistingFrameworkResult {
  const packagePath = join(options.rootDir, "package.json");
  const configPath = join(options.rootDir, "xapi.worker.json");
  const wranglerPath = join(options.rootDir, "wrangler.jsonc");
  const workerPath = join(options.rootDir, "xapi-worker/index.ts");
  assertNotSymlink(packagePath);
  assertNotSymlink(join(options.rootDir, "xapi-worker"));
  assertAvailable(configPath);
  if (existsSync(wranglerPath)) {
    throw new WorkerProjectConfigError(
      "worker_init_existing_wrangler",
      "This project already has wrangler.jsonc; preserve it and run `xapi workers init --from-wrangler ./wrangler.jsonc`",
    );
  }
  assertAvailable(workerPath);
  const pkg = readPackage(packagePath);
  const framework = detectFramework(
    options.rootDir,
    pkg,
    options.framework,
  );
  const manager = packageManager(options.rootDir);
  const scripts = { ...object(pkg.scripts) } as Record<string, string>;
  if (typeof scripts.build !== "string" || !scripts.build.trim()) {
    throw new WorkerProjectConfigError(
      "worker_init_missing_build_script",
      "Existing framework package.json must define a non-empty build script",
    );
  }
  for (const [name, command] of Object.entries(XAPI_SCRIPTS)) {
    if (scripts[name] && scripts[name] !== command) {
      throw new WorkerProjectConfigError(
        "worker_init_package_script_conflict",
        `package.json script ${name} already exists with a different command`,
      );
    }
    scripts[name] = command;
  }
  const xapiBuild = `${manager.command} run build && ${manager.command} run xapi:worker:build`;
  if (scripts["xapi:build"] && scripts["xapi:build"] !== xapiBuild) {
    throw new WorkerProjectConfigError(
      "worker_init_package_script_conflict",
      "package.json script xapi:build already exists with a different command",
    );
  }
  scripts["xapi:build"] = xapiBuild;
  const devDependencies = {
    ...object(pkg.devDependencies),
    esbuild: (object(pkg.devDependencies).esbuild as string | undefined) || "^0.25.0",
    wrangler: (object(pkg.devDependencies).wrangler as string | undefined) || "^4.0.0",
  };
  const nextPackage = {
    ...pkg,
    scripts,
    devDependencies,
  };
  const assetsDirectory = outputDirectory(framework);
  const nextStatic = framework === "next-static";
  const configCandidate: WorkerProjectConfig = {
    $schema: WORKER_PROJECT_SCHEMA_URL,
    version: 1,
    worker: {
      name: options.name,
      slug: options.slug,
      template: "worker",
      description: `Existing ${framework} application`,
    },
    wrangler: "wrangler.jsonc",
    build: {
      command: `${manager.command} run xapi:build`,
      output: ".xapi/worker/index.mjs",
    },
    assets: {
      directory: assetsDirectory,
      binding: "ASSETS",
      ...(nextStatic
        ? {
            htmlHandling: "auto-trailing-slash" as const,
            notFoundHandling: "404-page" as const,
          }
        : { notFoundHandling: "single-page-application" as const }),
      runWorkerFirst: ["/api/*", "/health"],
    },
    environments: {
      preview: {
        dailyBudgetUsd: options.previewDailyBudgetUsd,
        healthCheck: "/health",
        resources: [],
        secrets: [],
      },
      production: {
        dailyBudgetUsd: options.productionDailyBudgetUsd,
        healthCheck: "/health",
        resources: [],
        secrets: [],
      },
    },
  };
  const parsed = workerProjectConfigSchema.safeParse(configCandidate);
  if (!parsed.success) {
    throw new WorkerProjectConfigError(
      "worker_init_generated_config_invalid",
      `Generated xapi.worker.json is invalid: ${parsed.error.issues[0]?.message || "unknown error"}`,
    );
  }
  const wrangler = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: options.slug,
    main: "xapi-worker/index.ts",
    compatibility_date: options.compatibilityDate,
    assets: {
      directory: `./${assetsDirectory}`,
      binding: "ASSETS",
      ...(nextStatic
        ? {
            html_handling: "auto-trailing-slash",
            not_found_handling: "404-page",
          }
        : { not_found_handling: "single-page-application" }),
      run_worker_first: ["/api/*", "/health"],
    },
  };
  const worker = `export interface Env {\n  ASSETS: { fetch(request: Request): Promise<Response> };\n}\n\nexport default {\n  async fetch(request: Request, _env: Env): Promise<Response> {\n    const url = new URL(request.url);\n    if (url.pathname === "/health" || url.pathname === "/api/health") {\n      return Response.json({ ok: true });\n    }\n    return Response.json({ error: "not_found" }, { status: 404 });\n  },\n};\n`;
  const gitignore = appendGitignore(options.rootDir);

  writeFileSync(packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`, "utf8");
  writeFileSync(join(options.rootDir, ".gitignore"), gitignore, "utf8");
  writeFileSync(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`, "utf8");
  writeFileSync(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  mkdirSync(dirname(workerPath), { recursive: true });
  writeFileSync(workerPath, worker, { encoding: "utf8", flag: "wx" });

  return {
    framework,
    files: [
      "package.json",
      ".gitignore",
      "wrangler.jsonc",
      "xapi.worker.json",
      "xapi-worker/index.ts",
    ],
    configPath,
    nextSteps: [
      manager.install,
      `${manager.command} run xapi:build`,
      "xapi workers plan --env preview",
      "xapi workers push --env preview",
    ],
  };
}
