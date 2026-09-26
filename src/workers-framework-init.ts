import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  WORKER_PROJECT_SCHEMA_URL,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  workerProjectConfigSchema,
} from "./workers-project.ts";

type PackageJson = Record<string, unknown> & {
  name?: string;
  packageManager?: string;
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
  defaultResourceLocation?: "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
  placementMode?: "off" | "smart";
  framework?: string;
}

export interface InitExistingFrameworkResult {
  framework: ExistingFramework;
  files: string[];
  configPath: string;
  nextSteps: string[];
}

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

function managerCommands(
  name: "npm" | "pnpm" | "yarn" | "bun",
  corepack: boolean,
  locked = false,
  modernYarn = false,
): { command: string; install: string } {
  const command = corepack && (name === "pnpm" || name === "yarn")
    ? `corepack ${name}`
    : name;
  const install = !locked ? "install" : name === "npm" ? "ci"
    : name === "yarn" && modernYarn ? "install --immutable"
    : "install --frozen-lockfile";
  return { command, install: `${command} ${install}` };
}

function packageManager(rootDir: string): { command: string; install: string } {
  type Manager = "npm" | "pnpm" | "yarn" | "bun";
  let selected: { name: Manager; corepack: boolean; major?: number } | undefined;
  const lockfiles: Record<Manager, string[]> = {
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    bun: ["bun.lock", "bun.lockb"],
    npm: ["npm-shrinkwrap.json", "package-lock.json"],
  };
  let cursor = rootDir;
  while (true) {
    const packagePath = join(cursor, "package.json");
    if (!selected && existsSync(packagePath) && lstatSync(packagePath).isFile()) {
      const declared = readPackage(packagePath).packageManager;
      const match = typeof declared === "string"
        ? declared.match(/^(npm|pnpm|yarn|bun)@(\d+)?/)
        : undefined;
      if (match) {
        const name = match[1] as Manager;
        selected = {
          name,
          corepack: name === "pnpm" || name === "yarn",
          major: match[2] ? Number(match[2]) : undefined,
        };
      }
    }
    // A package may declare its manager while sharing a lock at the workspace
    // root. Keep looking for that lock before choosing a mutable install.
    const candidates = selected ? [selected.name] : Object.keys(lockfiles) as Manager[];
    for (const name of candidates) {
      const lock = lockfiles[name].map(file => join(cursor, file))
        .find(path => existsSync(path) && lstatSync(path).isFile());
      if (lock) {
        const modernYarn = name === "yarn" && (selected?.major !== undefined
          ? selected.major >= 2 : /^__metadata:/m.test(readFileSync(lock, "utf8")));
        return managerCommands(name, selected?.corepack || false, true, modernYarn);
      }
    }

    // Existing applications are often initialized from a workspace package.
    // Include the repository root itself, then stop so an unrelated lockfile
    // higher in the filesystem cannot change the generated commands.
    if (existsSync(join(cursor, ".git"))) break;
    const parent = dirname(cursor);
    if (parent === cursor || basename(cursor) === "node_modules") break;
    cursor = parent;
  }
  return selected ? managerCommands(selected.name, selected.corepack) : managerCommands("npm", false);
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
  const workerPath = join(options.rootDir, "xapi-worker/index.mjs");
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
  // Do not mix a new entrypoint with an existing adapter from an older init.
  assertAvailable(join(options.rootDir, "xapi-worker/index.ts"));
  const pkg = readPackage(packagePath);
  const framework = detectFramework(
    options.rootDir,
    pkg,
    options.framework,
  );
  const manager = packageManager(options.rootDir);
  const scripts = object(pkg.scripts);
  if (typeof scripts.build !== "string" || !scripts.build.trim()) {
    throw new WorkerProjectConfigError(
      "worker_init_missing_build_script",
      "Existing framework package.json must define a non-empty build script",
    );
  }
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
      command: `${manager.command} run build`,
      output: "xapi-worker/index.mjs",
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
        ...(options.defaultResourceLocation ? { defaultResourceLocation: options.defaultResourceLocation } : {}),
        ...(options.placementMode ? { placementMode: options.placementMode } : {}),
        healthCheck: "/health",
        resources: [],
        secrets: [],
      },
      production: {
        dailyBudgetUsd: options.productionDailyBudgetUsd,
        ...(options.defaultResourceLocation ? { defaultResourceLocation: options.defaultResourceLocation } : {}),
        ...(options.placementMode ? { placementMode: options.placementMode } : {}),
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
    name: options.slug,
    main: "xapi-worker/index.mjs",
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
  const worker = `export default {\n  async fetch(request, _env) {\n    const url = new URL(request.url);\n    if (url.pathname === "/health" || url.pathname === "/api/health") {\n      return Response.json({ ok: true });\n    }\n    return Response.json({ error: "not_found" }, { status: 404 });\n  },\n};\n`;
  const gitignore = appendGitignore(options.rootDir);

  writeFileSync(join(options.rootDir, ".gitignore"), gitignore, "utf8");
  writeFileSync(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`, "utf8");
  writeFileSync(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  mkdirSync(dirname(workerPath), { recursive: true });
  writeFileSync(workerPath, worker, { encoding: "utf8", flag: "wx" });

  return {
    framework,
    files: [
      ".gitignore",
      "wrangler.jsonc",
      "xapi.worker.json",
      "xapi-worker/index.mjs",
    ],
    configPath,
    nextSteps: [
      manager.install,
      `${manager.command} run build`,
      "xapi workers plan --env preview",
      "xapi workers push --env preview",
    ],
  };
}
