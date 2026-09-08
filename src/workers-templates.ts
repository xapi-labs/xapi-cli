import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "fs";
import { fileURLToPath } from "url";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { z } from "zod";
import {
  WorkerProjectConfigError,
  workerManagedResourceSchema,
} from "./workers-project.ts";

const TEMPLATE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const TEMPLATE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const MAX_TEMPLATE_FILE_BYTES = 512 * 1024;
const MAX_TEMPLATE_FILES = 100;
const MAX_MANIFEST_BYTES = 128 * 1024;
const RESERVED_TARGETS = new Set([
  ".gitignore",
  "README.md",
  "package.json",
  "tsconfig.json",
  "wrangler.jsonc",
  "xapi.worker.json",
]);
const RESERVED_SCRIPTS = new Set(["build", "dev", "typecheck"]);

const portablePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((part) => part === "" || part === ".."),
    "must be a portable relative path without '..'",
  );

const templateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(TEMPLATE_ID),
    version: z.string().regex(TEMPLATE_VERSION),
    name: z.string().min(2).max(80),
    description: z.string().min(10).max(500),
    productTemplate: z.enum(["worker", "agent"]),
    defaultResources: z.array(workerManagedResourceSchema).max(100).default([]),
    defaultSecrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
      .max(100)
      .default([]),
    packageScripts: z.record(z.string(), z.string().min(1).max(1000)).default({}),
    files: z
      .array(
        z
          .object({
            source: portablePath,
            target: portablePath,
            render: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TEMPLATE_FILES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const bindings = new Set<string>();
    manifest.defaultResources.forEach((resource, index) => {
      if (bindings.has(resource.bindingName)) {
        context.addIssue({
          code: "custom",
          path: ["defaultResources", index, "bindingName"],
          message: `duplicates binding ${resource.bindingName}`,
        });
      }
      bindings.add(resource.bindingName);
    });
    const targets = new Set<string>();
    manifest.files.forEach((file, index) => {
      if (RESERVED_TARGETS.has(file.target)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "target"],
          message: `may not replace CLI-managed file ${file.target}`,
        });
      }
      if (targets.has(file.target)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "target"],
          message: `duplicates target ${file.target}`,
        });
      }
      targets.add(file.target);
    });
    for (const script of Object.keys(manifest.packageScripts)) {
      if (RESERVED_SCRIPTS.has(script)) {
        context.addIssue({
          code: "custom",
          path: ["packageScripts", script],
          message: `may not replace the ${script} script`,
        });
      }
    }
    for (const secret of manifest.defaultSecrets) {
      if (bindings.has(secret)) {
        context.addIssue({
          code: "custom",
          path: ["defaultSecrets"],
          message: `binding ${secret} is already declared as a managed resource`,
        });
      }
    }
  });

export type WorkerTemplateManifest = z.infer<typeof templateManifestSchema>;

export interface WorkerTemplate extends WorkerTemplateManifest {
  rootDir: string;
}

export interface WorkerTemplateRenderValues {
  PROJECT_NAME: string;
  PROJECT_SLUG: string;
  COMPATIBILITY_DATE: string;
  PREVIEW_DAILY_BUDGET_USD: string;
  PRODUCTION_DAILY_BUDGET_USD: string;
}

export interface WorkerTemplateSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  productTemplate: "worker" | "agent";
  resources: string[];
  secrets: string[];
}

export const WORKER_TEMPLATES_ROOT = resolve(
  fileURLToPath(new URL("../templates", import.meta.url)),
);

function configError(code: string, message: string): never {
  throw new WorkerProjectConfigError(code, message);
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`,
    )
    .join("; ");
}

function assertInside(root: string, candidate: string, label: string): void {
  const traversal = relative(root, candidate);
  if (
    traversal === ".." ||
    traversal.startsWith(`..${sep}`) ||
    isAbsolute(traversal)
  ) {
    configError(
      "worker_template_path_escape",
      `${label} must stay inside the template package`,
    );
  }
}

function assertNoSymlink(root: string, candidate: string, label: string): void {
  assertInside(root, candidate, label);
  let cursor = root;
  for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      configError(
        "worker_template_symlink",
        `${label} must not cross a symbolic link: ${cursor}`,
      );
    }
  }
}

export function listWorkerTemplates(): WorkerTemplateSummary[] {
  if (!existsSync(WORKER_TEMPLATES_ROOT)) {
    configError(
      "worker_templates_not_packaged",
      `Worker templates were not packaged with the CLI: ${WORKER_TEMPLATES_ROOT}`,
    );
  }
  return readdirSync(WORKER_TEMPLATES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TEMPLATE_ID.test(entry.name))
    .map((entry) => loadWorkerTemplate(entry.name))
    .map((template) => ({
      id: template.id,
      version: template.version,
      name: template.name,
      description: template.description,
      productTemplate: template.productTemplate,
      resources: template.defaultResources.map(
        (resource) => `${resource.type}:${resource.bindingName}`,
      ),
      secrets: [...template.defaultSecrets],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadWorkerTemplate(id: string): WorkerTemplate {
  if (!TEMPLATE_ID.test(id)) {
    configError(
      "worker_template_invalid_id",
      "Worker template id must contain lowercase letters, digits, or hyphens",
    );
  }
  const rootDir = resolve(WORKER_TEMPLATES_ROOT, id);
  assertNoSymlink(WORKER_TEMPLATES_ROOT, rootDir, `Worker template ${id}`);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    const available = listWorkerTemplates().map((template) => template.id);
    configError(
      "worker_template_not_found",
      `Unknown Worker template '${id}'. Available templates: ${available.join(", ")}`,
    );
  }
  const manifestPath = join(rootDir, "template.json");
  assertNoSymlink(rootDir, manifestPath, `Worker template ${id} manifest`);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    configError(
      "worker_template_manifest_missing",
      `Worker template '${id}' is missing template.json`,
    );
  }
  if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
    configError(
      "worker_template_manifest_too_large",
      `Worker template '${id}' manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    configError(
      "worker_template_manifest_invalid_json",
      `Worker template '${id}' has invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = templateManifestSchema.safeParse(raw);
  if (!parsed.success) {
    configError(
      "worker_template_manifest_invalid",
      `Worker template '${id}' is invalid: ${validationMessage(parsed.error)}`,
    );
  }
  if (parsed.data.id !== id) {
    configError(
      "worker_template_id_mismatch",
      `Worker template directory '${id}' declares id '${parsed.data.id}'`,
    );
  }
  for (const file of parsed.data.files) {
    const source = resolve(rootDir, "files", file.source);
    assertNoSymlink(rootDir, source, `Worker template file ${file.source}`);
    if (!existsSync(source) || !statSync(source).isFile()) {
      configError(
        "worker_template_file_missing",
        `Worker template '${id}' is missing files/${file.source}`,
      );
    }
    if (statSync(source).size > MAX_TEMPLATE_FILE_BYTES) {
      configError(
        "worker_template_file_too_large",
        `Worker template file exceeds ${MAX_TEMPLATE_FILE_BYTES} bytes: ${file.source}`,
      );
    }
    assertInside(realpathSync(rootDir), realpathSync(source), file.source);
  }
  return { ...parsed.data, rootDir };
}

export function renderWorkerTemplateFiles(
  template: WorkerTemplate,
  values: WorkerTemplateRenderValues,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of template.files) {
    const sourcePath = resolve(template.rootDir, "files", file.source);
    const buffer = readFileSync(sourcePath);
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) {
      configError(
        "worker_template_file_not_utf8",
        `Worker template files must be UTF-8 text: ${file.source}`,
      );
    }
    if (!file.render) {
      result[file.target] = content;
      continue;
    }
    const placeholders = [...content.matchAll(PLACEHOLDER)].map(
      (match) => match[1],
    );
    for (const placeholder of placeholders) {
      if (!Object.hasOwn(values, placeholder)) {
        configError(
          "worker_template_unknown_placeholder",
          `Worker template '${template.id}' uses unknown placeholder {{${placeholder}}}`,
        );
      }
    }
    const rendered = content.replace(
      PLACEHOLDER,
      (_match, key: keyof WorkerTemplateRenderValues) => values[key],
    );
    if (/\{\{[^{}]+\}\}/.test(rendered)) {
      configError(
        "worker_template_unresolved_placeholder",
        `Worker template '${template.id}' contains an unsupported placeholder in ${file.source}`,
      );
    }
    result[file.target] = rendered;
  }
  return result;
}
