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

// Match the backend module, decoded content and receiver budgets. Multipart
// bypasses JSON/base64 transport limits without changing the canonical identity.
export const MAX_WORKER_MODULE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKER_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_WORKER_JSON_BYTES = 18 * 1024 * 1024;
const MAX_BUNDLE_CONTENT_BYTES = MAX_WORKER_MODULE_BYTES;
const MAX_BUNDLE_MODULES = 110_000; // backend receiver record/inode budget
const MAX_ASSET_FILES = 100_000;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
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

export interface WorkerArtifactBundle {
  version: 1;
  mainModule: string;
  modules: WorkerArtifactBundleModule[];
  queueBindingAliases?: Record<string, string>;
  nativeMetadata?: Record<string, unknown>;
  versionMetadata?: {binding:string};
  keepBindings?: Array<'plain_text'|'json'>;
  observability?: WorkerArtifactObservability;
  assets?: WorkerArtifactAssets;
  containers?: WorkerContainerInput[];
  vars?: Record<string, unknown>;
  varTypes?: Record<string, 'plain_text' | 'json'>;
}

export interface WorkerPublicVariables {
  vars: Record<string, unknown>;
  varTypes?: Record<string, 'plain_text' | 'json'>;
}

/** Same public-variable identity rules as the existing backend bundle format. */
export function normalizeWorkerPublicVariables(value: unknown, varTypes?: unknown): WorkerPublicVariables {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkerArtifactError('Worker vars must be a JSON object');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  for (const [name] of entries)
    if (!isWorkerBindingName(name) || name === 'XAPI_AI_BASE_URL')
      throw new WorkerArtifactError('Invalid or reserved Worker variable: ' + name);
  try {
    JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw Error('Not JSON');
      return item;
    });
  } catch { throw new WorkerArtifactError('Worker vars must contain JSON values'); }
  const vars = Object.fromEntries(entries);
  const exceptions: Array<[string, 'json']> = [];
  if (varTypes !== undefined) {
    if (!varTypes || typeof varTypes !== 'object' || Array.isArray(varTypes))
      throw new WorkerArtifactError('Worker varTypes must be an object');
    for (const [name, type] of Object.entries(varTypes).sort(([a], [b]) => a.localeCompare(b))) {
      if (!Object.prototype.hasOwnProperty.call(vars, name) || (type !== 'plain_text' && type !== 'json') ||
          (type === 'plain_text' && typeof vars[name] !== 'string'))
        throw new WorkerArtifactError('Worker varTypes must reference vars with valid plain_text or json types');
      if (type === 'json' && typeof vars[name] === 'string') exceptions.push([name, 'json']);
    }
  }
  return {vars, ...(exceptions.length ? {varTypes:Object.fromEntries(exceptions)} : {})};
}

export function attachWorkerPublicVariables(artifact: LoadedWorkerArtifact, variables?: WorkerPublicVariables): LoadedWorkerArtifact {
  if (variables === undefined) return artifact;
  const normalized = normalizeWorkerPublicVariables(variables.vars, variables.varTypes);
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',content:artifact.upload.moduleCode,encoding:'utf8',contentType:'application/javascript+module'}]
  };
  if (artifact.nativeMetadata) {
    const nativeVars = normalizeWorkerPublicVariables(base.vars || {}, base.varTypes);
    if (JSON.stringify(nativeVars) !== JSON.stringify(normalized))
      throw new WorkerArtifactError('Native bundle public variables differ from the selected Wrangler environment');
  }
  const {vars: _oldVars, varTypes: _oldTypes, ...rest} = base;
  const bundle: WorkerArtifactBundle = {...rest,
    ...(Object.keys(normalized.vars).length ? normalized : {})};
  if (!('bundle' in artifact.upload) && !Object.keys(normalized.vars).length) return artifact;
  const bytes = storedBundleBytes(bundle);
  return {...artifact,kind:'bundle',contentSha256:sha256(bytes),sizeBytes:bytes.length,upload:{bundle}};
}

/** Preserve emitted native options, or replace them with a complete environment override. */
export function attachWorkerNativeMetadata(artifact: LoadedWorkerArtifact, metadata?: Record<string, unknown>): LoadedWorkerArtifact {
  if (metadata === undefined) return artifact;
  const configured = normalizeWorkerNativeMetadata(metadata)!;
  const emitted = 'bundle' in artifact.upload ? artifact.upload.bundle.nativeMetadata : undefined;
  const normalized = artifact.nativeMetadata ? normalizeWorkerNativeMetadata({...emitted,...configured})! : configured;
  if (!Object.keys(normalized).length && !('bundle' in artifact.upload)) return artifact;
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',content:artifact.upload.moduleCode,encoding:'utf8',contentType:'application/javascript+module'}]
  };
  const {nativeMetadata:_native,observability:_observability,versionMetadata:_version,keepBindings:_keep,...rest} = base;
  const publicKeep = (normalized.keep_bindings as string[] | undefined)?.filter(type => type === 'plain_text' || type === 'json');
  const bundle: WorkerArtifactBundle = {...rest,nativeMetadata:normalized,
    ...(normalized.version_metadata ? {versionMetadata:normalized.version_metadata as {binding:string}} : {}),
    ...(publicKeep?.length ? {keepBindings:publicKeep as Array<'plain_text'|'json'>} : {})};
  const bytes = storedBundleBytes(bundle);
  return {...artifact,kind:'bundle',contentSha256:sha256(bytes),sizeBytes:bytes.length,upload:{bundle}};
}

export interface WorkerArtifactObservability {
  [key: string]: unknown;
  enabled?: boolean;
  head_sampling_rate?: number;
  logs?: { [key: string]: unknown; enabled?: boolean; head_sampling_rate?: number; invocation_logs?: boolean; persist?: boolean };
  traces?: { [key: string]: unknown; enabled?: boolean; head_sampling_rate?: number; persist?: boolean };
}

export function normalizeWorkerObservability(value: unknown): WorkerArtifactObservability | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkerArtifactError('Worker observability must be an object');
  const metadata = normalizeWorkerNativeMetadata({observability: value})!;
  // Retain the historical field order so existing Artifact identities are stable.
  // Unknown ordinary fields survive; Cloudflare validates their native meaning.
  const order = (input: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
    const keys = [...fields.filter(key => Object.hasOwn(input, key)),
      ...Object.keys(input).filter(key => !fields.includes(key)).sort()];
    return Object.fromEntries(keys.map(key => {
      let item = input[key];
      if ((key === 'logs' || key === 'traces') && item && typeof item === 'object' && !Array.isArray(item))
        item = order(item as Record<string, unknown>, ['enabled', 'head_sampling_rate', ...(key === 'logs' ? ['invocation_logs'] : []), 'persist']);
      return [key, item];
    }));
  };
  return order(metadata.observability as Record<string, unknown>, ['enabled', 'head_sampling_rate', 'logs', 'traces']) as WorkerArtifactObservability;
}

export function attachWorkerObservability(artifact: LoadedWorkerArtifact, value: WorkerArtifactObservability | undefined, queueBindingAliases?: Record<string, string>): LoadedWorkerArtifact {
  value = normalizeWorkerObservability(value);
  if (value === undefined && !Object.keys(queueBindingAliases || {}).length) return artifact;
  const base: WorkerArtifactBundle = 'bundle' in artifact.upload ? artifact.upload.bundle : {
    version: 1, mainModule: 'index.mjs', modules: [{ path: 'index.mjs', content: artifact.upload.moduleCode, encoding: 'utf8', contentType: 'application/javascript+module' }],
  };
  if (value !== undefined && artifact.nativeMetadata?.observability !== undefined && JSON.stringify(normalizeWorkerObservability(artifact.nativeMetadata.observability)) !== JSON.stringify(normalizeWorkerObservability(value))) throw new WorkerArtifactError('Native bundle observability differs from Wrangler settings');
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
      const bytes = readFileSync(absolute);
      files.push({ path: `/${relativePath}`, content: bytes.toString("base64"), encoding: "base64", contentType: assetContentType(relativePath) });
      if (files.length > MAX_ASSET_FILES) throw new WorkerArtifactError(`Static assets exceed Cloudflare's ${MAX_ASSET_FILES} file limit`);
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
  if (moduleBytes > MAX_WORKER_MODULE_BYTES) throw new WorkerArtifactError("Worker module contents exceed the backend 64 MiB limit");
  if (moduleBytes + assetBytes > MAX_WORKER_ARTIFACT_BYTES) throw new WorkerArtifactError("Worker modules and assets exceed the backend 100 MiB content limit");
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
  if (info.size > MAX_WORKER_MODULE_BYTES) {
    throw new WorkerArtifactError(
      "Single-file Worker output exceeds the backend 64 MiB module limit",
    );
  }
  const bytes = readFileSync(path);
  const moduleCode = bytes.toString("utf8");
  if (!Buffer.from(moduleCode, "utf8").equals(bytes)) {
    throw new WorkerArtifactError(
      "Single-file Worker output must be valid UTF-8 JavaScript",
    );
  }
  validateJavaScript(portableRelativePath(resolve(path, ".."), path), moduleCode, undefined, true);
  if (workerArtifactNeedsMultipart({ moduleCode, idempotencyKey: 'k'.repeat(128) })) {
    const bundle: WorkerArtifactBundle = { version: 1, mainModule: posix.basename(path), modules: [{
      path: posix.basename(path), content: moduleCode, encoding: "utf8", contentType: "application/javascript+module",
    }] };
    const stored = storedBundleBytes(bundle);
    return { kind: "bundle", contentSha256: sha256(stored), sizeBytes: stored.length, upload: { bundle } };
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
  if ("bundle" in legacy.upload) {
    const bundle = { ...legacy.upload.bundle, assets: collectAssetFiles(staticAssets) };
    assertArtifactContentLimit(bundle);
    const stored = storedBundleBytes(bundle);
    return { kind: "bundle", contentSha256: sha256(stored), sizeBytes: stored.length, upload: { bundle } };
  }
  const mainModule = posix.basename(path);
  const assets = collectAssetFiles(staticAssets);
  const bundle: WorkerArtifactBundle = {
    version: 1,
    mainModule,
    modules: [{
      path: mainModule,
      content: legacy.upload.moduleCode,
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
      contentBase64: Buffer.from(legacy.upload.moduleCode, "utf8").toString("base64"),
      contentType: "application/javascript+module",
    }],
    assets,
  }), "utf8");
  return { kind: "bundle", contentSha256: sha256(storedBytes), sizeBytes: storedBytes.length, upload: { bundle } };
}

function collectBundleFiles(root: string): Array<{
  path: string;
  bytes: Buffer;
  contentType: WorkerModuleContentType;
}> {
  const files: Array<{
    path: string;
    bytes: Buffer;
    contentType: WorkerModuleContentType;
  }> = [];
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
      const contentType = moduleContentType(relativePath);
      if (!contentType) {
        throw new WorkerArtifactError(
          `Worker output contains an unsupported module file: ${relativePath}. Code bundles support .js, .mjs, .map, .wasm, .txt, and .bin; publish website assets through the static-assets workflow.`,
        );
      }
      files.push({ path: relativePath, bytes: readFileSync(absolute), contentType });
      if (files.length > MAX_BUNDLE_MODULES) {
        throw new WorkerArtifactError(
          `Worker bundle exceeds the ${MAX_BUNDLE_MODULES} module limit`,
        );
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function loadModuleBundle(root: string, main: string | undefined, staticAssets?: WorkerStaticAssetsInput): LoadedWorkerArtifact {
  const mainModule = normalizeMainModule(main);
  const files = collectBundleFiles(root);
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
    return staticAssets
      ? loadSingleModuleWithAssets(outputPath, staticAssets)
      : loadSingleModule(outputPath);
  }
  if (info.isDirectory()) return loadModuleBundle(outputPath, mainModule, staticAssets);
  throw new WorkerArtifactError("Worker build output is not a file or directory");
}

/** Read Wrangler's --dry-run --outfile multipart artifact without rewriting code. */
export async function loadWorkerArtifactInput(
  outputPath: string,
  mainModule?: string,
  staticAssets?: WorkerStaticAssetsInput,
  containers?: WorkerContainerInput[],
): Promise<LoadedWorkerArtifact> {
  if (!outputPath.endsWith(".bundle")) return attachContainers(loadWorkerArtifact(outputPath, mainModule, staticAssets), containers);
  if (mainModule) throw new WorkerArtifactError("Wrangler bundles contain their own main_module; omit --main/build.main");
  if (!existsSync(outputPath) || !lstatSync(outputPath).isFile() || lstatSync(outputPath).isSymbolicLink()) {
    throw new WorkerArtifactError("Wrangler bundle must be a regular file");
  }
  if (statSync(outputPath).size > MAX_WORKER_ARTIFACT_BYTES) throw new WorkerArtifactError("Wrangler bundle exceeds the current Artifact transport limit");
  const bytes = readFileSync(outputPath);
  const firstLine = bytes.subarray(0, bytes.indexOf("\r\n")).toString("ascii");
  if (!/^--[A-Za-z0-9_-]{1,70}$/.test(firstLine)) throw new WorkerArtifactError("Invalid Wrangler multipart boundary");
  type NativeFile = { name: string; type: string; arrayBuffer(): Promise<Uint8Array> };
  const entries = await new Promise<Array<[string, string | NativeFile]>>((resolve, reject) => {
    const result: Array<[string, string | NativeFile]> = [];
    const parser = busboy({ headers: {"content-type": `multipart/form-data; boundary=${firstLine.slice(2)}`}, preservePath: true,
      limits: { files: MAX_BUNDLE_MODULES + 1, fields: 1, parts: MAX_BUNDLE_MODULES + 2, fieldSize: 10 * 1024 * 1024, fileSize: MAX_BUNDLE_CONTENT_BYTES + 1 } });
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
  const {main_module:_main,bindings:_bindings,compatibility_date:_date,compatibility_flags:_flags,
    containers:_containers,...nativeOptions} = metadata;
  const nativeConfiguration = normalizeWorkerNativeMetadata(nativeOptions)!;
  const bindingTypes = new Set(["d1", "r2_bucket", "kv_namespace", "queue", "durable_object_namespace", "workflow", "plain_text", "json", "version_metadata"]);
  if (metadata.bindings !== undefined && (!Array.isArray(metadata.bindings) || metadata.bindings.some((binding: UnknownRecord) =>
    !binding || typeof binding !== "object" || Array.isArray(binding) || !bindingTypes.has(String(binding.type)) || typeof binding.name !== "string"
  ))) throw new WorkerArtifactError("Native binding metadata needs explicit platform mapping; keep credentials in xAPI Secrets");
  const bindingNames = new Set<string>();
  const nativeVarEntries: Array<[string, unknown]> = [];
  const nativeVarTypes: Array<[string, 'json']> = [];
  metadata.bindings = ((metadata.bindings || []) as UnknownRecord[]).map(binding => {
    const name = binding.name as string;
    if (!isWorkerBindingName(name) || bindingNames.has(name)) throw new WorkerArtifactError(`Invalid or duplicate native binding: ${name}`);
    bindingNames.add(name);
    if (binding.type === 'version_metadata') {nativeConfiguration.version_metadata={binding:name};return {name,type:binding.type};}
    if (binding.type === 'plain_text' || binding.type === 'json') {
      if (binding.type === 'plain_text' && typeof binding.text !== 'string')
        throw new WorkerArtifactError('Native plain_text binding requires text');
      if (binding.type === 'json' && !Object.prototype.hasOwnProperty.call(binding, 'json'))
        throw new WorkerArtifactError('Native json binding requires json');
      const value = binding.type === 'plain_text' ? binding.text : binding.json;
      nativeVarEntries.push([name, value]);
      if (binding.type === 'json' && typeof value === 'string') nativeVarTypes.push([name,'json']);
      return {name,type:binding.type};
    }
    const hasClass = binding.type === "durable_object_namespace" || binding.type === "workflow";
    if (hasClass && (typeof binding.class_name !== "string" || !WORKER_CLASS_IDENTIFIER.test(binding.class_name))) throw new WorkerArtifactError(`Native binding ${name} requires an exported class_name`);
    // The backend resolves actual IDs and target scripts from owned resource IDs.
    return { name, type: binding.type, ...(hasClass ? { class_name: binding.class_name } : {}) };
  });
  if (metadata.compatibility_flags !== undefined && (!Array.isArray(metadata.compatibility_flags) || metadata.compatibility_flags.some(flag => typeof flag !== "string"))) throw new WorkerArtifactError("Invalid native compatibility flags");
  const observability = undefined;
  const publicVariables = normalizeWorkerPublicVariables(Object.fromEntries(nativeVarEntries), Object.fromEntries(nativeVarTypes));
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
  modules.sort((a,b) => a.path.localeCompare(b.path));
  const assets = staticAssets ? collectAssetFiles(staticAssets) : undefined;
  const nativeContainers = metadata.containers;
  // Wrangler emits its logical application name in the native bundle. It is
  // not a reusable account resource ID: deployment resolves the owned physical
  // application from the declared class below. Never forward this name as an ID.
  if (nativeContainers !== undefined && (!Array.isArray(nativeContainers) || nativeContainers.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof (item as UnknownRecord).class_name !== 'string' ||
      ((item as UnknownRecord).name !== undefined && typeof (item as UnknownRecord).name !== 'string') ||
      Object.keys(item as UnknownRecord).some((key) => key !== 'class_name' && key !== 'name')))) {
    throw new WorkerArtifactError('Native Container metadata needs explicit platform mapping');
  }
  const configuredClasses = [...(containers || [])].map((item) => item.className).sort();
  const nativeClasses = [...((nativeContainers || []) as UnknownRecord[])].map((item) => String(item.class_name)).sort();
  if (JSON.stringify(nativeClasses) !== JSON.stringify(configuredClasses)) {
    throw new WorkerArtifactError('Wrangler Container classes differ from xapi.worker.json; rebuild or re-import before publishing');
  }
  const bundle: WorkerArtifactBundle = { version: 1, mainModule: main, modules,
    ...(Object.keys(nativeConfiguration).length ? {nativeMetadata:nativeConfiguration} : {}),
    ...(nativeConfiguration.version_metadata ? {versionMetadata:nativeConfiguration.version_metadata as {binding:string}} : {}),
    ...((nativeConfiguration.keep_bindings as string[]|undefined)?.some(x=>x==='plain_text'||x==='json') ? {keepBindings:(nativeConfiguration.keep_bindings as string[]).filter(x=>x==='plain_text'||x==='json') as Array<'plain_text'|'json'>} : {}), ...(observability ? {observability} : {}), ...(assets ? {assets} : {}), ...(containers?.length ? {containers} : {}), ...(Object.keys(publicVariables.vars).length ? publicVariables : {}) };
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
  const publicVariables = normalizeWorkerPublicVariables(bundle.vars || {}, bundle.varTypes);
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
      ...(bundle.nativeMetadata !== undefined ? {nativeMetadata:normalizeWorkerNativeMetadata(bundle.nativeMetadata)} : {}),
      ...(bundle.queueBindingAliases && Object.keys(bundle.queueBindingAliases).length ? {queueBindingAliases: bundle.queueBindingAliases} : {}),
      ...(bundle.versionMetadata ? {versionMetadata:bundle.versionMetadata} : {}),
      ...(bundle.keepBindings?.length ? {keepBindings:bundle.keepBindings} : {}),
      ...(publicVariables.varTypes ? {varTypes:publicVariables.varTypes} : {}),
      ...(bundle.observability ? { observability: normalizeWorkerObservability(bundle.observability) } : {}),
      ...(bundle.containers?.length ? { containers: bundle.containers } : {}),
      ...(Object.keys(publicVariables.vars).length ? {vars:publicVariables.vars} : {}),
      version: 1,
      mainModule: bundle.mainModule,
      modules,
      ...(assets ? { assets } : {}),
    }),
    'utf8',
  );
}

export function validateNativeDeploymentMetadata(
  artifact: LoadedWorkerArtifact,
  settings: { compatibilityDate?: string; compatibilityFlags?: string[]; queueBindingAliases?: Record<string, string>; nativeBundleRequired?: string[] },
  resources: Array<{type: string; bindingName: string; className?: string}>,
): void {
  const metadata = artifact.nativeMetadata;
  if (!metadata && settings.nativeBundleRequired?.length) throw new WorkerArtifactError('Wrangler native bundle is required to preserve configuration: ' + settings.nativeBundleRequired.join(', ') + '; emit the original config with wrangler deploy --dry-run --outfile');
  if (!metadata) return;
  if (metadata.compatibility_date !== settings.compatibilityDate ||
    JSON.stringify([...(metadata.compatibility_flags as string[] || [])].sort()) !== JSON.stringify([...(settings.compatibilityFlags || [])].sort())) {
    throw new WorkerArtifactError("Wrangler bundle compatibility settings differ from deployment configuration; rebuild before publishing");
  }
  const managed: Record<string,string> = {d1: "d1_database", r2_bucket: "r2_bucket", kv_namespace: "kv_namespace", queue: "queue", durable_object_namespace: "durable_object", workflow: "workflow"};
  for (const binding of (metadata.bindings || []) as UnknownRecord[]) {
    if (['plain_text','json','version_metadata'].includes(String(binding.type))) continue;
    const resource = resources.find(resource => resource.bindingName === (binding.type === "queue" ? settings.queueBindingAliases?.[String(binding.name)] || binding.name : binding.name) && resource.type === managed[String(binding.type)]);
    if (!resource) {
      throw new WorkerArtifactError(`Native binding ${binding.name} is missing from xAPI resource declarations`);
    }
    if (binding.class_name !== undefined && resource.className !== binding.class_name) throw new WorkerArtifactError(`Native binding ${binding.name} class_name differs from xAPI resource declarations`);
  }
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
  return {files,input:{idempotencyKey:input.idempotencyKey,kind:'bundle' in input?'bundle':'module',
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
