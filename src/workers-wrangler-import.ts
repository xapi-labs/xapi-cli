import { normalizeWorkerNativeMetadata } from './workers-native-metadata.ts';
import { WORKER_CLASS_IDENTIFIER, isWorkerBindingName } from './workers-binding-validation.ts';
import { normalizeWorkerObservability, normalizeWorkerPublicVariables, type WorkerPublicVariables } from './workers-artifact.ts';
import { WRANGLER_NON_INHERITED_FIELDS } from './workers-wrangler-environment.generated.ts';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  loadWorkerProject,
  assertWorkerContainerBindings,
  WORKER_PROJECT_CONFIG_FILE,
  WORKER_PROJECT_SCHEMA_URL,
  type LoadedWorkerProject,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  workerProjectConfigSchema,
  workerQueueConsumerSchema,
  resolveWorkerProjectPath,
} from "./workers-project.ts";

const MAX_WRANGLER_BYTES = 512 * 1024;

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
  previewDailyBudgetUsd?: number | null;
  productionDailyBudgetUsd?: number | null;
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
  observability?: import('./workers-artifact.ts').WorkerArtifactObservability;
  queueBindingAliases?: Record<string, string>;
  nativeMetadata?: Record<string, unknown>;
  nativeBundleRequired?: string[];
  requiredSecrets?: string[];
  variables?: WorkerPublicVariables;
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
  "observability",
  "vars",
  "placement", "limits", "version_metadata", "logpush", "keep_vars", "cache_options", "keep_assets", "tags", "tail_consumers",
]);
const MANAGED_TOP_LEVEL = new Set([
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "workflows",
  "containers",
  "triggers",
]);
const REENTER_TOP_LEVEL = new Set(["secrets", "secrets_store_secrets"]);
const IGNORED_TOP_LEVEL = new Set([
  "$schema",
  "account_id",
  "workers_dev",
  "route",
  "routes",
  "dev",
  "minify",
  "no_bundle",
  "find_additional_modules",
  "base_dir",
  "tsconfig",
  "rules",
  "build",
  "usage_model",
  "send_metrics",
  "upload_source_maps",
  "legacy_assets",
  "site",
  // Wrangler-generated framework configs can include build-time defaults that
  // have already been applied to the emitted Worker bundle. They are not
  // control-plane settings and do not need an xAPI desired-state mapping.
  "topLevelName",
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
  cwd = realpathSync(cwd);
  const sourceDir = dirname(sourcePath);
  const fromCwd = relative(cwd, sourcePath);
  const withinCwd = Boolean(fromCwd && fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`));
  if (withinCwd && existsSync(resolve(cwd, "package.json"))) {
    return realpathSync(cwd);
  }

  let cursor = sourceDir;
  while (true) {
    if (existsSync(resolve(cursor, "package.json"))) return cursor;
    // An explicitly selected local project may be package-less. Do not import
    // into an unrelated ancestor package merely because this folder is nested.
    if (withinCwd && cursor === cwd) return cwd;
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
  if (typeof value !== "string" || !isWorkerBindingName(value)) {
    compatibilityEntry(
      entries,
      "UNSUPPORTED",
      path,
      "Binding name must be a nonempty string",
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

function containerApplications(
  preview: UnknownRecord,
  production: UnknownRecord,
  entries: WranglerCompatibilityEntry[],
): WorkerProjectConfig['containers'] | undefined {
  const previewContainers = preview.containers;
  const productionContainers = production.containers;
  if (previewContainers === undefined && productionContainers === undefined) return undefined;
  const source = Array.isArray(previewContainers) ? previewContainers : productionContainers;
  if (!Array.isArray(source)) {
    compatibilityEntry(entries, 'UNSUPPORTED', 'containers', 'Wrangler containers must be an array');
    return undefined;
  }
  const candidates = source.map((raw, index) => {
    const item = record(raw);
    const path = `containers[${index}]`;
    if (!item) {
      compatibilityEntry(entries, 'UNSUPPORTED', path, 'Container configuration must be an object');
      return null;
    }
    const retained = new Set(['name', 'class_name', 'image', 'instance_type', 'max_instances', 'constraints', 'rollout_active_grace_period']);
    for (const key of Object.keys(item)) {
      if (!retained.has(key)) compatibilityEntry(entries, 'UNSUPPORTED', `${path}.${key}`, 'This native Container option is not supported by xAPI yet');
    }
    const constraints = record(item.constraints);
    if (constraints) {
      for (const key of Object.keys(constraints)) {
        if (!['regions', 'jurisdiction'].includes(key)) compatibilityEntry(entries, 'UNSUPPORTED', `${path}.constraints.${key}`, 'This Container placement constraint is not supported by xAPI yet');
      }
    }
    const candidate = {
      // Wrangler permits an omitted application name. Keep a stable logical
      // identity across updates; the backend supplies the tenant/environment
      // scoped physical name. Explicit user names retain their meaning.
      name: item.name ?? `container-${createHash('sha256').update(String(item.class_name)).digest('hex').slice(0, 12)}`,
      className: item.class_name,
      image: item.image,
      ...(item.instance_type !== undefined ? { instanceType: item.instance_type } : {}),
      ...(item.max_instances !== undefined ? { maxInstances: item.max_instances } : {}),
      ...(constraints
        ? {
            constraints: {
              ...(constraints.regions !== undefined ? { regions: constraints.regions } : {}),
              ...(constraints.jurisdiction !== undefined ? { jurisdiction: constraints.jurisdiction } : {}),
            },
          }
        : {}),
      ...(item.rollout_active_grace_period !== undefined
        ? { rolloutActiveGracePeriod: item.rollout_active_grace_period }
        : {}),
    };
    const parsed = workerProjectConfigSchema.shape.containers.unwrap().element.safeParse(candidate);
    if (!parsed.success) {
      compatibilityEntry(entries, 'UNSUPPORTED', path, `Container configuration is invalid: ${parsed.error.issues[0]?.message || 'invalid configuration'}`);
      return null;
    }
    compatibilityEntry(entries, 'MANAGED', path, 'xAPI will deploy this native Container application after its Worker and Durable Object namespace');
    return parsed.data;
  }).filter((item): item is NonNullable<typeof item> => !!item);
  return candidates.length ? candidates : undefined;
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

function referencedQueues(config: UnknownRecord): Map<string,string[]> {
  const groups = new Map<string,string[]>(), queues = record(config.queues);
  for (const p of array(queues?.producers)) if (typeof p.queue === 'string' && typeof p.binding === 'string')
    groups.set(p.queue, [...(groups.get(p.queue) || []), p.binding]);
  for (const c of array(queues?.consumers)) for (const name of [c.queue,c.dead_letter_queue])
    if (typeof name === 'string' && !groups.has(name)) groups.set(name, []);
  return groups;
}

function primaryQueueBinding(bindings: string[], resources: DesiredResource[], preferred?: string): string | undefined {
  if (preferred && resources.some(resource => resource.type === 'queue' && resource.bindingName === preferred)) return preferred;
  const names = [...new Set(bindings)].sort((a, b) => a.localeCompare(b));
  const existing = names.filter(name => resources.some(resource => resource.type === 'queue' && resource.bindingName === name));
  // Adding another producer is a new reference, not a new Queue identity.
  return existing.length === 1 ? existing[0] : names[0];
}

type NativeEvents = { queueConsumers: NonNullable<WorkerProjectConfig["environments"]["preview"]["queueConsumers"]>; crons: string[]; queueBindingAliases?: Record<string, string> };
function nativeEvents(config: UnknownRecord, resources: DesiredResource[], prefix: string, environment: "preview"|"production", entries: WranglerCompatibilityEntry[], queueBindings: Record<string,string> = {}): NativeEvents {
  const queues = record(config.queues);
  const queueConsumers: NativeEvents["queueConsumers"] = [];
  const logical = new Map<string, string[]>();
  const queueBindingAliases: Record<string, string> = Object.create(null);
  for (const producer of array(queues?.producers)) {
    if (typeof producer.queue === "string" && typeof producer.binding === "string") logical.set(producer.queue, [...(logical.get(producer.queue) || []), producer.binding]);
  }
  const resolvedQueueNames = new Map<string,string>();
  const resolveQueue = (name: string, path: string) => {
    const bindings = [...new Set(logical.get(name) || [])];
    bindings.sort((a,b) => a.localeCompare(b));
    const binding = primaryQueueBinding(bindings, resources, queueBindings[name]) || `QUEUE_${createHash("sha256").update(name).digest("hex").slice(0,16)}`;
    const otherQueue = resolvedQueueNames.get(binding);
    if (otherQueue !== undefined && otherQueue !== name) {
      compatibilityEntry(entries,'UNSUPPORTED',path,`Logical Queues ${otherQueue} and ${name} cannot share managed resource ${binding}; reassigning an existing primary binding to a different Queue needs an explicit resource migration`,{environment});
      return undefined;
    }
    resolvedQueueNames.set(binding,name);
    const existing = resources.find(resource => resource.bindingName === binding);
    if (existing && existing.type !== "queue") { compatibilityEntry(entries,"UNSUPPORTED",path,"Queue mapping conflicts with a declared resource type",{environment}); return undefined; }
    if (!existing) resources.push({type:"queue",bindingName:binding});
    return binding;
  };
  for (const [name, bindings] of logical) {
    const primary = resolveQueue(name, `${prefix}queues.producers`);
    if (primary) for (const alias of [...new Set(bindings)]) if (alias !== primary) queueBindingAliases[alias] = primary;
  }
  if (queues?.consumers !== undefined && !Array.isArray(queues.consumers)) compatibilityEntry(entries,"UNSUPPORTED",`${prefix}queues.consumers`,"Queue consumers must be an array",{environment});
  const seen = new Set<string>();
  (Array.isArray(queues?.consumers) ? queues.consumers : []).forEach((raw,index) => {
    const path = `${prefix}queues.consumers[${index}]`; const item = record(raw);
    if (!item || typeof item.queue !== "string" || !item.queue) { compatibilityEntry(entries,"UNSUPPORTED",path,"Queue consumer requires its logical queue name",{environment}); return; }
    const supported = new Set(["queue","max_batch_size","max_batch_timeout","max_retries","retry_delay","max_concurrency","dead_letter_queue"]);
    for (const key of Object.keys(item)) if (!supported.has(key)) compatibilityEntry(entries,"UNSUPPORTED",`${path}.${key}`,"The backend Queue consumer API has no mapping for this native field",{environment});
    if (seen.has(item.queue)) { compatibilityEntry(entries,"UNSUPPORTED",path,"Duplicate Queue consumer declarations cannot map to one owned consumer",{environment}); return; }
    seen.add(item.queue);
    const bindingName = resolveQueue(item.queue,`${path}.queue`); if (!bindingName) return;
    let deadLetterBinding: string|undefined;
    if (item.dead_letter_queue !== undefined) {
      if (typeof item.dead_letter_queue !== "string" || !item.dead_letter_queue || item.dead_letter_queue === item.queue) { compatibilityEntry(entries,"UNSUPPORTED",`${path}.dead_letter_queue`,"Dead-letter Queue must be a different Queue in the same environment",{environment}); return; }
      deadLetterBinding = resolveQueue(item.dead_letter_queue,`${path}.dead_letter_queue`); if (!deadLetterBinding) return;
    }
    const {queue,dead_letter_queue,...settings} = item;
    const parsed = workerQueueConsumerSchema.safeParse({bindingName,queue,...settings,...(deadLetterBinding ? {deadLetterBinding} : {})});
    if (!parsed.success) { compatibilityEntry(entries,"UNSUPPORTED",path,`Invalid Queue consumer settings: ${parsed.error.issues[0]?.message}`,{environment}); return; }
    queueConsumers.push(parsed.data);
    compatibilityEntry(entries,"MANAGED",path,"Configure the owned Queue host after deployment, preserving native batching, retry and dead-letter settings",{environment,bindingName});
  });
  const trigger = record(config.triggers); let crons: string[] = [];
  if (config.triggers !== undefined && !trigger) compatibilityEntry(entries,"UNSUPPORTED",`${prefix}triggers`,"Triggers must be an object",{environment});
  for (const key of Object.keys(trigger || {})) if (key !== "crons") compatibilityEntry(entries,"UNSUPPORTED",`${prefix}triggers.${key}`,"The backend schedule API only maps crons",{environment});
  if (trigger?.crons !== undefined) {
    if (!Array.isArray(trigger.crons) || trigger.crons.some(value => typeof value !== "string" || !value.trim())) compatibilityEntry(entries,"UNSUPPORTED",`${prefix}triggers.crons`,"Cron triggers must be nonempty strings",{environment});
    else { crons = [...new Set((trigger.crons as string[]).map(value=>value.trim()))]; if (crons.length) compatibilityEntry(entries,"MANAGED",`${prefix}triggers.crons`,"Create UTC scheduled-handler triggers with the backend scheduler and tracked run receipts",{environment}); }
  }
  return {queueConsumers,crons,...(Object.keys(queueBindingAliases).length ? {queueBindingAliases} : {})};
}

function resourceList(
  config: UnknownRecord,
  prefix: string,
  environment: "preview" | "production",
  entries: WranglerCompatibilityEntry[],
  previousResources: DesiredResource[] = [],
  queueBindings: Record<string,string> = {},
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
      (type === "durable_object" || (type === "workflow" && className !== undefined)) &&
      (typeof className !== "string" || !WORKER_CLASS_IDENTIFIER.test(className))
    ) {
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        `${path}.class_name`,
        "The exported class_name must be a JavaScript class identifier",
        { environment, bindingName: name },
      );
      return;
    }
    const resource: DesiredResource =
      (type === "durable_object" || (type === "workflow" && className !== undefined))
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
  const queueProducers = new Map<string, string[]>();
  for (const item of array(queues?.producers)) if (typeof item.queue === 'string' && typeof item.binding === 'string')
    queueProducers.set(item.queue, [...(queueProducers.get(item.queue) || []), item.binding]);
  const primaryQueues = new Map([...queueProducers].map(([queue, bindings]) => [queue, primaryQueueBinding(bindings, previousResources, queueBindings[queue])]));
  array(queues?.producers).forEach((item, index) => {
    const primary = typeof item.queue === 'string' ? primaryQueues.get(item.queue) : undefined;
    if (primary && !array(queues?.producers).some(p => p.binding === primary) && !resources.some(resource => resource.type === 'queue' && resource.bindingName === primary) &&
        previousResources.some(resource => resource.type === 'queue' && resource.bindingName === primary))
      resources.push(previousResources.find(resource => resource.type === 'queue' && resource.bindingName === primary)!);
    if (typeof item.queue === 'string' && primary !== item.binding) {
      if (!bindingName(item.binding, `${prefix}queues.producers[${index}].binding`, entries, environment)) return;
      compatibilityEntry(entries, "MANAGED", `${prefix}queues.producers[${index}]`, "Additional producer binding aliases the same owned Queue; no second resource or retention hold", {environment, bindingName: String(item.binding)});
      return;
    }
    add("queue", item.binding, `${prefix}queues.producers[${index}]`, item, new Set(["binding", "queue"]));
  });
  // Consumers and dead-letter references keep their original Queue resource,
  // even when every producer binding has been removed.
  for (const queue of referencedQueues(config).keys()) {
    const prior = previousResources.find(resource => resource.type === 'queue' && resource.bindingName === queueBindings[queue]);
    if (prior && !resources.some(resource => resource.bindingName === prior.bindingName)) resources.push(prior);
  }
  array(config.workflows).forEach((item, index) =>
    add(
      "workflow",
      item.binding,
      `${prefix}workflows[${index}]`,
      item,
      new Set(["binding", "class_name"]),
      item.class_name,
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

function secretNames(
  config: UnknownRecord,
  prefix: string,
  environment: "preview" | "production",
  entries: WranglerCompatibilityEntry[],
): string[] {
  const candidates = new Set<string>();
  if (config.vars !== undefined) normalizeWorkerPublicVariables(config.vars);
  if (Array.isArray(config.secrets)) {
    for (const value of config.secrets) {
      if (typeof value === "string") candidates.add(value);
    }
  }
  const required = record(config.secrets)?.required;
  if (Array.isArray(required)) for (const name of required)
    if (typeof name === 'string') candidates.add(name);
  for (const item of array(config.secrets_store_secrets)) {
    compatibilityEntry(entries, "UNSUPPORTED", `${prefix}secrets_store_secrets`,
      "Secret Store references need an owned store/secret mapping; they are not ordinary Secret values",
      {environment, ...(typeof item.binding === 'string' ? {bindingName:item.binding} : {})});
  }
  const accepted: string[] = [];
  for (const name of [...candidates].sort()) {
    if (!name.length) {
      compatibilityEntry(
        entries,
        "UNSUPPORTED",
        `${prefix}secrets.required`,
        "Required Secret names must be nonempty strings",
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
  // A named environment must explicitly declare its native bindings/vars.
  // This generated upstream contract does not filter supported configuration.
  for (const key of WRANGLER_NON_INHERITED_FIELDS)
    if (!Object.prototype.hasOwnProperty.call(environmentConfig, key)) delete merged[key];
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
    } else if (REENTER_TOP_LEVEL.has(key)) {
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
        "REENTER",
        key,
        "Retain this field through the original Wrangler native bundle; resource references still require owned mapping",
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
      } else if (MANAGED_TOP_LEVEL.has(key) || REENTER_TOP_LEVEL.has(key)) {
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
          "REENTER",
          path,
          "Retain this field through the original Wrangler native bundle; resource references still require owned mapping",
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

function budget(value: number | null | undefined, environment: string): number | null {
  const amount = value ?? null;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    throw new WorkerProjectConfigError(
      "wrangler_import_invalid_budget",
      `${environment} daily budget must be a finite nonnegative USD amount`,
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
  const sharedContainers = JSON.stringify(desired.preview.config.containers) === JSON.stringify(desired.production.config.containers);
  const containers = sharedContainers ? containerApplications(desired.preview.config, desired.production.config, entries) : undefined;
  const previewContainers = sharedContainers ? undefined : containerApplications(desired.preview.config, desired.preview.config, entries) ?? [];
  const productionContainers = sharedContainers ? undefined : containerApplications(desired.production.config, desired.production.config, entries) ?? [];
  // A reviewed re-import must not change physical resource identity merely
  // because a newly added alias sorts before the original binding.
  const previous = options.force && existsSync(configPath) ? loadWorkerProject(rootDir, configPath).config : undefined;
  const previewResources = resourceList(
    desired.preview.config,
    desired.preview.prefix,
    "preview",
    entries,
    previous?.environments.preview.resources,
    previous?.environments.preview.queueBindings,
  );
  const productionResources = resourceList(
    desired.production.config,
    desired.production.prefix,
    "production",
    entries,
    previous?.environments.production.resources,
    previous?.environments.production.queueBindings,
  );
  const previewEvents = nativeEvents(desired.preview.config, previewResources, desired.preview.prefix, "preview", entries, previous?.environments.preview.queueBindings);
  const productionEvents = nativeEvents(desired.production.config, productionResources, desired.production.prefix, "production", entries, previous?.environments.production.queueBindings);
  previewResources.sort((a,b) => a.bindingName.localeCompare(b.bindingName));
  productionResources.sort((a,b) => a.bindingName.localeCompare(b.bindingName));
  const queueBindingsFor = (config: UnknownRecord, resources: DesiredResource[], prior: Record<string,string> = {}) => {
    const mappings: Record<string,string> = Object.create(null);
    const queues = record(config.queues);
    for (const [queue, names] of referencedQueues(config)) {
      const binding = primaryQueueBinding(names, resources, prior[queue]) || `QUEUE_${createHash('sha256').update(queue).digest('hex').slice(0,16)}`;
      if (resources.some(resource => resource.type === 'queue' && resource.bindingName === binding)) mappings[queue] = binding;
    }
    return Object.keys(mappings).length ? mappings : undefined;
  };
  const previewQueueBindings = queueBindingsFor(desired.preview.config, previewResources, previous?.environments.preview.queueBindings);
  const productionQueueBindings = queueBindingsFor(desired.production.config, productionResources, previous?.environments.production.queueBindings);
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
  compatibilityEntry(
    entries,
    "REENTER",
    "build.output",
    "Verify the generated bundle path; Wrangler source main is not necessarily the build output",
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
    ...(previous?.workerId ? {workerId:previous.workerId} : {}),
    worker: {
      name: projectName(wrangler, slug),
      slug,
      template: "worker" as const,
    },
    wrangler: wranglerPath,
    build: { command: "npm run build", output: "dist/worker.mjs" },
    ...(assets ? { assets } : {}),
    ...(containers ? { containers } : {}),
    environments: {
      preview: {
        dailyBudgetUsd: budget(options.previewDailyBudgetUsd, "preview"),
        healthCheck: "/health",
        resources: previewResources,
        ...(previewQueueBindings ? {queueBindings:previewQueueBindings} : {}),
        ...(previewContainers !== undefined ? {containers: previewContainers} : {}),
        ...(previewEvents.queueConsumers.length ? {queueConsumers:previewEvents.queueConsumers} : {}),
        ...(previewEvents.crons.length ? {crons:previewEvents.crons} : {}),
        secrets: previewSecrets,
      },
      production: {
        dailyBudgetUsd: budget(options.productionDailyBudgetUsd, "production"),
        healthCheck: "/health",
        resources: productionResources,
        ...(productionQueueBindings ? {queueBindings:productionQueueBindings} : {}),
        ...(productionContainers !== undefined ? {containers: productionContainers} : {}),
        ...(productionEvents.queueConsumers.length ? {queueConsumers:productionEvents.queueConsumers} : {}),
        ...(productionEvents.crons.length ? {crons:productionEvents.crons} : {}),
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
  assertWorkerContainerBindings(parsed.data);
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
      "Set declared required Secrets with xapi workers secrets set; preserve other REENTER fields through Wrangler native build output",
      "xapi workers plan --env preview",
    ],
  };
}

/** Wrangler config and CF upload are different formats; emitted .bundle metadata is authoritative. */
function wranglerNativeMetadata(selected: UnknownRecord): Record<string, unknown> {
  const fields = ['placement','limits','logpush','observability','cache_options','keep_assets','tags','version_metadata','tail_consumers'];
  const entries = fields.filter(key => selected[key] !== undefined).map(key => [key,selected[key]]);
  if (selected.keep_vars !== undefined) {
    if (typeof selected.keep_vars !== 'boolean') throw new WorkerProjectConfigError('wrangler_invalid_keep_vars','keep_vars must be a boolean');
    entries.push(['keep_bindings',selected.keep_vars ? ['plain_text','json'] : []]);
  }
  return normalizeWorkerNativeMetadata(Object.fromEntries(entries))!;
}

export function readWranglerDeploymentSettings(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
  artifactMediaType?: string,
): WranglerDeploymentSettings {
  const path = resolveWorkerProjectPath(
    project,
    project.config.wrangler,
    "wrangler",
  );
  const { config } = parseWrangler(path);
  const selection = selectedConfig(config, environment);
  const selected = selection.config;
  const metadata = wranglerNativeMetadata(selected);
  const nativeBundleRequired = Object.keys(selected).filter(key => key !== 'env' &&
    !SUPPORTED_TOP_LEVEL.has(key) && !MANAGED_TOP_LEVEL.has(key) &&
    !REENTER_TOP_LEVEL.has(key) && !IGNORED_TOP_LEVEL.has(key) && !structurallyEmpty(selected[key]));
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
  let queueBindingAliases = readWranglerNativeEvents(project, environment).queueBindingAliases;
  // Promotion reuses the immutable preview Artifact. Explicitly clear its aliases
  // when production declares none, including a selected historical bundle.
  // Code-only Artifacts keep their historical deployment keys.
  if (environment === 'production' && queueBindingAliases === undefined &&
      (/^application\/vnd\.xapi\.worker-bundle\.v[12]\+json$/.test(artifactMediaType || '') ||
       readWranglerNativeEvents(project, 'preview').queueBindingAliases !== undefined))
    queueBindingAliases = {};
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
    ...(nativeBundleRequired.length ? {nativeBundleRequired} : {}),
    requiredSecrets: [...new Set([...project.config.environments[environment].secrets, ...secretNames(selected, selection.prefix, environment, [])])].sort(),
    ...(date ? { compatibilityDate: date } : {}),
    compatibilityFlags: [...new Set((rawFlags || []) as string[])].sort(),
    ...(selected.observability !== undefined ? {observability:selected.observability as NonNullable<WranglerDeploymentSettings['observability']>} : {}),
    ...(Object.keys(metadata).length || (environment === 'production' && /^application\/vnd\.xapi\.worker-bundle\.v[12]\+json$/.test(artifactMediaType || '')) ? {nativeMetadata:metadata} : {}),
    ...(queueBindingAliases ? {queueBindingAliases} : {}),
    // Named environments explicitly clear non-inherited variables. Promotion
    // of a bundle must not accidentally reuse immutable preview variables.
    ...(selected.vars !== undefined || selection.prefix ||
      (environment === 'production' && /^application\/vnd\.xapi\.worker-bundle\.v[12]\+json$/.test(artifactMediaType || ''))
      ? {variables:normalizeWorkerPublicVariables(selected.vars || {})} : {}),
  };
}


/** Preserve current Wrangler event intent; physical resources still come from desired bindings. */
export function readWranglerNativeEvents(project: LoadedWorkerProject, environment: "preview"|"production"): NativeEvents {
  const {config} = parseWrangler(resolveWorkerProjectPath(project,project.config.wrangler,"wrangler"));
  const selected = selectedConfig(config,environment);
  const entries: WranglerCompatibilityEntry[] = [];
  const declared = project.config.environments[environment];
  const resources = [...declared.resources];
  const events = nativeEvents(selected.config,resources,selected.prefix,environment,entries,declared.queueBindings);
  const unsupported = entries.filter(entry=>entry.category === "UNSUPPORTED");
  if (unsupported.length) throw new WorkerProjectConfigError("worker_native_event_mapping_unavailable",unsupported.map(entry=>`${entry.path}: ${entry.message}`).join("; "));
  if (!record(selected.config.queues) || record(selected.config.queues)?.consumers === undefined) events.queueConsumers = declared.queueConsumers || [];
  if (!record(selected.config.triggers) || record(selected.config.triggers)?.crons === undefined) events.crons = declared.crons || [];
  for (const consumer of events.queueConsumers) for (const binding of [consumer.bindingName,consumer.deadLetterBinding].filter(Boolean)) {
    if (!declared.resources.some(resource=>resource.type === "queue" && resource.bindingName === binding)) throw new WorkerProjectConfigError("worker_queue_consumer_resource_missing",`Queue consumer binding ${binding} is missing from owned project resources; import the Wrangler configuration or declare this Queue`);
  }
  for (const [alias, target] of Object.entries(events.queueBindingAliases || {})) {
    if (declared.resources.some(resource => resource.bindingName === alias) ||
        !declared.resources.some(resource => resource.type === 'queue' && resource.bindingName === target))
      throw new WorkerProjectConfigError('worker_queue_alias_resource_conflict', `Queue alias ${alias} must point to primary Queue ${target}; re-import the project to review legacy duplicate resources before deployment`);
  }
  return events;
}
