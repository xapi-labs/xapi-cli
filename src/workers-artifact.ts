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
const MAX_BUNDLE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_MODULES = 200;
const MAX_ASSET_FILES = 10_000;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
// Complete projects use one multipart binary request and content-addressed
// server storage. This is an xAPI project quota, not Cloudflare's account cap.
const MAX_XAPI_ARTIFACT_CONTENT_BYTES = 100 * 1024 * 1024;
const SAFE_MODULE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+~/-]{1,240}$/;

type UnknownRecord = Record<string, unknown>;

export type WorkerModuleContentType =
  | "application/javascript+module"
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
  observability?: { enabled: boolean };
  assets?: WorkerArtifactAssets;
  containers?: WorkerContainerInput[];
  vars?: Record<string, unknown>;
}

export interface WorkerContainerInput {
  name: string;
  className: string;
  image: string;
  instanceType: 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';
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
  if (moduleBytes + assetBytes > MAX_XAPI_ARTIFACT_CONTENT_BYTES) {
    throw new WorkerArtifactError(
      "Worker modules and static assets exceed the xAPI project limit of 100 MiB",
    );
  }
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
  if (info.size > MAX_LEGACY_ARTIFACT_BYTES) {
    throw new WorkerArtifactError(
      "Single-file Worker output exceeds the 1 MiB artifact limit; use a code-split output directory when appropriate",
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
  return {
    kind: "module",
    contentSha256: sha256(bytes),
    sizeBytes: bytes.length,
    upload: { moduleCode },
  };
}

function loadSingleModuleWithAssets(path: string, staticAssets: WorkerStaticAssetsInput): LoadedWorkerArtifact {
  const legacy = loadSingleModule(path);
  if (!("moduleCode" in legacy.upload)) throw new WorkerArtifactError("Worker module could not be loaded");
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
          `Worker output contains an unsupported module file: ${relativePath}. Code bundles support .js, .mjs, .wasm, .txt, and .bin; publish website assets through the static-assets workflow.`,
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
  if (statSync(outputPath).size > 18 * 1024 * 1024) throw new WorkerArtifactError("Wrangler bundle exceeds the current Artifact transport limit");
  const bytes = readFileSync(outputPath);
  const firstLine = bytes.subarray(0, bytes.indexOf("\r\n")).toString("ascii");
  if (!/^--[A-Za-z0-9_-]{1,70}$/.test(firstLine)) throw new WorkerArtifactError("Invalid Wrangler multipart boundary");
  type NativeFile = { name: string; type: string; arrayBuffer(): Promise<Uint8Array> };
  const entries = await new Promise<Array<[string, string | NativeFile]>>((resolve, reject) => {
    const result: Array<[string, string | NativeFile]> = [];
    const parser = busboy({ headers: {"content-type": `multipart/form-data; boundary=${firstLine.slice(2)}`}, preservePath: true,
      limits: { files: MAX_BUNDLE_MODULES, fields: 1, parts: MAX_BUNDLE_MODULES + 1, fieldSize: 1024 * 1024, fileSize: MAX_BUNDLE_CONTENT_BYTES } });
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
  const known = new Set(["main_module", "bindings", "compatibility_date", "compatibility_flags", "observability", "package_dependencies", "containers"]);
  const unknown = Object.keys(metadata).filter(key => !known.has(key));
  if (unknown.length) throw new WorkerArtifactError(`Native metadata needs explicit platform mapping: ${unknown.join(", ")}`);
  const packageDependencies = metadata.package_dependencies;
  if (packageDependencies !== undefined && (
    !Array.isArray(packageDependencies) ||
    packageDependencies.length > 1000 ||
    packageDependencies.some((dependency: UnknownRecord) =>
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency) ||
      Object.keys(dependency).some(key => !["name", "packageJsonVersion", "installedVersion"].includes(key)) ||
      typeof dependency.name !== "string" ||
      dependency.name.length < 1 ||
      dependency.name.length > 500 ||
      typeof dependency.packageJsonVersion !== "string" ||
      dependency.packageJsonVersion.length > 500 ||
      typeof dependency.installedVersion !== "string" ||
      dependency.installedVersion.length > 500
    )
  )) throw new WorkerArtifactError("Invalid native package dependency metadata");
  if (metadata.bindings !== undefined && (!Array.isArray(metadata.bindings) || metadata.bindings.some((binding: UnknownRecord) => {
    if (!binding || typeof binding.name !== "string") return true;
    if (binding.type === "plain_text") {
      return typeof binding.text !== "string" || Object.keys(binding).some(key => !["name", "type", "text"].includes(key));
    }
    if (binding.type === "json") {
      return !("json" in binding) || Object.keys(binding).some(key => !["name", "type", "json"].includes(key));
    }
    if (["d1", "r2_bucket", "kv_namespace", "inherit"].includes(String(binding.type))) return false;
    if (binding.type === "durable_object_namespace") {
      // Only a class in this script can map to the declared managed DO. An
      // external script/namespace needs its own ownership-aware API contract.
      return typeof binding.class_name !== "string" || !binding.class_name ||
        Object.keys(binding).some(key => !["name", "type", "class_name"].includes(key));
    }
    return binding.type !== "assets" || !staticAssets?.binding || binding.name !== staticAssets.binding;
  }))) throw new WorkerArtifactError("Native binding metadata needs explicit platform mapping; keep credentials in xAPI Secrets");
  const nativeBindings = (metadata.bindings || []) as UnknownRecord[];
  const bindingNames = nativeBindings.map(binding => binding.name);
  if (new Set(bindingNames).size !== bindingNames.length) throw new WorkerArtifactError("Duplicate native binding name");
  const vars = normalizeWorkerVars(Object.fromEntries(nativeBindings
    .filter(binding => binding.type === "plain_text" || binding.type === "json")
    .map(binding => [String(binding.name), binding.type === "plain_text" ? binding.text : binding.json])));
  if (metadata.compatibility_flags !== undefined && (!Array.isArray(metadata.compatibility_flags) || metadata.compatibility_flags.some(flag => typeof flag !== "string"))) throw new WorkerArtifactError("Invalid native compatibility flags");
  const observation = metadata.observability as UnknownRecord | undefined;
  if (observation !== undefined && (!observation || typeof observation !== "object" || Array.isArray(observation) || typeof observation.enabled !== "boolean" || Object.keys(observation).some(key => key !== "enabled"))) throw new WorkerArtifactError("Native observability config needs explicit mapping");
  const observability = observation ? {enabled: observation.enabled as boolean} : undefined;
  const main = normalizeMainModule(typeof metadata.main_module === "string" ? metadata.main_module : undefined);
  const modules: WorkerArtifactBundleModule[] = [];
  const seen = new Set<string>();
  let moduleBytes = 0;
  const types = new Set<WorkerModuleContentType>(["application/javascript+module", "application/wasm", "text/plain", "application/octet-stream"]);
  for (const [name, value] of entries) {
    if (name === "metadata") continue;
    if (typeof value === "string" || !SAFE_MODULE_PATH.test(name) || seen.has(name) || value.name !== name) throw new WorkerArtifactError(`Invalid or duplicate native module: ${name}`);
    seen.add(name);
    const contentType = value.type as WorkerModuleContentType;
    if (!types.has(contentType)) throw new WorkerArtifactError(`Native module type needs platform mapping: ${contentType}`);
    const content = Buffer.from(await value.arrayBuffer());
    moduleBytes += content.length;
    if (moduleBytes > MAX_BUNDLE_CONTENT_BYTES || seen.size > MAX_BUNDLE_MODULES) throw new WorkerArtifactError("Native modules exceed current Artifact capacity");
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
  const bundle: WorkerArtifactBundle = { version: 1, mainModule: main, modules, ...(vars ? {vars} : {}), ...(observability ? {observability} : {}), ...(assets ? {assets} : {}), ...(containers?.length ? {containers} : {}) };
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
      ...(bundle.observability ? { observability: bundle.observability } : {}),
      ...(bundle.containers?.length ? { containers: bundle.containers } : {}),
      ...(normalizeWorkerVars(bundle.vars) ? { vars: normalizeWorkerVars(bundle.vars) } : {}),
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
  settings: { compatibilityDate?: string; compatibilityFlags?: string[] },
  resources: Array<{type: string; bindingName: string; className?: string}>,
): void {
  const metadata = artifact.nativeMetadata;
  if (!metadata) return;
  if (metadata.compatibility_date !== settings.compatibilityDate ||
    JSON.stringify([...(metadata.compatibility_flags as string[] || [])].sort()) !== JSON.stringify([...(settings.compatibilityFlags || [])].sort())) {
    throw new WorkerArtifactError("Wrangler bundle compatibility settings differ from deployment configuration; rebuild before publishing");
  }
  const managed: Record<string,string> = {d1: "d1_database", r2_bucket: "r2_bucket", kv_namespace: "kv_namespace"};
  for (const binding of (metadata.bindings || []) as UnknownRecord[]) {
    if (binding.type === "assets" && artifact.upload && "bundle" in artifact.upload &&
      artifact.upload.bundle.assets?.binding === binding.name) continue;
    const matching = resources.filter(resource => resource.bindingName === binding.name);
    if (binding.type === "plain_text" || binding.type === "json") {
      if (matching.length) throw new WorkerArtifactError(`Duplicate Worker binding: ${binding.name}`);
      continue;
    }
    if (binding.type === "durable_object_namespace") {
      if (matching.length !== 1 || matching[0].type !== "durable_object" || matching[0].className !== binding.class_name) {
        throw new WorkerArtifactError(`Native Durable Object binding ${binding.name} must match its declared xAPI class`);
      }
      continue;
    }
    const declared = binding.type === "inherit"
      ? matching.length === 1 && Object.values(managed).includes(matching[0].type)
      : matching.some(resource => resource.type === managed[String(binding.type)]);
    if (!declared) {
      throw new WorkerArtifactError(`Native binding ${binding.name} is missing from xAPI resource declarations`);
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
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name === 'XAPI_AI_BASE_URL') {
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


/** Keep native output authoritative; reject a stale build instead of changing it silently. */
export function withWorkerVars(artifact: LoadedWorkerArtifact, value: unknown): LoadedWorkerArtifact {
  const vars = normalizeWorkerVars(value);
  if (artifact.nativeMetadata) {
    const actual = 'bundle' in artifact.upload ? normalizeWorkerVars(artifact.upload.bundle.vars) : undefined;
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
