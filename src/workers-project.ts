import { WORKER_CLASS_IDENTIFIER } from './workers-binding-validation.ts';
import { existsSync, realpathSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "path";
import { z } from "zod";

export const WORKER_PROJECT_CONFIG_FILE = "xapi.worker.json";
export const WORKER_PROJECT_SCHEMA_URL =
  "https://xapi.to/schemas/worker-project.v1.json";
const MAX_CONFIG_BYTES = 128 * 1024;

const relativeProjectPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.includes("\0"),
    "must be a portable path inside the Worker project",
  );

export const workerManagedResourceSchema = z
  .object({
    type: z.enum([
      "kv_namespace",
      "d1_database",
      "r2_bucket",
      "durable_object",
      "queue",
      "workflow",
    ]),
    bindingName: z
      .string()
      .min(1),
    className: z
      .string()
      .regex(WORKER_CLASS_IDENTIFIER)
      .optional(),
    workflowName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
    location: z
      .enum(["wnam", "enam", "weur", "eeur", "apac", "oc"])
      .optional(),
    readReplication: z.enum(["auto", "disabled"]).optional(),
  })
  .strict()
  .superRefine((resource, context) => {
    if (resource.type === "durable_object" && !resource.className) {
      context.addIssue({
        code: "custom",
        path: ["className"],
        message: "is required for a durable_object resource",
      });
    }
    if (!["durable_object", "workflow"].includes(resource.type) && resource.className) {
      context.addIssue({
        code: "custom",
        path: ["className"],
        message: "is only valid for a durable_object or workflow resource",
      });
    }
    if (resource.workflowName && (resource.type !== "workflow" || !resource.className)) {
      context.addIssue({ code: "custom", path: ["workflowName"], message: "requires a workflow resource with className" });
    }
    if (
      resource.location &&
      resource.type !== "d1_database" &&
      resource.type !== "r2_bucket"
    ) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "is only valid for d1_database and r2_bucket resources",
      });
    }
    if (resource.readReplication && resource.type !== "d1_database") {
      context.addIssue({
        code: "custom",
        path: ["readReplication"],
        message: "is only valid for a d1_database resource",
      });
    }
  });

const desiredResourcesSchema = z
  .array(workerManagedResourceSchema)
  .default([])
  .superRefine((resources, context) => {
    const seen = new Set<string>();
    resources.forEach((resource, index) => {
      if (seen.has(resource.bindingName)) {
        context.addIssue({
          code: "custom",
          path: [index, "bindingName"],
          message: `duplicates binding ${resource.bindingName}`,
        });
      }
      seen.add(resource.bindingName);
    });
  });

const desiredSecretsSchema = z
  .array(z.string().min(1))
  .default([])
  .transform((secrets) => [...new Set(secrets)].sort());

export const workerQueueConsumerSchema = z.object({
  bindingName: z.string().min(1),
  queue: z.string().min(1),
  max_batch_size: z.number().int().optional(),
  max_batch_timeout: z.number().int().optional(),
  max_retries: z.number().int().optional(),
  retry_delay: z.number().int().optional(),
  max_concurrency: z.number().int().optional(),
  deadLetterBinding: z.string().min(1).optional(),
}).strict();

const environmentSchema = z
  .object({
    dailyBudgetUsd: z.number().finite().min(0).nullable().default(null),
    defaultResourceLocation: z.enum(["wnam", "enam", "weur", "eeur", "apac", "oc"]).optional(),
    placementMode: z.enum(["off", "smart"]).optional(),
    healthCheck: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)[^\s]*$/, "must be an absolute Worker URL path")
      .default("/health"),
    resources: desiredResourcesSchema,
    secrets: desiredSecretsSchema,
    queueConsumers: z.array(workerQueueConsumerSchema).optional(),
    queueBindings: z.record(z.string().min(1), z.string().min(1)).optional(),
    crons: z.array(z.string().min(1)).optional(),
    containers: z.lazy(() => containersSchema).optional(),
  })
  .strict();

const staticAssetsSchema = z
  .object({
    directory: relativeProjectPath,
    binding: z
      .string()
      .min(1)
      .optional(),
    htmlHandling: z
      .enum([
        "auto-trailing-slash",
        "force-trailing-slash",
        "drop-trailing-slash",
        "none",
      ])
      .optional(),
    notFoundHandling: z
      .enum(["none", "404-page", "single-page-application"])
      .optional(),
    runWorkerFirst: z
      .union([
        z.boolean(),
        z
          .array(z.string().min(1).max(500).regex(/^!?\//))
          .min(1)
          .max(100),
      ])
      .optional(),
  })
  .strict();

export const workerContainerSchema = z
  .object({
    name: z.string().regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    className: z.string().regex(WORKER_CLASS_IDENTIFIER),
    image: z
      .string()
      .max(512)
      .regex(
        /^(?:registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})?|docker\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})?|[a-z0-9.-]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})?|[a-z0-9.-]+-docker\.pkg\.dev\/[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})?)$/,
        'must be a remote image in Cloudflare Registry, Docker Hub, ECR, or Artifact Registry',
      ),
    instanceType: z
      .union([
        z.enum(['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4', 'dev', 'standard']),
        z.object({ vcpu: z.number().finite().positive(), memory_mib: z.number().int().positive().safe(),
          disk_mb: z.number().int().positive().safe() }).strict(),
      ])
      .default('lite'),
    maxInstances: z.number().int().positive().safe().default(20),
    constraints: z
      .object({
        regions: z
          .array(z.enum(['ENAM', 'WNAM', 'EEUR', 'WEUR', 'APAC', 'SAM', 'ME', 'OC', 'AFR']))
          .min(1)

          .optional(),
        jurisdiction: z.enum(['eu', 'fedramp']).optional(),
      })
      .strict()
      .optional(),
    rolloutActiveGracePeriod: z.number().int().min(0).max(86_400).default(0),
  })
  .strict();

const containersSchema = z
  .array(workerContainerSchema)
  .superRefine((containers, context) => {
    const names = new Set<string>();
    const classes = new Set<string>();
    containers.forEach((container, index) => {
      if (names.has(container.name)) context.addIssue({ code: 'custom', path: [index, 'name'], message: 'must be unique' });
      if (classes.has(container.className)) context.addIssue({ code: 'custom', path: [index, 'className'], message: 'must be unique' });
      names.add(container.name);
      classes.add(container.className);
    });
  });

export const workerProjectConfigSchema = z
  .object({
    $schema: z.literal(WORKER_PROJECT_SCHEMA_URL).optional(),
    version: z.literal(1),
    workerId: z.string().uuid().optional(),
    worker: z
      .object({
        name: z.string().min(2).max(80),
        slug: z
          .string()
          .regex(
            /^[a-z][a-z0-9-]{1,47}[a-z0-9]$/,
            "must be 3-49 lowercase characters and may contain digits or hyphens",
          ),
        description: z.string().max(500).optional(),
        template: z.enum(["worker", "agent"]).default("worker"),
      })
      .strict(),
    wrangler: relativeProjectPath,
    build: z
      .object({
        command: z.string().min(1),
        output: relativeProjectPath,
        main: relativeProjectPath.optional(),
      })
      .strict(),
    assets: staticAssetsSchema.optional(),
    containers: containersSchema.optional(),
    environments: z
      .object({
        preview: environmentSchema,
        production: environmentSchema,
      })
      .strict(),
  })
  .strict();

export type WorkerProjectConfig = z.infer<typeof workerProjectConfigSchema>;

export function workerEnvironmentContainers(config: WorkerProjectConfig, environment: 'preview' | 'production') {
  return config.environments[environment].containers ?? config.containers ??
    (config.environments.preview.containers !== undefined || config.environments.production.containers !== undefined ? [] : undefined);
}

export function assertWorkerContainerBindings(config: WorkerProjectConfig): void {
  for (const environment of ['preview', 'production'] as const) {
    for (const container of workerEnvironmentContainers(config, environment) || []) {
      const matching = config.environments[environment].resources.filter(
        (resource) =>
          resource.type === 'durable_object' &&
          resource.className === container.className,
      );
      if (matching.length !== 1) {
        throw new WorkerProjectConfigError(
          'worker_container_durable_object_missing',
          `Container ${container.name} className ${container.className} must match exactly one durable_object class in ${environment}`,
        );
      }
    }
  }
}

export interface LoadedWorkerProject {
  configPath: string;
  rootDir: string;
  config: WorkerProjectConfig;
}

export class WorkerProjectConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerProjectConfigError";
  }
}

function sensitiveConfigPath(
  value: unknown,
  path: string[] = [],
): string | null {
  if (typeof value === "string") {
    // xapi- is a public project/path prefix, not a credential prefix.
    // Keep scanning commands for real embedded keys rather than exempting them.
    return /\b(?:cfat[-_]|sk[-_]|xapi_)[A-Za-z0-9_+/=-]{12,}\b/i.test(value)
      ? path.join(".") || "<root>"
      : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = sensitiveConfigPath(value[index], [...path, String(index)]);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const declaredSecretNames =
      key === "secrets" &&
      path.length === 2 &&
      path[0] === "environments" &&
      (path[1] === "preview" || path[1] === "production") &&
      Array.isArray(nested);
    if (
      !declaredSecretNames &&
      /(?:secret|token|password|api[_-]?key|private[_-]?key)/i.test(key)
    ) {
      return [...path, key].join(".");
    }
    const match = sensitiveConfigPath(nested, [...path, key]);
    if (match) return match;
  }
  return null;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "<root>";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

export function findWorkerProjectConfig(
  startDir = process.cwd(),
  explicitPath?: string,
): string {
  if (explicitPath) {
    const candidate = resolve(startDir, explicitPath);
    const configPath =
      existsSync(candidate) && statSync(candidate).isDirectory()
        ? join(candidate, WORKER_PROJECT_CONFIG_FILE)
        : candidate;
    if (!existsSync(configPath)) {
      throw new WorkerProjectConfigError(
        "worker_project_config_not_found",
        `Worker project config not found: ${configPath}`,
      );
    }
    return realpathSync(configPath);
  }

  let current = realpathSync(resolve(startDir));
  while (true) {
    const candidate = join(current, WORKER_PROJECT_CONFIG_FILE);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  throw new WorkerProjectConfigError(
    "worker_project_config_not_found",
    `No ${WORKER_PROJECT_CONFIG_FILE} found from ${resolve(startDir)} upward`,
  );
}

export function loadWorkerProject(
  startDir = process.cwd(),
  explicitPath?: string,
): LoadedWorkerProject {
  const configPath = findWorkerProjectConfig(startDir, explicitPath);
  const text = readFileSync(configPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new WorkerProjectConfigError(
      "worker_project_config_too_large",
      `Worker project config must be at most ${MAX_CONFIG_BYTES} bytes`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WorkerProjectConfigError(
      "worker_project_config_invalid_json",
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sensitive = sensitiveConfigPath(raw);
  if (sensitive) {
    throw new WorkerProjectConfigError(
      "worker_project_config_contains_secret",
      `Worker project config must not contain credentials or Secret values (field: ${sensitive})`,
    );
  }
  const parsed = workerProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkerProjectConfigError(
      "worker_project_config_invalid",
      `Invalid Worker project config: ${validationMessage(parsed.error)}`,
    );
  }
  assertWorkerContainerBindings(parsed.data);
  return { configPath, rootDir: dirname(configPath), config: parsed.data };
}

export function resolveWorkerProjectPath(
  project: LoadedWorkerProject,
  value: string,
  field: string,
): string {
  const target = resolve(project.rootDir, value);
  const traversal = relative(project.rootDir, target);
  if (
    traversal === ".." ||
    traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(traversal)
  ) {
    throw new WorkerProjectConfigError(
      "worker_project_path_outside_root",
      `${field} must resolve inside the Worker project`,
    );
  }
  return target;
}
