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
const MAX_ASSET_FILES = 100_000;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
// The current xAPI JSON Artifact endpoint has a 20 MiB request-body ceiling.
// Base64 expansion leaves 12 MiB for decoded Worker modules plus assets.
const MAX_XAPI_ARTIFACT_CONTENT_BYTES = 12 * 1024 * 1024;
const SAFE_MODULE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]{1,240}$/;

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
  assets?: WorkerArtifactAssets;
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
  if (moduleBytes + assetBytes > MAX_XAPI_ARTIFACT_CONTENT_BYTES) {
    throw new WorkerArtifactError(
      "Worker modules and static assets exceed the current xAPI Artifact transport limit of 12 MiB",
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
