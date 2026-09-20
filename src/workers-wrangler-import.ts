import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  WORKER_PROJECT_CONFIG_FILE,
  WORKER_PROJECT_SCHEMA_URL,
  type LoadedWorkerProject,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  workerProjectConfigSchema,
  resolveWorkerProjectPath,
} from "./workers-project.ts";

const MAX_WRANGLER_BYTES = 512 * 1024;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

export type WranglerCompatibilityCategory =
  | "SUPPORTED"
  | "MANAGED"
  | "REENTER"
  | "IGNORED"
  | "UNSUPPORTED";

export interface WranglerCompatibilityEntry {
  category: WranglerCompatibilityCategory;
  path: string;
  message: string;
  environment?: "preview" | "production";
  resourceType?: WorkerProjectConfig["environments"]["preview"]["resources"][number]["type"];
  bindingName?: string;
}

export interface WranglerImportReport {
  version: 1;
  source: string;
  format: "jsonc" | "toml";
  compatible: boolean;
  entries: WranglerCompatibilityEntry[];
  summary: Record<WranglerCompatibilityCategory, number>;
}

export interface ImportWranglerProjectOptions {
  cwd?: string;
  wranglerPath: string;
  acceptPartial?: boolean;
  force?: boolean;
  buildCommand?: string;
  buildOutput?: string;
  buildMain?: string;
  previewDailyBudgetUsd?: number;
  productionDailyBudgetUsd?: number;
  defaultResourceLocation?: "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
  placementMode?: "off" | "smart";
}

export interface ImportWranglerProjectResult {
  rootDir: string;
  configPath: string;
  wrote: boolean;
  report: WranglerImportReport;
  config?: WorkerProjectConfig;
  nextSteps: string[];
}

export interface WranglerDeploymentSettings {
  compatibilityDate?: string;
  compatibilityFlags: string[];
}

type UnknownRecord = Record<string, unknown>;
type DesiredResource =
  WorkerProjectConfig["environments"]["preview"]["resources"][number];

const CATEGORY_ORDER: Record<WranglerCompatibilityCategory, number> = {
  SUPPORTED: 0,
  MANAGED: 1,
  REENTER: 2,
  IGNORED: 3,
  UNSUPPORTED: 4,
};

const SUPPORTED_TOP_LEVEL = new Set([
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "assets",
]);
const MANAGED_TOP_LEVEL = new Set([
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "workflows",
]);
const REENTER_TOP_LEVEL = new Set(["secrets", "secrets_store_secrets"]);
const PUBLIC_VARIABLE_TOP_LEVEL = new Set(["vars"]);
const IGNORED_TOP_LEVEL = new Set([
  "$schema",
  "account_id",
  "workers_dev",
  "route",
  "routes",
  "dev",
  "observability",
  "placement",
  "minify",
  "no_bundle",
  "find_additional_modules",
  "base_dir",
  "tsconfig",
  "rules",
  "build",
  "triggers",
  "usage_model",
  "keep_vars",
  "send_metrics",
  "logpush",
  "upload_source_maps",
  "legacy_assets",
  "site",
  "limits",
  "version_metadata",
  "tail_consumers",
  // Wrangler-generated framework configs can include build-time defaults that
  // have already been applied to the emitted Worker bundle. They are not
  // control-plane settings and do not need an xAPI desired-state mapping.
  "topLevelName",
  "configPath",
  "userConfigPath",
  "definedEnvironments",
  "jsx_factory",
  "jsx_fragment",
  "python_modules",
]);

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function structurallyEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  const object = record(value);
  return !!object && Object.values(object).every(structurallyEmpty);
}

function discoverProjectRoot(cwd: string, sourcePath: string): string {
  const sourceDir = dirname(sourcePath);
  const fromCwd = relative(cwd, sourcePath);
  if (
    fromCwd &&
    fromCwd !== ".." &&
    !fromCwd.startsWith(`..${sep}`) &&
    existsSync(resolve(cwd, "package.json"))
  ) {
    return realpathSync(cwd);
  }

  let cursor = sourceDir;
  while (true) {
    if (existsSync(resolve(cursor, "package.json"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return sourceDir;
    cursor = parent;
  }
}

function array(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is UnknownRecord => !!item)
    : [];
}

function stableEntries(
  entries: WranglerCompatibilityEntry[],
): WranglerCompatibilityEntry[] {
  return entries.sort(
    (a, b) =>
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      (a.environment || "").localeCompare(b.environment || "") ||
      a.path.localeCompare(b.path) ||
      (a.bindingName || "").localeCompare(b.bindingName || ""),
  );
}

function parseWrangler(path: string): {
  format: "jsonc" | "toml";
  config: UnknownRecord;
} {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new WorkerProjectConfigError(
      "wrangler_import_not_found",
      `Wrangler configuration is not a file: ${path}`,
    );
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new WorkerProjectConfigError(
      "wrangler_import_symlink",
      `Refusing to import a symbolic-link Wrangler file: ${path}`,
    );
  }
  const size = statSync(path).size;
  if (size > MAX_WRANGLER_BYTES) {
    throw new WorkerProjectConfigError(
      "wrangler_import_too_large",
      `Wrangler configuration exceeds ${MAX_WRANGLER_BYTES} bytes`,
    );
  }
  const source = readFileSync(path, "utf8");
  const extension = extname(path).toLowerCase();
  let parsed: unknown;
  if (extension === ".toml") {
    try {
      parsed = parseToml(source);
    } catch (error) {
      throw new WorkerProjectConfigError(
        "wrangler_import_invalid_toml",
        `Invalid Wrangler TOML: ${error instanceof Error ? error.message : "parse failed"}`,
      );
    }
  } else if (extension === ".json" || extension === ".jsonc") {
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    parsed = parseJsonc(source, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length) {
      const first = errors[0];
      throw new WorkerProjectConfigError(
        "wrangler_import_invalid_jsonc",
        `Invalid Wrangler JSONC at byte ${first.offset}: ${printParseErrorCode(first.error)}`,
      );
    }
  } else {
    throw new WorkerProjectConfigError(
      "wrangler_import_unsupported_format",
      "Wrangler configuration must end in .json, .jsonc, or .toml",
    );
  }
  const config = record(parsed);
  if (!config) {
    throw new WorkerProjectConfigError(
      "wrangler_import_invalid_root",
      "Wrangler configuration root must be an object/table",
    );
  }
  return { format: extension === ".toml" ? "toml" : "jsonc", config };
}

function compatibilityEntry(
  entries: WranglerCompatibilityEntry[],
  category: WranglerCompatibilityCategory,
  path: string,
  message: string,
  extras: Partial<WranglerCompatibilityEntry> = {},
): void {
  entries.push({ category, path, message, ...extras });
}

function bindingName(
  value: unknown,
  path: string,
  entries: WranglerCompatibilityEntry[],
  environment: "preview" | "production",
): string | undefined {
  if (typeof value !== "string" || !BINDING_NAME.test(value)) {
    compatibilityEntry(
      entries,
      "UNSUPPORTED",
      path,
      "Binding name must match ^[A-Z][A-Z0-9_]{0,63}$ before xAPI can manage it",
      { environment },
    );
    return undefined;
  }
  return value;
}

function staticAssets(
  preview: UnknownRecord,
  production: UnknownRecord,
  entries: WranglerCompatibilityEntry[],
  sourceDir: string,
  rootDir: string,
): WorkerProjectConfig["assets"] | undefined {
  const previewAssets = record(preview.assets);
  const productionAssets = record(production.assets);
  if (!previewAssets && !productionAssets) return undefined;
  if (JSON.stringify(previewAssets) !== JSON.stringify(productionAssets)) {
    compatibilityEntry(entries, "UNSUPPORTED", "assets", "Environment-specific static asset settings are not portable; use one shared assets configuration");
    return undefined;
  }
  const source = previewAssets || productionAssets!;
  const sourceDirectory = source.directory;
  const absoluteDirectory =
    typeof sourceDirectory === "string"
      ? resolve(sourceDir, sourceDirectory)
      : undefined;
  const projectDirectory = absoluteDirectory
    ? relative(rootDir, absoluteDirectory).split(sep).join("/")
    : sourceDirectory;
  const candidate = {
    directory: projectDirectory,
    ...(source.binding !== undefined ? { binding: source.binding } : {}),
    ...(source.html_handling !== undefined ? { htmlHandling: source.html_handling } : {}),
    ...(source.not_found_handling !== undefined ? { notFoundHandling: source.not_found_handling } : {}),
    ...(source.run_worker_first !== undefined ? { runWorkerFirst: source.run_worker_first } : {}),
  };
  const parsed = workerProjectConfigSchema.shape.assets.safeParse(candidate);
  if (!parsed.success) {
    compatibilityEntry(entries, "UNSUPPORTED", "assets", `Static assets are invalid: ${parsed.error.issues[0]?.message || "invalid configuration"}`);
    return undefined;
  }
  for (const key of Object.keys(source)) {
    if (!["directory", "binding", "html_handling", "not_found_handling", "run_worker_first"].includes(key)) {
      compatibilityEntry(entries, "UNSUPPORTED", `assets.${key}`, "This static asset setting is not supported by xAPI yet");
    }
  }
  compatibilityEntry(entries, "SUPPORTED", "assets", "Static asset directory, binding, and routing settings will be preserved");
  return parsed.data;
}

function physicalFields(
  item: UnknownRecord,
  retained: Set<string>,
  path: string,
  entries: WranglerCompatibilityEntry[],
  environment: "preview" | "production",
): void {
  for (const key of Object.keys(item)) {
    if (!retained.has(key)) {
      compatibilityEntry(
        entries,
        "IGNORED",
        `${path}.${key}`,
        "Cloudflare physical identifiers and provider settings are not copied; xAPI provisions its own resource",
        { environment },
      );
    }
  }
}

function resourceList(
  config: UnknownRecord,
  prefix: string,
  environment: "preview" | "production",
  entries: WranglerCompatibilityEntry[],
): DesiredResource[] {
  const resources: DesiredResource[] = [];
  const add = (
    type: DesiredResource["type"],
    rawName: unknown,
    path: string,
    item: UnknownRecord,
    retained: Set<string>,
    className?: unknown,
  ) => {
    const name = bindingName(rawName, `${path}.binding`, entries, environment);
    if (!name) return;
    if (
      type === "durable_object" &&
      (typeof className !== "string" || !CLASS_NAME.test(className))
    ) {
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        `${path}.class_name`,
        "Durable Object class_name is required and must be a JavaScript class identifier",
        { environment, bindingName: name },
      );
      return;
    }
    const resource: DesiredResource =
      type === "durable_object"
        ? { type, bindingName: name, className: className as string }
        : { type, bindingName: name };
    resources.push(resource);
    compatibilityEntry(
      entries,
      "MANAGED",
      path,
      `xAPI will provision a new ${type} resource; the original Cloudflare resource is not reused`,
      { environment, resourceType: type, bindingName: name },
    );
    physicalFields(item, retained, path, entries, environment);
  };

  array(config.kv_namespaces).forEach((item, index) =>
    add(
      "kv_namespace",
      item.binding,
      `${prefix}kv_namespaces[${index}]`,
      item,
      new Set(["binding"]),
    ),
  );
  array(config.d1_databases).forEach((item, index) =>
    add(
      "d1_database",
      item.binding,
      `${prefix}d1_databases[${index}]`,
      item,
      new Set(["binding"]),
    ),
  );
  array(config.r2_buckets).forEach((item, index) =>
    add(
      "r2_bucket",
      item.binding,
      `${prefix}r2_buckets[${index}]`,
      item,
      new Set(["binding"]),
    ),
  );
  const durableObjects = record(config.durable_objects);
  array(durableObjects?.bindings).forEach((item, index) =>
    add(
      "durable_object",
      item.name,
      `${prefix}durable_objects.bindings[${index}]`,
      item,
      new Set(["name", "class_name"]),
      item.class_name,
    ),
  );
  if (durableObjects) {
    for (const key of Object.keys(durableObjects)) {
      if (key !== "bindings") {
        compatibilityEntry(
          entries,
          "UNSUPPORTED",
          `${prefix}durable_objects.${key}`,
          "This Durable Objects option cannot be represented by xAPI desired state",
          { environment },
        );
      }
    }
  }
  const queues = record(config.queues);
  array(queues?.producers).forEach((item, index) =>
    add(
      "queue",
      item.binding,
      `${prefix}queues.producers[${index}]`,
      item,
      new Set(["binding"]),
    ),
  );
  if (
    queues?.consumers !== undefined &&
    !structurallyEmpty(queues.consumers)
  ) {
    compatibilityEntry(
      entries,
      "UNSUPPORTED",
      `${prefix}queues.consumers`,
      "Queue consumer configuration is not imported; xAPI managed queues use the hosted Worker target",
      { environment },
    );
  }
  array(config.workflows).forEach((item, index) =>
    add(
      "workflow",
      item.binding,
      `${prefix}workflows[${index}]`,
      item,
      new Set(["binding"]),
    ),
  );

  const seen = new Set<string>();
  return resources
    .sort((a, b) => a.bindingName.localeCompare(b.bindingName))
    .filter((resource) => {
      if (seen.has(resource.bindingName)) {
        compatibilityEntry(
          entries,
          "UNSUPPORTED",
          `${prefix}${resource.bindingName}`,
          "A binding name can only be declared once per xAPI environment",
          { environment, bindingName: resource.bindingName },
        );
        return false;
      }
      seen.add(resource.bindingName);
      return true;
    });
}

function publicVariables(
  config: UnknownRecord,
  prefix: string,
  environment: "preview" | "production",
  entries: WranglerCompatibilityEntry[],
): void {
  const vars = record(config.vars);
  for (const name of Object.keys(vars || {}).sort()) {
    compatibilityEntry(
      entries,
      "UNSUPPORTED",
      `${prefix}vars.${name}`,
      "Plain-text variables are not copied or converted into Secrets. Remove this var from Wrangler and declare a Secret explicitly only when the value is sensitive",
      { environment, bindingName: name },
    );
  }
}

function secretNames(
  config: UnknownRecord,
  prefix: string,
  environment: "preview" | "production",
  entries: WranglerCompatibilityEntry[],
): string[] {
  const candidates = new Set<string>();
  if (Array.isArray(config.secrets)) {
    for (const value of config.secrets) {
      if (typeof value === "string") candidates.add(value);
    }
  }
  for (const item of array(config.secrets_store_secrets)) {
    if (typeof item.binding === "string") candidates.add(item.binding);
  }
  const accepted: string[] = [];
  for (const name of [...candidates].sort()) {
    if (!BINDING_NAME.test(name)) {
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        `${prefix}vars.${name}`,
        "Variable or secret name is incompatible with xAPI secret bindings",
        { environment },
      );
      continue;
    }
    accepted.push(name);
    compatibilityEntry(
      entries,
      "REENTER",
      `${prefix}secret.${name}`,
      "Only the binding name is recorded; set its value again with xapi workers secrets set",
      { environment, bindingName: name },
    );
  }
  return accepted;
}

function selectedConfig(
  root: UnknownRecord,
  environment: "preview" | "production",
): { config: UnknownRecord; prefix: string } {
  const environments = record(root.env);
  const environmentConfig = record(environments?.[environment]);
  if (!environmentConfig) return { config: root, prefix: "" };
  const merged: UnknownRecord = { ...root, ...environmentConfig };
  delete merged.env;
  return { config: merged, prefix: `env.${environment}.` };
}

function inspectTopLevel(
  root: UnknownRecord,
  entries: WranglerCompatibilityEntry[],
): void {
  for (const key of Object.keys(root).sort()) {
    if (key === "env") continue;
    if (SUPPORTED_TOP_LEVEL.has(key)) {
      compatibilityEntry(
        entries,
        "SUPPORTED",
        key,
        "Retained through the referenced Wrangler configuration",
      );
    } else if (MANAGED_TOP_LEVEL.has(key)) {
      // Individual binding entries carry the actionable report.
    } else if (
      REENTER_TOP_LEVEL.has(key) ||
      PUBLIC_VARIABLE_TOP_LEVEL.has(key)
    ) {
      // Secret/variable names are reported per environment without values.
    } else if (IGNORED_TOP_LEVEL.has(key)) {
      compatibilityEntry(
        entries,
        "IGNORED",
        key,
        key === "account_id" || key === "route" || key === "routes"
          ? "Provider ownership is not transferred; xAPI uses its own Cloudflare account and routing"
          : "This Wrangler deployment option is not copied into xAPI project state",
      );
    } else {
      if (structurallyEmpty(root[key])) continue;
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        key,
        "This Wrangler field has no xAPI import mapping and will not be silently discarded",
      );
    }
  }
  const environments = record(root.env);
  for (const name of Object.keys(environments || {}).sort()) {
    if (name !== "preview" && name !== "production") {
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        `env.${name}`,
        "xAPI v1 imports only preview and production environments",
      );
      continue;
    }
    const environment = record(environments?.[name]);
    for (const key of Object.keys(environment || {}).sort()) {
      const path = `env.${name}.${key}`;
      if (SUPPORTED_TOP_LEVEL.has(key)) {
        compatibilityEntry(
          entries,
          "SUPPORTED",
          path,
          "Retained through the referenced Wrangler environment configuration",
          { environment: name },
        );
      } else if (
        MANAGED_TOP_LEVEL.has(key) ||
        REENTER_TOP_LEVEL.has(key) ||
        PUBLIC_VARIABLE_TOP_LEVEL.has(key)
      ) {
        // Actionable binding and secret entries are reported separately.
      } else if (IGNORED_TOP_LEVEL.has(key) || key === "name") {
        compatibilityEntry(
          entries,
          "IGNORED",
          path,
          "This Wrangler environment deployment option is not copied into xAPI project state",
          { environment: name },
        );
      } else {
        if (structurallyEmpty(environment?.[key])) continue;
        compatibilityEntry(
          entries,
          "UNSUPPORTED",
          path,
          "This Wrangler environment field has no xAPI import mapping",
          { environment: name },
        );
      }
    }
  }
}

function projectSlug(config: UnknownRecord, rootDir: string): string {
  const source =
    typeof config.name === "string" && config.name.trim()
      ? config.name
      : basename(rootDir);
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
  return /^[a-z][a-z0-9-]{1,47}[a-z0-9]$/.test(slug)
    ? slug
    : `worker-${slug || "imported"}`.slice(0, 49).replace(/-+$/g, "");
}

function projectName(config: UnknownRecord, slug: string): string {
  if (typeof config.name === "string" && config.name.trim().length >= 2) {
    return config.name.trim().slice(0, 80);
  }
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function budget(value: number | undefined, environment: string): number {
  const amount = value ?? (environment === "preview" ? 0.25 : 2);
  if (!Number.isFinite(amount) || amount < 0.1 || amount > 100) {
    throw new WorkerProjectConfigError(
      "wrangler_import_invalid_budget",
      `${environment} daily budget must be between 0.10 and 100 USD`,
    );
  }
  return amount;
}

function summary(
  entries: WranglerCompatibilityEntry[],
): Record<WranglerCompatibilityCategory, number> {
  const result: Record<WranglerCompatibilityCategory, number> = {
    SUPPORTED: 0,
    MANAGED: 0,
    REENTER: 0,
    IGNORED: 0,
    UNSUPPORTED: 0,
  };
  for (const entry of entries) result[entry.category] += 1;
  return result;
}

function packageManager(rootDir: string): string {
  if (existsSync(resolve(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (
    existsSync(resolve(rootDir, "bun.lock")) ||
    existsSync(resolve(rootDir, "bun.lockb"))
  )
    return "bun";
  if (existsSync(resolve(rootDir, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageScripts(rootDir: string): Record<string, string> {
  const path = resolve(rootDir, "package.json");
  if (!existsSync(path)) return {};
  try {
    const packageJson = record(JSON.parse(readFileSync(path, "utf8")));
    const scripts = record(packageJson?.scripts);
    return Object.fromEntries(
      Object.entries(scripts || {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function workerBuildScript(
  scripts: Record<string, string>,
): string | undefined {
  if (scripts["xapi:build"]) return "xapi:build";
  if (
    scripts.build &&
    /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+run\s+build:worker(?:\s|$)/.test(
      scripts.build,
    )
  ) {
    return "build";
  }
  if (
    scripts["build:worker"] &&
    /(?:--outfile|\bvinext\b|\bwrangler\b)/.test(scripts["build:worker"])
  ) {
    return "build:worker";
  }
  return scripts.build ? "build" : undefined;
}

function outfileFromScript(script: string | undefined): string | undefined {
  if (!script) return undefined;
  const match = script.match(
    /(?:^|\s)--outfile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/,
  );
  return match?.[1] || match?.[2] || match?.[3];
}

function portableProjectPath(
  rootDir: string,
  baseDir: string,
  value: string | undefined,
): string | undefined {
  if (!value || value.includes("\0")) return undefined;
  const path = relative(rootDir, resolve(baseDir, value)).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../")) return undefined;
  return path;
}

function inferredBuild(
  options: ImportWranglerProjectOptions,
  rootDir: string,
  sourceDir: string,
  wrangler: UnknownRecord,
): { command: string; output: string; main?: string; inferred: boolean } {
  const scripts = packageScripts(rootDir);
  const manager = packageManager(rootDir);
  const workerScript = workerBuildScript(scripts);
  const inferredCommand = workerScript
    ? `${manager} run ${workerScript}`
    : undefined;
  const scriptOutput = portableProjectPath(
    rootDir,
    rootDir,
    outfileFromScript(workerScript ? scripts[workerScript] : undefined),
  );
  const wranglerMain =
    typeof wrangler.main === "string" ? wrangler.main.trim() : undefined;
  const mainOutput =
    wranglerMain &&
    /\.(?:m?js)$/.test(wranglerMain) &&
    (sourceDir === rootDir || wranglerMain.includes("/"))
      ? portableProjectPath(rootDir, sourceDir, wranglerMain)
      : undefined;
  const output = options.buildOutput || scriptOutput || mainOutput;
  return {
    command: options.buildCommand || inferredCommand || "npm run build",
    output: output || "dist/worker.mjs",
    ...(options.buildMain ? { main: options.buildMain } : {}),
    inferred: Boolean(
      options.buildCommand ||
        options.buildOutput ||
        options.buildMain ||
        (inferredCommand && output),
    ),
  };
}

export function importWranglerProject(
  options: ImportWranglerProjectOptions,
): ImportWranglerProjectResult {
  const cwd = resolve(options.cwd || process.cwd());
  const requestedSourcePath = resolve(cwd, options.wranglerPath);
  const { format, config: wrangler } = parseWrangler(requestedSourcePath);
  const sourcePath = realpathSync(requestedSourcePath);
  const sourceDir = dirname(sourcePath);
  const rootDir = discoverProjectRoot(cwd, sourcePath);
  const configPath = resolve(rootDir, WORKER_PROJECT_CONFIG_FILE);
  const entries: WranglerCompatibilityEntry[] = [];
  inspectTopLevel(wrangler, entries);
  if (typeof wrangler.main !== "string" || !wrangler.main.trim()) {
    compatibilityEntry(
      entries,
      "UNSUPPORTED",
      "main",
      "A source entrypoint is required for an xAPI-hosted Worker",
    );
  }

  const desired = {
    preview: selectedConfig(wrangler, "preview"),
    production: selectedConfig(wrangler, "production"),
  };
  const assets = staticAssets(
    desired.preview.config,
    desired.production.config,
    entries,
    sourceDir,
    rootDir,
  );
  const previewResources = resourceList(
    desired.preview.config,
    desired.preview.prefix,
    "preview",
    entries,
  );
  const productionResources = resourceList(
    desired.production.config,
    desired.production.prefix,
    "production",
    entries,
  );
  publicVariables(
    desired.preview.config,
    desired.preview.prefix,
    "preview",
    entries,
  );
  publicVariables(
    desired.production.config,
    desired.production.prefix,
    "production",
    entries,
  );
  const previewSecrets = secretNames(
    desired.preview.config,
    desired.preview.prefix,
    "preview",
    entries,
  );
  const productionSecrets = secretNames(
    desired.production.config,
    desired.production.prefix,
    "production",
    entries,
  );
  const build = inferredBuild(options, rootDir, sourceDir, wrangler);
  compatibilityEntry(
    entries,
    build.inferred ? "SUPPORTED" : "REENTER",
    "build",
    build.inferred
      ? `Build inferred as ${build.command} → ${build.output}${build.main ? ` (main: ${build.main})` : ""}`
      : "Verify build.command and build.output; Wrangler source main is not necessarily the deployable build output",
  );

  const sortedEntries = stableEntries(entries);
  const report: WranglerImportReport = {
    version: 1,
    source: sourcePath,
    format,
    compatible: !sortedEntries.some(
      (entry) => entry.category === "UNSUPPORTED",
    ),
    entries: sortedEntries,
    summary: summary(sortedEntries),
  };
  if (!report.compatible && !options.acceptPartial) {
    return {
      rootDir,
      configPath,
      wrote: false,
      report,
      nextSteps: [
        "Resolve UNSUPPORTED entries, or review them and rerun with --accept-partial",
      ],
    };
  }
  if (existsSync(configPath)) {
    if (lstatSync(configPath).isSymbolicLink()) {
      throw new WorkerProjectConfigError(
        "wrangler_import_symlink_output",
        `Refusing to overwrite symbolic-link project config: ${configPath}`,
      );
    }
    if (!options.force) {
      throw new WorkerProjectConfigError(
        "wrangler_import_config_exists",
        `${WORKER_PROJECT_CONFIG_FILE} already exists; use --force to replace only this generated file`,
      );
    }
  }

  const wranglerPath = relative(rootDir, sourcePath).split(sep).join("/");
  const slug = projectSlug(wrangler, rootDir);
  const candidate = {
    $schema: WORKER_PROJECT_SCHEMA_URL,
    version: 1,
    worker: {
      name: projectName(wrangler, slug),
      slug,
      template: "worker" as const,
    },
    wrangler: wranglerPath,
    build: {
      command: build.command,
      output: build.output,
      ...(build.main ? { main: build.main } : {}),
    },
    ...(assets ? { assets } : {}),
    environments: {
      preview: {
        dailyBudgetUsd: budget(options.previewDailyBudgetUsd, "preview"),
        ...(options.defaultResourceLocation ? { defaultResourceLocation: options.defaultResourceLocation } : {}),
        ...(options.placementMode ? { placementMode: options.placementMode } : {}),
        healthCheck: "/health",
        resources: previewResources,
        secrets: previewSecrets,
      },
      production: {
        dailyBudgetUsd: budget(options.productionDailyBudgetUsd, "production"),
        ...(options.defaultResourceLocation ? { defaultResourceLocation: options.defaultResourceLocation } : {}),
        ...(options.placementMode ? { placementMode: options.placementMode } : {}),
        healthCheck: "/health",
        resources: productionResources,
        secrets: productionSecrets,
      },
    },
  };
  const parsed = workerProjectConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WorkerProjectConfigError(
      "wrangler_import_invalid_desired_state",
      `Imported project field ${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
  }
  writeFileSync(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  return {
    rootDir,
    configPath,
    wrote: true,
    report,
    config: parsed.data,
    nextSteps: [
      `Review ${WORKER_PROJECT_CONFIG_FILE}`,
      "Set every REENTER secret with xapi workers secrets set",
      "Resolve every reported Wrangler var as a public binding or an explicit Secret; xAPI never converts it automatically",
      "xapi workers plan --env preview",
    ],
  };
}

export function readWranglerDeploymentSettings(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
): WranglerDeploymentSettings {
  const path = resolveWorkerProjectPath(
    project,
    project.config.wrangler,
    "wrangler",
  );
  const { config } = parseWrangler(path);
  const selected = selectedConfig(config, environment).config;
  const date = selected.compatibility_date;
  if (
    date !== undefined &&
    (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
  ) {
    throw new WorkerProjectConfigError(
      "wrangler_invalid_compatibility_date",
      `${environment} compatibility_date must use YYYY-MM-DD`,
    );
  }
  const rawFlags = selected.compatibility_flags;
  if (
    rawFlags !== undefined &&
    (!Array.isArray(rawFlags) ||
      rawFlags.some((flag) => typeof flag !== "string" || !flag.trim()))
  ) {
    throw new WorkerProjectConfigError(
      "wrangler_invalid_compatibility_flags",
      `${environment} compatibility_flags must be an array of non-empty strings`,
    );
  }
  return {
    ...(date ? { compatibilityDate: date } : {}),
    compatibilityFlags: [...new Set((rawFlags || []) as string[])].sort(),
  };
}
