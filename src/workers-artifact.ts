import { normalizeWorkerNativeMetadata } from './workers-native-metadata.ts';
import { WORKER_CLASS_IDENTIFIER, isWorkerBindingName } from './workers-binding-validation.ts';
import busboy from "busboy";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { parse } from "acorn";

const MAX_LEGACY_ARTIFACT_BYTES = 1024 * 1024;
const MAX_BUNDLE_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_METADATA_BYTES = 10 * 1024 * 1024;
const MAX_NATIVE_MULTIPART_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_FILES = 100_000;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
// Complete projects use one multipart binary request and content-addressed
// server storage. This is an xAPI project quota, not Cloudflare's account cap.
const MAX_XAPI_ARTIFACT_CONTENT_BYTES = 100 * 1024 * 1024;

export const MAX_WORKER_MODULE_BYTES = MAX_BUNDLE_CONTENT_BYTES;
export const MAX_WORKER_ARTIFACT_BYTES = MAX_XAPI_ARTIFACT_CONTENT_BYTES;
export const MAX_WORKER_JSON_BYTES = 18 * 1024 * 1024;
const MAX_BUNDLE_MODULES = 110_000;
const SAFE_MODULE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+~/-]{1,240}$/;

type UnknownRecord = Record<string, unknown>;

export type WorkerModuleContentType =
  | "application/javascript+module"
  | "application/source-map"
  | "application/wasm"
  | "text/plain"
  | "application/octet-stream";

export interface WorkerArtifactBundleModule {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  contentType: WorkerModuleContentType;
}

export interface WorkerArtifactAsset {
  path: string;
  content: string;
  encoding: "base64";
  contentType: string;
}

export interface WorkerArtifactAssets {
  files: WorkerArtifactAsset[];
  binding?: string;
  config?: {
    htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    runWorkerFirst?: boolean | string[];
  };
}

export interface WorkerStaticAssetsInput {
  directory: string;
  binding?: string;
  htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  runWorkerFirst?: boolean | string[];
}

export type WorkerCacheOptions = {
  [key: string]: unknown;
  enabled?: boolean;
  cross_version_cache?: boolean;
};
export type WorkerVersionMetadata = { binding: string };

export type WorkerVariableType = "plain_text" | "json";
export interface WorkerVariableOptions {
  vars?: Record<string, unknown>;
  keepBindings?: WorkerVariableType[];
  varTypes?: Record<string, WorkerVariableType>;
}

/** Canonical public variable intent; defaults stay absent for stable legacy hashes. */
export function normalizeWorkerVariableOptions(input: {
  vars?: unknown;
  keepBindings?: unknown;
  varTypes?: unknown;
}): WorkerVariableOptions {
  const vars = normalizeWorkerVars(input.vars);
  const result: WorkerVariableOptions = vars ? { vars } : {};
  if (input.keepBindings !== undefined) {
    if (!Array.isArray(input.keepBindings) || input.keepBindings.some(
      (type) => type !== "plain_text" && type !== "json",
    )) {
      throw new WorkerArtifactError("Worker keepBindings must contain only plain_text or json");
    }
    const keepBindings = (["plain_text", "json"] as const).filter(
      (type) => (input.keepBindings as unknown[]).includes(type),
    );
    if (keepBindings.length) result.keepBindings = keepBindings;
  }
  if (input.varTypes !== undefined) {
    if (!input.varTypes || typeof input.varTypes !== "object" || Array.isArray(input.varTypes)) {
      throw new WorkerArtifactError("Worker varTypes must be an object");
    }
    const exceptions: Array<[string, WorkerVariableType]> = [];
    for (const [name, type] of Object.entries(input.varTypes).sort(([a], [b]) => a.localeCompare(b))) {
      if (!vars || !Object.hasOwn(vars, name)) {
        throw new WorkerArtifactError(`Worker varTypes key must exist in vars: ${name}`);
      }
      if (type !== "plain_text" && type !== "json") {
        throw new WorkerArtifactError(`Invalid Worker varTypes variable type: ${name}`);
      }
      if (type === "plain_text" && typeof vars[name] !== "string") {
        throw new WorkerArtifactError(`Worker plain_text variable must be a string: ${name}`);
      }
      if (type === "json" && typeof vars[name] === "string") exceptions.push([name, type]);
    }
    if (exceptions.length) result.varTypes = Object.fromEntries(exceptions);
  }
  return result;
}

function normalizeNativeKeepBindings(value: unknown): WorkerVariableType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(type =>
    !["plain_text", "json", "secret_text", "secret_key"].includes(type),
  )) {
    throw new WorkerArtifactError("Native keep_bindings needs explicit target mapping; only public variable retention is supported");
  }
  // xAPI Secrets are managed independently from artifact public variables.
  return normalizeWorkerVariableOptions({
    keepBindings: value.filter(type => type === "plain_text" || type === "json"),
  }).keepBindings;
}

export function normalizeNativeWorkerOptions(input: {
  cacheOptions?: unknown;
  versionMetadata?: unknown;
}): {
  cacheOptions?: WorkerCacheOptions;
  versionMetadata?: WorkerVersionMetadata;
} {
  const result: {
    cacheOptions?: WorkerCacheOptions;
    versionMetadata?: WorkerVersionMetadata;
  } = {};
  if (input.cacheOptions !== undefined) {
    const value = input.cacheOptions as WorkerCacheOptions;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
      (value.cross_version_cache !== undefined &&
        typeof value.cross_version_cache !== "boolean")
    ) {
      throw new WorkerArtifactError("Invalid Worker cache options");
    }
    const ordinaryCache = normalizeWorkerNativeMetadata({ cache_options: value })!.cache_options as WorkerCacheOptions;
    result.cacheOptions = {
      ...Object.fromEntries(Object.entries(ordinaryCache).filter(([key]) => !['enabled', 'cross_version_cache'].includes(key)).sort(([a], [b]) => a.localeCompare(b))),
      ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
      ...(value.cross_version_cache !== undefined
        ? { cross_version_cache: value.cross_version_cache }
        : {}),
    };
  }
  if (input.versionMetadata !== undefined) {
    const value = input.versionMetadata as WorkerVersionMetadata;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.binding !== "string" ||
      !isWorkerBindingName(value.binding) ||
      value.binding === "XAPI_AI_BASE_URL" ||
      Object.keys(value).some((key) => key !== "binding")
    ) {
      throw new WorkerArtifactError("Invalid Worker version metadata binding");
    }
    result.versionMetadata = { binding: value.binding };
  }
  return result;
}

export interface WorkerObservability {
  [key: string]: unknown;
  enabled?: boolean;
  head_sampling_rate?: number;
  logs?: {
    [key: string]: unknown;
    enabled?: boolean;
    head_sampling_rate?: number;
    invocation_logs?: boolean;
    persist?: boolean;
  };
  traces?: {
    [key: string]: unknown;
    enabled?: boolean;
    head_sampling_rate?: number;
    persist?: boolean;
  };
}

/** Only script-local telemetry settings; account destinations need tenant mapping. */
export function normalizeWorkerObservability(
  value: unknown,
): WorkerObservability | undefined {
  if (value === undefined) return undefined;
  function normalize(
    input: unknown,
    path: string,
    keys: string[],
  ): UnknownRecord {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new WorkerArtifactError(`${path} must be an object`);
    }
    const record = input as UnknownRecord;
    if (path === 'observability.traces' && record.invocation_logs !== undefined)
      throw new WorkerArtifactError('observability.traces.invocation_logs is a logs-only setting');
    if (record.destinations !== undefined && (!Array.isArray(record.destinations) || record.destinations.length))
      throw new WorkerArtifactError(`${path}.destinations require owned destination mapping`);
    const output: UnknownRecord = {};
    for (const key of keys) {
      if (record[key] === undefined) continue;
      const item = record[key];
      if (key === "logs" || key === "traces") {
        output[key] = normalize(item, `${path}.${key}`, [
          "enabled",
          "head_sampling_rate",
          ...(key === "logs" ? ["invocation_logs"] : []),
          "persist",
        ]);
      } else if (key === "head_sampling_rate") {
        if (
          typeof item !== "number" ||
          !Number.isFinite(item) ||
          item < 0 ||
          item > 1
        ) {
          throw new WorkerArtifactError(`${path}.${key} must be a number between 0 and 1`);
        }
        output[key] = item;
      } else {
        if (typeof item !== "boolean") {
          throw new WorkerArtifactError(`${path}.${key} must be a boolean`);
        }
        output[key] = item;
      }
    }
    for (const key of Object.keys(record).filter(key => !keys.includes(key)).sort()) output[key] = record[key];
    return output;
  }
  const result = normalize(value, "observability", ["enabled", "head_sampling_rate", "logs", "traces"]);
  normalizeWorkerNativeMetadata({ observability: result });
  return result as WorkerObservability;
}

export interface WorkerArtifactBundle extends WorkerVariableOptions {
  version: 1;
  mainModule: string;
  modules: WorkerArtifactBundleModule[];
  cacheOptions?: WorkerCacheOptions;
  versionMetadata?: WorkerVersionMetadata;
  observability?: WorkerObservability;
  assets?: WorkerArtifactAssets;
  containers?: WorkerContainerInput[];
  vars?: Record<string, unknown>;
  queueBindingAliases?: Record<string, string>;
  nativeMetadata?: Record<string, unknown>;
}

export interface WorkerPublicVariables {
  vars: Record<string, unknown>;
  varTypes?: Record<string, 'plain_text' | 'json'>;
}

/** Same public-variable identity rules as the existing backend bundle format. */
export function normalizeWorkerPublicVariables(value: unknown, varTypes?: unknown): WorkerPublicVariables {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerArtifactError('Worker vars must be a JSON object');
  const normalized = normalizeWorkerVariableOptions({ vars: value, varTypes });
  return { vars: normalized.vars || {}, ...(normalized.varTypes ? { varTypes: normalized.varTypes } : {}) };
}

export function attachWorkerPublicVariables(artifact: LoadedWorkerArtifact, variables?: WorkerPublicVariables): LoadedWorkerArtifact {
  if (variables === undefined) return artifact;
  let normalized = normalizeWorkerPublicVariables(variables.vars, variables.varTypes);
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',content:artifact.upload.moduleCode,encoding:'utf8',contentType:'application/javascript+module'}]
  };
  if (artifact.nativeMetadata) {
    const nativeVars = normalizeWorkerPublicVariables(base.vars || {}, base.varTypes);
    if (JSON.stringify(nativeVars.vars) !== JSON.stringify(normalized.vars) ||
        (variables.varTypes !== undefined && JSON.stringify(nativeVars.varTypes) !== JSON.stringify(normalized.varTypes)))
      throw new WorkerArtifactError('Native bundle public variables differ from the selected Wrangler environment; rebuild before publishing');
    normalized = nativeVars;
  }
  const {vars: _oldVars, varTypes: _oldTypes, ...rest} = base;
  const bundle: WorkerArtifactBundle = {...rest,
    ...(Object.keys(normalized.vars).length ? normalized : {})};
  if (!('bundle' in artifact.upload) && !Object.keys(normalized.vars).length) return artifact;
  const bytes = storedBundleBytes(bundle);
  return {...artifact,kind:'bundle',contentSha256:sha256(bytes),sizeBytes:bytes.length,upload:{bundle}};
}

/** Known fields retain the main Artifact contract; only additional options use opaque metadata. */
function nativeArtifactOptions(metadata: Record<string, unknown>) {
  const { cache_options, version_metadata, keep_bindings, observability, ...ordinary } = metadata;
  const mapped = {
    ...normalizeNativeWorkerOptions({ cacheOptions: cache_options, versionMetadata: version_metadata }),
    ...normalizeWorkerVariableOptions({ keepBindings: normalizeNativeKeepBindings(keep_bindings) }),
    ...(observability !== undefined ? { observability: normalizeWorkerObservability(observability) } : {}),
  };
  // Validate the full input as lossless JSON even for recognized optional keys.
  normalizeWorkerNativeMetadata(metadata);
  return { ordinary: normalizeWorkerNativeMetadata(ordinary)!, mapped };
}

/** Preserve authoritative native output and attach ordinary environment options. */
export function attachWorkerNativeMetadata(artifact: LoadedWorkerArtifact, metadata?: Record<string, unknown>): LoadedWorkerArtifact {
  if (metadata === undefined) return artifact;
  const configured = nativeArtifactOptions(metadata);
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',content:artifact.upload.moduleCode,encoding:'utf8',contentType:'application/javascript+module'}]
  };
  if (artifact.nativeMetadata) {
    // Known configuration may not silently repair stale or missing emitted options.
    const actual = {
      ...normalizeNativeWorkerOptions(base),
      ...normalizeWorkerVariableOptions({ keepBindings: base.keepBindings }),
      ...(base.observability !== undefined ? { observability: normalizeWorkerObservability(base.observability) } : {}),
    };
    for (const key of ['cacheOptions', 'versionMetadata', 'keepBindings', 'observability'] as const) {
      const source = { cacheOptions: 'cache_options', versionMetadata: 'version_metadata', keepBindings: 'keep_bindings', observability: 'observability' }[key];
      // Native built-in version metadata is emitted as a binding.
      const emittedValue = key === 'versionMetadata' ? base.versionMetadata : actual[key];
      if (Object.hasOwn(metadata, source) && JSON.stringify(emittedValue) !== JSON.stringify(configured.mapped[key]))
        throw new WorkerArtifactError('Wrangler bundle ' + source + ' differs from selected configuration; rebuild before publishing');
    }
    for (const [key, value] of Object.entries(configured.ordinary)) {
      if (JSON.stringify(base.nativeMetadata?.[key]) !== JSON.stringify(value))
        throw new WorkerArtifactError('Wrangler bundle native metadata ' + key + ' differs from selected configuration; rebuild before publishing');
    }
    // A selected environment can explicitly clear ordinary deployment options.
    // Keep the emitted modules and native bindings authoritative; only remove
    // the ordinary metadata when the caller supplies this empty intent.
    if (Object.keys(metadata).length || base.nativeMetadata === undefined) return artifact;
  }
  const { nativeMetadata: _previous, ...rest } = base;
  const ordinary = configured.ordinary;
  const ordinaryIntent = Object.keys(ordinary).length || base.nativeMetadata !== undefined;
  const bundle: WorkerArtifactBundle = {
    ...rest,
    ...configured.mapped,
    ...(ordinaryIntent ? { nativeMetadata: ordinary } : {}),
  };
  // An explicit empty known option removes its previous mapping.
  if (Object.hasOwn(metadata, 'keep_bindings') && !configured.mapped.keepBindings) delete bundle.keepBindings;
  if (!('bundle' in artifact.upload) && !Object.keys(configured.mapped).length && !ordinaryIntent) return artifact;
  const bytes = storedBundleBytes(bundle);
  return {...artifact,kind:'bundle',contentSha256:sha256(bytes),sizeBytes:bytes.length,upload:{bundle}};
}

export type WorkerArtifactObservability = WorkerObservability;

export function attachWorkerObservability(artifact: LoadedWorkerArtifact, value: WorkerArtifactObservability | undefined, queueBindingAliases?: Record<string, string>): LoadedWorkerArtifact {
  value = normalizeWorkerObservability(value);
  if (value === undefined && !Object.keys(queueBindingAliases || {}).length) return artifact;
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version: 1, mainModule: 'index.mjs', modules: [{ path: 'index.mjs', content: artifact.upload.moduleCode, encoding: 'utf8', contentType: 'application/javascript+module' }],
  };
  if (value !== undefined && artifact.nativeMetadata && JSON.stringify(normalizeWorkerObservability(artifact.nativeMetadata.observability)) !== JSON.stringify(value)) throw new WorkerArtifactError('Native bundle observability differs from Wrangler settings; rebuild before publishing');
  const bundle = { ...base, ...(queueBindingAliases && Object.keys(queueBindingAliases).length ? {queueBindingAliases: Object.fromEntries(Object.entries(queueBindingAliases).sort(([a],[b]) => a.localeCompare(b)))} : {}), ...(value !== undefined ? {observability: value} : {}) };
  const bytes = storedBundleBytes(bundle);
  return { ...artifact, kind: 'bundle', contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };
}

export interface WorkerContainerInput {
  name: string;
  className: string;
  image: string;
  instanceType: 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4' | 'dev' | 'standard' |
    { vcpu: number; memory_mib: number; disk_mb: number };
  maxInstances: number;
  constraints?: { regions?: string[]; jurisdiction?: 'eu' | 'fedramp' };
  rolloutActiveGracePeriod: number;
}

export type WorkerArtifactUploadInput =
  | { moduleCode: string }
  | { bundle: WorkerArtifactBundle };

export type WorkerArtifactUploadRequest = WorkerArtifactUploadInput & {
  idempotencyKey: string;
};

export interface LoadedWorkerArtifact {
  kind: "module" | "bundle";
  contentSha256: string;
  sizeBytes: number;
  upload: WorkerArtifactUploadInput;
  nativeMetadata?: UnknownRecord;
}

export class WorkerArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerArtifactError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function walkSyntax(node: unknown, visit: (item: UnknownRecord) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkSyntax(item, visit);
    return;
  }
  const item = node as UnknownRecord;
  if (typeof item.type === "string") visit(item);
  for (const [key, child] of Object.entries(item)) {
    if (key !== "start" && key !== "end" && key !== "loc") {
      walkSyntax(child, visit);
    }
  }
}

function literalSource(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = (node as UnknownRecord).value;
  return typeof value === "string" && value ? value : undefined;
}

function validateJavaScript(
  modulePath: string,
  source: string,
  bundledPaths?: ReadonlySet<string>,
  requireDefaultExport = false,
): void {
  let ast: unknown;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
  } catch (error) {
    throw new WorkerArtifactError(
      `Worker module is not valid JavaScript ESM (${modulePath}): ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }

  let defaultExport = false;
  const imports: string[] = [];
  walkSyntax(ast, (node) => {
    if (node.type === "ExportDefaultDeclaration") defaultExport = true;
    if (node.type === "ExportNamedDeclaration" && Array.isArray(node.specifiers)) {
      defaultExport ||= node.specifiers.some((specifier) => {
        if (!specifier || typeof specifier !== "object") return false;
        const exported = (specifier as UnknownRecord).exported;
        return (
          !!exported &&
          typeof exported === "object" &&
          ((exported as UnknownRecord).name === "default" ||
            (exported as UnknownRecord).value === "default")
        );
      });
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      const sourceValue = literalSource(node.source);
      if (sourceValue) imports.push(sourceValue);
    }
    if (node.type === "ImportExpression") {
      imports.push(literalSource(node.source) || "<dynamic expression>");
    }
  });

  if (requireDefaultExport && !defaultExport) {
    throw new WorkerArtifactError(
      `Worker entrypoint must export a default Cloudflare Worker handler: ${modulePath}`,
    );
  }

  const unresolved = imports.filter((specifier) => {
    if (/^(?:cloudflare|node):/.test(specifier)) return false;
    if (!bundledPaths) return true;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return true;
    }
    const resolved = posix.normalize(
      posix.join(posix.dirname(modulePath), specifier),
    );
    return (
      resolved === ".." ||
      resolved.startsWith("../") ||
      !bundledPaths.has(resolved)
    );
  });
  if (unresolved.length) {
    throw new WorkerArtifactError(
      `Worker module has imports that are not in the Artifact (${modulePath}): ${[...new Set(unresolved)].sort().join(", ")}. Bundle package dependencies or include every relative module in the output directory.`,
    );
  }
}

function moduleContentType(path: string): WorkerModuleContentType | undefined {
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".js" || extension === ".mjs") {
    return "application/javascript+module";
  }
  if (extension === ".map") return "application/source-map";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".txt") return "text/plain";
  if (extension === ".bin") return "application/octet-stream";
  return undefined;
}

function assetContentType(path: string): string {
  const extension = posix.extname(path).toLowerCase();
  return ({
    ".avif": "image/avif", ".css": "text/css", ".csv": "text/csv",
    ".gif": "image/gif", ".html": "text/html", ".ico": "image/x-icon",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript",
    ".json": "application/json", ".map": "application/json", ".mjs": "text/javascript",
    ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml",
    ".txt": "text/plain", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
    ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
    ".xml": "application/xml", ".zip": "application/zip",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

function collectAssetFiles(input: WorkerStaticAssetsInput): WorkerArtifactAssets {
  const root = resolve(input.directory);
  if (!existsSync(root)) throw new WorkerArtifactError(`Static assets directory does not exist: ${root}`);
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    throw new WorkerArtifactError("Static assets path must be a directory and not a symbolic link");
  }
  const files: WorkerArtifactAsset[] = [];
  let assetBytes = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const relativePath = portableRelativePath(root, absolute);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new WorkerArtifactError(`Static assets must not contain symbolic links: ${relativePath}`);
      if (info.isDirectory()) { walk(absolute); continue; }
      if (!info.isFile()) throw new WorkerArtifactError(`Static assets contain an unsupported filesystem entry: ${relativePath}`);
      if (!relativePath || relativePath.includes("\\") || relativePath.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(relativePath)) {
        throw new WorkerArtifactError(`Static asset path is invalid: ${relativePath}`);
      }
      if (info.size > MAX_ASSET_FILE_BYTES) throw new WorkerArtifactError(`Static asset exceeds Cloudflare's 25 MiB per-file limit: ${relativePath}`);
      assetBytes += info.size;
      if (assetBytes > MAX_XAPI_ARTIFACT_CONTENT_BYTES) throw new WorkerArtifactError("Static assets exceed the xAPI project limit of 100 MiB");
      const bytes = readFileSync(absolute);
      files.push({ path: `/${relativePath}`, content: bytes.toString("base64"), encoding: "base64", contentType: assetContentType(relativePath) });
      if (files.length > MAX_ASSET_FILES) throw new WorkerArtifactError(`Static assets exceed xAPI's ${MAX_ASSET_FILES} file limit`);
    }
  };
  walk(root);
  if (!files.length) throw new WorkerArtifactError("Static assets directory is empty");
  const config = {
    ...(input.htmlHandling ? { htmlHandling: input.htmlHandling } : {}),
    ...(input.notFoundHandling ? { notFoundHandling: input.notFoundHandling } : {}),
    ...(input.runWorkerFirst !== undefined ? { runWorkerFirst: input.runWorkerFirst } : {}),
  };
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    ...(input.binding ? { binding: input.binding } : {}),
    ...(Object.keys(config).length ? { config } : {}),
  };
}

function assertArtifactContentLimit(bundle: WorkerArtifactBundle): void {
  const moduleBytes = bundle.modules.reduce(
    (total, module) =>
      total +
      (module.encoding === "base64"
        ? Buffer.from(module.content, "base64").length
        : Buffer.byteLength(module.content, "utf8")),
    0,
  );
  const assetBytes =
    bundle.assets?.files.reduce(
      (total, asset) => total + Buffer.from(asset.content, "base64").length,
      0,
    ) || 0;
  if (moduleBytes > MAX_BUNDLE_CONTENT_BYTES) {
    throw new WorkerArtifactError("Worker modules exceed Cloudflare’s 64 MiB uncompressed limit");
  }
  if (moduleBytes + assetBytes > MAX_XAPI_ARTIFACT_CONTENT_BYTES) {
    throw new WorkerArtifactError(
      "Worker modules and static assets exceed the xAPI project limit of 100 MiB",
    );
  }
  if (bundle.modules.length + (bundle.assets?.files.length || 0) > MAX_BUNDLE_MODULES) throw new WorkerArtifactError("Worker files exceed the backend multipart receiver capacity");
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function normalizeMainModule(value: string | undefined): string {
  if (!value) {
    throw new WorkerArtifactError(
      "build.main (or --main) is required when the Worker build output is a directory",
    );
  }
  if (value.includes("\\") || !SAFE_MODULE_PATH.test(value)) {
    throw new WorkerArtifactError(
      "Worker bundle main module must be a portable path inside the output directory",
    );
  }
  return posix.normalize(value);
}

function loadSingleModule(path: string): LoadedWorkerArtifact {
  const info = statSync(path);
  if (!info.isFile()) {
    throw new WorkerArtifactError("Worker build output is not a file or directory");
  }
  if (!info.size) throw new WorkerArtifactError("Worker build output is empty");
  if (info.size > MAX_BUNDLE_CONTENT_BYTES) {
    throw new WorkerArtifactError("Worker modules exceed Cloudflare’s 64 MiB uncompressed limit");
  }
  const bytes = readFileSync(path);
  const moduleCode = bytes.toString("utf8");
  if (!Buffer.from(moduleCode, "utf8").equals(bytes)) {
    throw new WorkerArtifactError(
      "Single-file Worker output must be valid UTF-8 JavaScript",
    );
  }
  validateJavaScript(portableRelativePath(resolve(path, ".."), path), moduleCode, undefined, true);
  if (info.size > MAX_LEGACY_ARTIFACT_BYTES) {
    const bundle: WorkerArtifactBundle = {
      version: 1,
      mainModule: posix.basename(path),
      modules: [{
        path: posix.basename(path),
        content: moduleCode,
        encoding: "utf8",
        contentType: "application/javascript+module",
      }],
    };
    const stored = storedBundleBytes(bundle);
    return {
      kind: "bundle",
      contentSha256: sha256(stored),
      sizeBytes: stored.length,
      upload: { bundle },
    };
  }
  return {
    kind: "module",
    contentSha256: sha256(bytes),
    sizeBytes: bytes.length,
    upload: { moduleCode },
  };
}

function loadSingleModuleWithAssets(path: string, staticAssets: WorkerStaticAssetsInput): LoadedWorkerArtifact {
  const legacy = loadSingleModule(path);
  const moduleCode = "moduleCode" in legacy.upload
    ? legacy.upload.moduleCode
    : legacy.upload.bundle.modules[0].content;
  const mainModule = posix.basename(path);
  const assets = collectAssetFiles(staticAssets);
  const bundle: WorkerArtifactBundle = {
    version: 1,
    mainModule,
    modules: [{
      path: mainModule,
      content: moduleCode,
      encoding: "utf8",
      contentType: "application/javascript+module",
    }],
    assets,
  };
  assertArtifactContentLimit(bundle);
  const storedBytes = Buffer.from(JSON.stringify({
    version: 1,
    mainModule,
    modules: [{
      path: mainModule,
      contentBase64: Buffer.from(moduleCode, "utf8").toString("base64"),
      contentType: "application/javascript+module",
    }],
    assets,
  }), "utf8");
  return { kind: "bundle", contentSha256: sha256(storedBytes), sizeBytes: storedBytes.length, upload: { bundle } };
}

function collectBundleFiles(root: string, uploadSourceMaps = false): Array<{
  path: string;
  bytes: Buffer;
  contentType: WorkerModuleContentType;
}> {
  const files: Array<{
    path: string;
    bytes: Buffer;
    contentType: WorkerModuleContentType;
  }> = [];
  let moduleBytes = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const relativePath = portableRelativePath(root, absolute);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw new WorkerArtifactError(
          `Worker output must not contain symbolic links: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!info.isFile()) {
        throw new WorkerArtifactError(
          `Worker output contains an unsupported filesystem entry: ${relativePath}`,
        );
      }
      if (!SAFE_MODULE_PATH.test(relativePath)) {
        throw new WorkerArtifactError(
          `Worker module path is invalid: ${relativePath}`,
        );
      }
      // Outdir maps are private upload attachments only when explicitly selected.
      if (posix.extname(relativePath).toLowerCase() === ".map" && !uploadSourceMaps) continue;
      const contentType = moduleContentType(relativePath);
      if (!contentType) {
        throw new WorkerArtifactError(
          `Worker output contains an unsupported module file: ${relativePath}. Code bundles support .js, .mjs, .wasm, .txt, .bin, and explicitly enabled .map attachments; publish website assets through the static-assets workflow.`,
        );
      }
      moduleBytes += info.size;
      if (moduleBytes > MAX_BUNDLE_CONTENT_BYTES) throw new WorkerArtifactError("Worker modules exceed Cloudflare’s 64 MiB uncompressed limit");
      files.push({ path: relativePath, bytes: readFileSync(absolute), contentType });
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function loadModuleBundle(root: string, main: string | undefined, staticAssets?: WorkerStaticAssetsInput, uploadSourceMaps = false): LoadedWorkerArtifact {
  const mainModule = normalizeMainModule(main);
  const files = collectBundleFiles(root, uploadSourceMaps);
  if (!files.length) throw new WorkerArtifactError("Worker output directory is empty");
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > MAX_BUNDLE_CONTENT_BYTES) {
    throw new WorkerArtifactError(
      `Worker bundle contents exceed the ${MAX_BUNDLE_CONTENT_BYTES} byte limit`,
    );
  }
  const paths = new Set(files.map((file) => file.path));
  const mainFile = files.find((file) => file.path === mainModule);
  if (!mainFile) {
    throw new WorkerArtifactError(
      `Worker bundle entrypoint does not exist in the output directory: ${mainModule}`,
    );
  }
  if (mainFile.contentType !== "application/javascript+module") {
    throw new WorkerArtifactError(
      `Worker bundle entrypoint must be a .js or .mjs module: ${mainModule}`,
    );
  }

  for (const file of files) {
    const textModule =
      file.contentType === "application/javascript+module" ||
      file.contentType === "text/plain";
    if (!textModule) continue;
    const source = file.bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(file.bytes)) {
      throw new WorkerArtifactError(
        `Text Worker module must be valid UTF-8: ${file.path}`,
      );
    }
    if (file.contentType === "application/javascript+module") {
      validateJavaScript(file.path, source, paths, file.path === mainModule);
    }
  }

  const assets = staticAssets ? collectAssetFiles(staticAssets) : undefined;
  const bundle: WorkerArtifactBundle = {
    version: 1,
    mainModule,
    modules: files.map((file) => {
      const utf8 =
        file.contentType === "application/javascript+module" ||
        file.contentType === "text/plain";
      return {
        path: file.path,
        content: utf8 ? file.bytes.toString("utf8") : file.bytes.toString("base64"),
        encoding: utf8 ? "utf8" : "base64",
        contentType: file.contentType,
      };
    }),
    ...(assets ? { assets } : {}),
  };
  assertArtifactContentLimit(bundle);
  const storedBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      mainModule,
      modules: files.map((file) => ({
        path: file.path,
        contentBase64: file.bytes.toString("base64"),
        contentType: file.contentType,
      })),
      ...(assets ? { assets } : {}),
    }),
    "utf8",
  );
  return {
    kind: "bundle",
    contentSha256: sha256(storedBytes),
    sizeBytes: storedBytes.length,
    upload: { bundle },
  };
}

export function loadWorkerArtifact(
  outputPath: string,
  mainModule?: string,
  staticAssets?: WorkerStaticAssetsInput,
  uploadSourceMaps = false,
): LoadedWorkerArtifact {
  if (!existsSync(outputPath)) {
    throw new WorkerArtifactError(`Worker build output does not exist: ${outputPath}`);
  }
  if (lstatSync(outputPath).isSymbolicLink()) {
    throw new WorkerArtifactError("Worker build output must not be a symbolic link");
  }
  const info = statSync(outputPath);
  if (info.isFile()) {
    if (mainModule) {
      throw new WorkerArtifactError(
        "build.main (or --main) is only valid when the Worker build output is a directory",
      );
    }
    const loaded = staticAssets
      ? loadSingleModuleWithAssets(outputPath, staticAssets)
      : loadSingleModule(outputPath);
    const mapPath = `${outputPath}.map`;
    if (!uploadSourceMaps || !existsSync(mapPath)) return loaded;
    const info = lstatSync(mapPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkerArtifactError("Source map must be a regular file");
    if (info.size > MAX_BUNDLE_CONTENT_BYTES) throw new WorkerArtifactError("Source map exceeds Worker module capacity");
    const bundle: WorkerArtifactBundle = "bundle" in loaded.upload ? loaded.upload.bundle : {
      version: 1, mainModule: posix.basename(outputPath), modules: [{
        path: posix.basename(outputPath), content: loaded.upload.moduleCode,
        encoding: "utf8", contentType: "application/javascript+module",
      }],
    };
    bundle.modules.push({ path: posix.basename(mapPath), content: readFileSync(mapPath).toString("base64"), encoding: "base64", contentType: "application/source-map" });
    assertArtifactContentLimit(bundle);
    const bytes = storedBundleBytes(bundle);
    return { kind: "bundle", contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };
  }
  if (info.isDirectory()) return loadModuleBundle(outputPath, mainModule, staticAssets, uploadSourceMaps);
  throw new WorkerArtifactError("Worker build output is not a file or directory");
}

/** Read Wrangler's --dry-run --outfile multipart artifact without rewriting code. */
export async function loadWorkerArtifactInput(
  outputPath: string,
  mainModule?: string,
  staticAssets?: WorkerStaticAssetsInput,
  containers?: WorkerContainerInput[],
  uploadSourceMaps?: boolean,
): Promise<LoadedWorkerArtifact> {
  if (!outputPath.endsWith(".bundle")) return attachContainers(loadWorkerArtifact(outputPath, mainModule, staticAssets, uploadSourceMaps), containers);
  if (mainModule) throw new WorkerArtifactError("Wrangler bundles contain their own main_module; omit --main/build.main");
  if (!existsSync(outputPath) || !lstatSync(outputPath).isFile() || lstatSync(outputPath).isSymbolicLink()) {
    throw new WorkerArtifactError("Wrangler bundle must be a regular file");
  }
  if (statSync(outputPath).size > MAX_NATIVE_MULTIPART_BYTES) throw new WorkerArtifactError("Wrangler bundle exceeds the current Artifact transport limit");
  const bytes = readFileSync(outputPath);
  const firstLine = bytes.subarray(0, bytes.indexOf("\r\n")).toString("ascii");
  if (!/^--[A-Za-z0-9_-]{1,70}$/.test(firstLine)) throw new WorkerArtifactError("Invalid Wrangler multipart boundary");
  type NativeFile = { name: string; type: string; arrayBuffer(): Promise<Uint8Array> };
  const entries = await new Promise<Array<[string, string | NativeFile]>>((resolve, reject) => {
    const result: Array<[string, string | NativeFile]> = [];
    const parser = busboy({ headers: {"content-type": `multipart/form-data; boundary=${firstLine.slice(2)}`}, preservePath: true,
      limits: { files: MAX_BUNDLE_MODULES + 1, fields: 1, parts: MAX_BUNDLE_MODULES + 2, fieldSize: MAX_NATIVE_METADATA_BYTES, fileSize: MAX_BUNDLE_CONTENT_BYTES + 1 } });
    parser.on("field", (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) reject(new WorkerArtifactError("Truncated native metadata"));
      result.push([name, value]);
    });
    parser.on("file", (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("limit", () => reject(new WorkerArtifactError("Native module exceeds Artifact capacity")));
      stream.on("error", reject);
      stream.on("end", () => result.push([name, {name: info.filename, type: info.mimeType, arrayBuffer: async () => Buffer.concat(chunks)}]));
    });
    for (const event of ["partsLimit", "filesLimit", "fieldsLimit"] as const) parser.on(event, () => reject(new WorkerArtifactError("Native multipart exceeds Artifact capacity")));
    parser.on("error", () => reject(new WorkerArtifactError("Malformed Wrangler multipart bundle")));
    parser.on("close", () => resolve(result));
    parser.end(bytes);
  });
  const metadataParts = entries.filter(([name]) => name === "metadata");
  if (metadataParts.length !== 1 || typeof metadataParts[0][1] !== "string") throw new WorkerArtifactError("Wrangler bundle requires one metadata part");
  let metadata: UnknownRecord;
  try { metadata = JSON.parse(metadataParts[0][1]); }
  catch { throw new WorkerArtifactError("Invalid Wrangler metadata JSON"); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new WorkerArtifactError("Invalid Wrangler metadata");
  // Resource identities and credentials are owned by xAPI's control plane.
  // Do not silently import a native binding that has no managed equivalent here.
  const {main_module: _main, bindings: _bindings, compatibility_date: _date,
    compatibility_flags: _flags, containers: _containers, cache_options: _cache,
    keep_bindings: _keep, observability: _observability, version_metadata: _version,
    ...ordinaryNativeOptions} = metadata;
  // Validate public retention before generic opaque validation for a precise mapping error.
  normalizeNativeKeepBindings(metadata.keep_bindings);
  const nativeConfiguration = normalizeWorkerNativeMetadata(ordinaryNativeOptions)!;
  const packageDependencies = metadata.package_dependencies;
  if (packageDependencies !== undefined && (
    !Array.isArray(packageDependencies) ||
    packageDependencies.length > 1000 ||
    packageDependencies.some((dependency: UnknownRecord) =>
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency) ||
      typeof dependency.name !== "string" ||
      dependency.name.length < 1 ||
      dependency.name.length > 500 ||
      typeof dependency.packageJsonVersion !== "string" ||
      dependency.packageJsonVersion.length > 500 ||
      typeof dependency.installedVersion !== "string" ||
      dependency.installedVersion.length > 500
    )
  )) throw new WorkerArtifactError("Invalid native package dependency metadata");
  if (Array.isArray(metadata.bindings)) {
    const names = metadata.bindings.map(binding => binding?.name);
    if (new Set(names).size !== names.length) throw new WorkerArtifactError('Duplicate native binding name');
  }
  if (Array.isArray(metadata.bindings) && metadata.bindings.some(binding =>
    binding && typeof binding === 'object' && ['workflow', 'durable_object_namespace'].includes(String(binding.type)) && binding.script_name !== undefined))
    throw new WorkerArtifactError('External Worker script_name binding metadata requires an existing owned Workflow or Durable Object mapping; importing a foreign class into this Worker is not supported');
  if (metadata.bindings !== undefined && (!Array.isArray(metadata.bindings) || metadata.bindings.some((binding: UnknownRecord) => {
    if (!binding || !isWorkerBindingName(binding.name)) return true;
    if (binding.type === "plain_text") {
      return typeof binding.text !== "string" || Object.keys(binding).some(key => !["name", "type", "text"].includes(key));
    }
    if (binding.type === "json") {
      return !("json" in binding) || Object.keys(binding).some(key => !["name", "type", "json"].includes(key));
    }
    if (binding.type === "version_metadata")
      return Object.keys(binding).some(
        (key) => !["name", "type"].includes(key),
      );
    if (binding.type === "queue")
      return (
        typeof binding.queue_name !== "string" ||
        Object.keys(binding).some(
          (key) => !["name", "type", "queue_name"].includes(key),
        )
      );
    if (["d1", "r2_bucket", "kv_namespace", "inherit"].includes(String(binding.type))) return false;
    if (binding.type === "workflow") {
      return (binding.class_name !== undefined && (typeof binding.class_name !== "string" ||
        !WORKER_CLASS_IDENTIFIER.test(binding.class_name))) ||
        typeof binding.workflow_name !== "string" || !binding.workflow_name ||
        Object.keys(binding).some(key => !["name", "type", "class_name", "workflow_name"].includes(key));
    }
    if (binding.type === "durable_object_namespace") {
      // Only a class in this script can map to the declared managed DO. An
      // external script/namespace needs its own ownership-aware API contract.
      return typeof binding.class_name !== "string" || !WORKER_CLASS_IDENTIFIER.test(binding.class_name) ||
        Object.keys(binding).some(key => !["name", "type", "class_name", "namespace_id"].includes(key));
    }
    return binding.type !== "assets" || !staticAssets?.binding || binding.name !== staticAssets.binding;
  }))) throw new WorkerArtifactError("Native binding metadata, including local class_name, needs explicit platform mapping; keep credentials in xAPI Secrets");
  const nativeBindings = (metadata.bindings || []) as UnknownRecord[];
  const bindingNames = nativeBindings.map(binding => binding.name);
  if (new Set(bindingNames).size !== bindingNames.length) throw new WorkerArtifactError("Duplicate native binding name");
  const versions = nativeBindings.filter(
    (binding) => binding.type === "version_metadata",
  );
  if (versions.length > 1)
    throw new WorkerArtifactError(
      "Only one version metadata binding is supported by Wrangler configuration",
    );
  const nativeOptions = normalizeNativeWorkerOptions({
    cacheOptions: metadata.cache_options,
    versionMetadata: metadata.version_metadata ?? (versions.length ? { binding: versions[0].name } : undefined),
  });
  if (versions.length && nativeOptions.versionMetadata?.binding !== versions[0].name)
    throw new WorkerArtifactError('Native version metadata declaration differs from its built-in binding');
  const variableBindings = nativeBindings.filter(
    binding => binding.type === "plain_text" || binding.type === "json",
  );
  const variableOptions = normalizeWorkerVariableOptions({
    vars: Object.fromEntries(variableBindings.map(binding => [
      String(binding.name), binding.type === "plain_text" ? binding.text : binding.json,
    ])),
    varTypes: Object.fromEntries(variableBindings.map(binding => [String(binding.name), binding.type])),
    keepBindings: normalizeNativeKeepBindings(metadata.keep_bindings),
  });
  if (metadata.compatibility_flags !== undefined && (!Array.isArray(metadata.compatibility_flags) || metadata.compatibility_flags.some(flag => typeof flag !== "string"))) throw new WorkerArtifactError("Invalid native compatibility flags");
  const observability = normalizeWorkerObservability(metadata.observability);
  const main = normalizeMainModule(typeof metadata.main_module === "string" ? metadata.main_module : undefined);
  const modules: WorkerArtifactBundleModule[] = [];
  const seen = new Set<string>();
  let moduleBytes = 0;
  const types = new Set<WorkerModuleContentType>(["application/javascript+module", "application/source-map", "application/wasm", "text/plain", "application/octet-stream"]);
  for (const [name, value] of entries) {
    if (name === "metadata") continue;
    if (typeof value === "string" || !SAFE_MODULE_PATH.test(name) || seen.has(name) || value.name !== name) throw new WorkerArtifactError(`Invalid or duplicate native module: ${name}`);
    seen.add(name);
    const contentType = value.type as WorkerModuleContentType;
    if (!types.has(contentType)) throw new WorkerArtifactError(`Native module type needs platform mapping: ${contentType}`);
    const content = Buffer.from(await value.arrayBuffer());
    moduleBytes += content.length;
    if (moduleBytes > MAX_BUNDLE_CONTENT_BYTES || seen.size > MAX_BUNDLE_MODULES) throw new WorkerArtifactError("Native modules exceed backend Artifact capacity");
    const utf8 = contentType === "application/javascript+module" || contentType === "text/plain";
    if (utf8 && !Buffer.from(content.toString("utf8"), "utf8").equals(content)) throw new WorkerArtifactError(`Invalid UTF-8 module: ${name}`);
    // Native module linkage (including computed imports) is validated by CF.
    if (contentType === "application/javascript+module") {
      try { parse(content.toString("utf8"), { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
      catch { throw new WorkerArtifactError(`Invalid JavaScript module: ${name}`); }
    }
    modules.push({ path: name, content: content.toString(utf8 ? "utf8" : "base64"), encoding: utf8 ? "utf8" : "base64", contentType });
  }
  if (!modules.some(module => module.path === main && module.contentType === "application/javascript+module")) throw new WorkerArtifactError("Native main_module is missing or not ESM");
  if (uploadSourceMaps === false && modules.some(module => module.contentType === "application/source-map")) {
    throw new WorkerArtifactError("Wrangler bundle contains source maps but upload_source_maps is disabled; rebuild before publishing");
  }
  modules.sort((a,b) => a.path.localeCompare(b.path));
  const assets = staticAssets ? collectAssetFiles(staticAssets) : undefined;
  const nativeContainers = metadata.containers;
  if (nativeContainers !== undefined && (!Array.isArray(nativeContainers) || nativeContainers.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const value = item as UnknownRecord;
    // Wrangler emits a generated application name even for unnamed config.
    // xAPI keeps its own scoped application identity; only the class links
    // this native upload to the explicit Container deployment definition.
    return typeof value.class_name !== 'string' ||
      (value.name !== undefined && (typeof value.name !== 'string' || !value.name || value.name.length > 512)) ||
      Object.keys(value).some(key => !['class_name', 'name'].includes(key));
  }))) {
    throw new WorkerArtifactError('Native Container metadata needs explicit platform mapping');
  }
  const configuredClasses = [...(containers || [])].map((item) => item.className).sort();
  const nativeClasses = [...((nativeContainers || []) as UnknownRecord[])].map((item) => String(item.class_name)).sort();
  if (JSON.stringify(nativeClasses) !== JSON.stringify(configuredClasses)) {
    throw new WorkerArtifactError('Wrangler Container classes differ from xapi.worker.json; rebuild or re-import before publishing');
  }
  const bundle: WorkerArtifactBundle = {
    version: 1,
    mainModule: main,
    modules,
    ...nativeOptions,
    ...(Object.keys(nativeConfiguration).length ? { nativeMetadata: nativeConfiguration } : {}),
    ...variableOptions,
    ...(observability ? { observability } : {}),
    ...(assets ? { assets } : {}),
    ...(containers?.length ? { containers } : {}),
  };
  assertArtifactContentLimit(bundle);
  const stored = storedBundleBytes(bundle);
  return { kind: "bundle", contentSha256: sha256(stored), sizeBytes: stored.length, upload: {bundle}, nativeMetadata: metadata };
}

function attachContainers(
  artifact: LoadedWorkerArtifact,
  containers?: WorkerContainerInput[],
): LoadedWorkerArtifact {
  if (!containers?.length) return artifact;
  if (!('bundle' in artifact.upload)) {
    const moduleCode = artifact.upload.moduleCode;
    const bundle: WorkerArtifactBundle = {
      version: 1,
      mainModule: 'index.mjs',
      modules: [{
        path: 'index.mjs',
        content: moduleCode,
        encoding: 'utf8',
        contentType: 'application/javascript+module',
      }],
      containers,
    };
    const bytes = storedBundleBytes(bundle);
    return { kind: 'bundle', contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };
  }
  const bundle = { ...artifact.upload.bundle, containers };
  const bytes = storedBundleBytes(bundle);
  return { ...artifact, contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };
}

function storedBundleBytes(bundle: WorkerArtifactBundle): Buffer {
  const { vars, ...variableOptions } = normalizeWorkerVariableOptions(bundle);
  const modules = [...bundle.modules]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((module) => ({
      path: module.path,
      contentBase64:
        module.encoding === 'base64'
          ? module.content
          : Buffer.from(module.content, 'utf8').toString('base64'),
      contentType: module.contentType,
    }));
  const assets = bundle.assets
    ? {
        files: [...bundle.assets.files].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
        ...(bundle.assets.binding ? { binding: bundle.assets.binding } : {}),
        ...(bundle.assets.config ? { config: bundle.assets.config } : {}),
      }
    : undefined;
  return Buffer.from(
    JSON.stringify({
      ...normalizeNativeWorkerOptions(bundle),
      ...(bundle.nativeMetadata !== undefined ? {nativeMetadata: normalizeWorkerNativeMetadata(bundle.nativeMetadata)} : {}),
      ...(bundle.queueBindingAliases && Object.keys(bundle.queueBindingAliases).length ? {queueBindingAliases: Object.fromEntries(Object.entries(bundle.queueBindingAliases).sort(([a], [b]) => a.localeCompare(b)))} : {}),
      ...variableOptions,
      ...(bundle.observability ? { observability: normalizeWorkerObservability(bundle.observability) } : {}),
      ...(bundle.containers?.length ? { containers: bundle.containers } : {}),
      ...(vars ? { vars } : {}),
      version: 1,
      mainModule: bundle.mainModule,
      modules,
      ...(assets ? { assets } : {}),
    }),
    "utf8",
  );
}

export function validateNativeDeploymentMetadata(
  artifact: LoadedWorkerArtifact,
  settings: { compatibilityDate?: string; compatibilityFlags?: string[]; queueBindingAliases?: Record<string, string>; nativeBundleRequired?: string[] },
  resources: Array<{ type: string; bindingName: string; className?: string }>,
  secrets: string[] = [],
): void {
  const metadata = artifact.nativeMetadata;
  if (!metadata && settings.nativeBundleRequired?.length) throw new WorkerArtifactError('Wrangler native bundle is required to preserve configuration: ' + settings.nativeBundleRequired.join(', ') + '; emit the original config with wrangler deploy --dry-run --outfile');
  if (!metadata) return;
  if (
    metadata.compatibility_date !== settings.compatibilityDate ||
    JSON.stringify(
      [...((metadata.compatibility_flags as string[]) || [])].sort(),
    ) !== JSON.stringify([...(settings.compatibilityFlags || [])].sort())
  ) {
    throw new WorkerArtifactError(
      "Wrangler bundle compatibility settings differ from deployment configuration; rebuild before publishing",
    );
  }
  const managed: Record<string, string> = {
    d1: "d1_database",
    r2_bucket: "r2_bucket",
    kv_namespace: "kv_namespace",
    queue: "queue",
  };
  for (const binding of (metadata.bindings || []) as UnknownRecord[]) {
    if (
      binding.type === "assets" &&
      artifact.upload &&
      "bundle" in artifact.upload &&
      artifact.upload.bundle.assets?.binding === binding.name
    )
      continue;
    const matching = resources.filter(
      (resource) => resource.bindingName === (binding.type === "queue" ? settings.queueBindingAliases?.[String(binding.name)] || binding.name : binding.name),
    );
    if (
      binding.type === "plain_text" ||
      binding.type === "json" ||
      binding.type === "version_metadata"
    ) {
      if (matching.length || secrets.includes(String(binding.name)))
        throw new WorkerArtifactError(
          `Duplicate Worker binding: ${binding.name}`,
        );
      continue;
    }
    if (binding.type === "workflow") {
      if (matching.length !== 1 || matching[0].type !== "workflow" ||
        matching[0].className !== binding.class_name) {
        throw new WorkerArtifactError(
          `Native Workflow binding ${binding.name} must match its declared xAPI class`,
        );
      }
      continue;
    }
    if (binding.type === "durable_object_namespace") {
      if (
        matching.length !== 1 ||
        matching[0].type !== "durable_object" ||
        matching[0].className !== binding.class_name
      ) {
        throw new WorkerArtifactError(
          `Native Durable Object binding ${binding.name} must match its declared xAPI class`,
        );
      }
      continue;
    }
    if (binding.type === "inherit" && secrets.includes(String(binding.name))) {
      if (matching.length)
        throw new WorkerArtifactError(
          `Duplicate Worker binding: ${binding.name}`,
        );
      continue;
    }
    const declared =
      binding.type === "inherit"
        ? matching.length === 1 &&
          Object.values(managed).includes(matching[0].type)
        : matching.some(
            (resource) => resource.type === managed[String(binding.type)],
          );
    if (!declared) {
      throw new WorkerArtifactError(
        `Native binding ${binding.name} is missing from xAPI resource declarations`,
      );
    }
  }
}

/** Public deployment configuration only; credentials use the Secrets API. */
export function normalizeWorkerVars(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerArtifactError('Worker vars must be a JSON object');
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  for (const [name] of entries) {
    if (!isWorkerBindingName(name) || name === 'XAPI_AI_BASE_URL') {
      throw new WorkerArtifactError(`Invalid or reserved Worker variable: ${name}`);
    }
  }
  try {
    // Reject lossy serialization (undefined, functions, NaN, circular values).
    JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new Error('Not JSON');
      }
      return item;
    });
  } catch {
    throw new WorkerArtifactError('Worker vars must contain JSON values');
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}


/** Attach declared native options; reject stale native build metadata. */
export function withNativeWorkerOptions(artifact: LoadedWorkerArtifact, options: {
  cacheOptions?: unknown; versionMetadata?: unknown; keepBindings?: unknown; observability?: unknown;
}): LoadedWorkerArtifact {
  const expected = {
    ...normalizeNativeWorkerOptions(options),
    ...normalizeWorkerVariableOptions({ keepBindings: options.keepBindings }),
    ...(options.observability !== undefined ? { observability: normalizeWorkerObservability(options.observability) } : {}),
  };
  if (artifact.nativeMetadata) {
    const actual = 'bundle' in artifact.upload ? {
      ...normalizeNativeWorkerOptions(artifact.upload.bundle),
      ...normalizeWorkerVariableOptions({ keepBindings: artifact.upload.bundle.keepBindings }),
      ...(artifact.upload.bundle.observability !== undefined
        ? { observability: normalizeWorkerObservability(artifact.upload.bundle.observability) } : {}),
    } : {};
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new WorkerArtifactError('Wrangler bundle cache/version metadata/variable retention/observability differs from the selected environment; rebuild before publishing');
    }
    return artifact;
  }
  if (!Object.keys(expected).length) return artifact;
  const bundle: WorkerArtifactBundle = 'bundle' in artifact.upload
    ? { ...artifact.upload.bundle, ...expected }
    : { version: 1, mainModule: 'index.mjs', ...expected, modules: [{
      path: 'index.mjs', content: artifact.upload.moduleCode,
      encoding: 'utf8', contentType: 'application/javascript+module',
    }] };
  const bytes = storedBundleBytes(bundle);
  return { ...artifact, kind: 'bundle', contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };
}

/** Keep native output authoritative; reject a stale build instead of changing it silently. */
export function withWorkerVars(artifact: LoadedWorkerArtifact, value: unknown): LoadedWorkerArtifact {
  const vars = normalizeWorkerVars(value);
  if (artifact.nativeMetadata) {
    const actual = 'bundle' in artifact.upload
      ? normalizeWorkerVariableOptions(artifact.upload.bundle).vars : undefined;
    if (JSON.stringify(actual) !== JSON.stringify(vars)) {
      throw new WorkerArtifactError('Wrangler bundle vars differ from the selected environment; rebuild before publishing');
    }
    return artifact;
  }
  if (!vars) return artifact;
  const bundle: WorkerArtifactBundle = 'bundle' in artifact.upload
    ? { ...artifact.upload.bundle, vars }
    : { version: 1, mainModule: 'index.mjs', vars, modules: [{
        path: 'index.mjs', content: artifact.upload.moduleCode,
        encoding: 'utf8', contentType: 'application/javascript+module',
      }] };
  const bytes = storedBundleBytes(bundle);
  return { ...artifact, kind: 'bundle', contentSha256: sha256(bytes), sizeBytes: bytes.length, upload: { bundle } };

}

/** Choose multipart for stored JSON/DTO limits, not a decoded-content quota. */
export function workerArtifactNeedsMultipart(input: WorkerArtifactUploadRequest): boolean {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_WORKER_JSON_BYTES) return true;
  if (!("bundle" in input)) return false;
  return storedBundleBytes(input.bundle).length > MAX_WORKER_JSON_BYTES;
}

export function workerArtifactDirectUpload(input: WorkerArtifactUploadRequest) {
  const bundle:WorkerArtifactBundle='bundle' in input?input.bundle:{
    version:1,mainModule:'index.mjs',
    modules:[{path:'index.mjs',content:input.moduleCode,encoding:'utf8',contentType:'application/javascript+module'}],
  };
  assertArtifactContentLimit(bundle);
  const files=new Map<string,Buffer>();
  const entry=(file:WorkerArtifactBundleModule|WorkerArtifactAsset)=>{
    const bytes=file.encoding==='base64'?Buffer.from(file.content,'base64'):Buffer.from(file.content,'utf8');
    const hash=sha256(bytes);files.set(hash,bytes);
    return {path:file.path,contentType:file.contentType,sha256:hash,size:bytes.length};
  };
  const {modules,assets,...settings}=bundle;
  const identityBytes='bundle' in input?storedBundleBytes(bundle):Buffer.from(input.moduleCode,'utf8');
  return {files,identity:{contentSha256:sha256(identityBytes),sizeBytes:identityBytes.length},
    input:{idempotencyKey:input.idempotencyKey,kind:'bundle' in input?'bundle':'module',
    manifest:{...settings,version:2,modules:modules.map(entry),
      ...(assets?{assets:{...assets,files:assets.files.map(entry)}}:{})}}};
}

export function workerArtifactMultipart(input: WorkerArtifactUploadRequest): FormData {
  const bundle: WorkerArtifactBundle = "bundle" in input ? input.bundle : {
    version: 1, mainModule: "index.mjs", modules: [{ path: "index.mjs", content: input.moduleCode, encoding: "utf8", contentType: "application/javascript+module" }],
  };
  assertArtifactContentLimit(bundle);
  const form = new FormData();
  let fileIndex = 0;
  const entry = (file: WorkerArtifactBundleModule | WorkerArtifactAsset) => {
    const bytes = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    form.append("files", new Blob([new Uint8Array(bytes)], { type: file.contentType }), `file-${fileIndex}`);
    return { path: file.path, contentType: file.contentType, fileIndex: fileIndex++ };
  };
  const { modules, assets, ...options } = bundle;
  const manifest = { ...options, version: 2, idempotencyKey: input.idempotencyKey, modules: modules.map(entry),
    ...(assets ? { assets: { ...assets, files: assets.files.map(entry) } } : {}),
  };
  const encoded = JSON.stringify(manifest);
  if (Buffer.byteLength(encoded, "utf8") > 10 * 1024 * 1024) throw new WorkerArtifactError("Worker multipart manifest exceeds the backend 10 MiB metadata limit");
  form.append("manifest", encoded);
  return form;
}
