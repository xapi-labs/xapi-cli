import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWorkerArtifact,
  WorkerArtifactError,
} from "../workers-artifact.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "xapi-worker-artifact-"));
  roots.push(root);
  return root;
}

describe("Worker Artifact loader", () => {
  test("keeps the legacy single-module request and raw-byte hash", () => {
    const root = directory();
    const source = "export default { fetch() { return new Response('ok') } };";
    const path = join(root, "worker.mjs");
    writeFileSync(path, source);

    const artifact = loadWorkerArtifact(path);

    expect(artifact.kind).toBe("module");
    expect(artifact.upload).toEqual({ moduleCode: source });
    expect(artifact.contentSha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
  });

  test("builds a deterministic multi-module request and server-compatible hash", () => {
    const root = directory();
    mkdirSync(join(root, "chunks"));
    writeFileSync(
      join(root, "worker.js"),
      'import { answer } from "./chunks/answer.js"; import data from "./data.bin"; export default { fetch() { return Response.json({ answer, size: data.byteLength }) } };',
    );
    writeFileSync(join(root, "chunks/answer.js"), "export const answer = 42;");
    writeFileSync(join(root, "data.bin"), Buffer.from([0, 1, 2, 255]));

    const artifact = loadWorkerArtifact(root, "worker.js");
    expect(artifact.kind).toBe("bundle");
    if (!("bundle" in artifact.upload)) throw new Error("expected bundle");
    expect(artifact.upload.bundle.modules.map((item) => item.path)).toEqual([
      "chunks/answer.js",
      "data.bin",
      "worker.js",
    ]);
    expect(artifact.upload.bundle.modules[1]).toEqual(
      expect.objectContaining({
        path: "data.bin",
        encoding: "base64",
        content: "AAEC/w==",
        contentType: "application/octet-stream",
      }),
    );
    const stored = Buffer.from(
      JSON.stringify({
        version: 1,
        mainModule: "worker.js",
        modules: artifact.upload.bundle.modules.map((module) => ({
          path: module.path,
          contentBase64:
            module.encoding === "base64"
              ? module.content
              : Buffer.from(module.content, "utf8").toString("base64"),
          contentType: module.contentType,
        })),
      }),
      "utf8",
    );
    expect(artifact.contentSha256).toBe(
      createHash("sha256").update(stored).digest("hex"),
    );
    expect(artifact.sizeBytes).toBe(stored.length);
  });

  test("requires an explicit directory entrypoint", () => {
    const root = directory();
    writeFileSync(join(root, "worker.js"), "export default {};");
    expect(() => loadWorkerArtifact(root)).toThrow(WorkerArtifactError);
    expect(() => loadWorkerArtifact(root)).toThrow("--main");
  });

  test("packages native static assets with MIME types and routing settings", () => {
    const root = directory();
    const worker = join(root, "worker.mjs");
    const assets = join(root, "public");
    mkdirSync(assets);
    writeFileSync(worker, "export default { fetch() { return new Response('api') } };");
    writeFileSync(join(assets, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(assets, "logo.png"), Buffer.from([137, 80, 78, 71]));

    const artifact = loadWorkerArtifact(worker, undefined, {
      directory: assets,
      binding: "ASSETS",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });

    expect(artifact.kind).toBe("bundle");
    if (!("bundle" in artifact.upload)) throw new Error("expected bundle");
    expect(artifact.upload.bundle.assets).toEqual({
      binding: "ASSETS",
      config: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"],
      },
      files: [
        expect.objectContaining({ path: "/index.html", contentType: "text/html" }),
        expect.objectContaining({ path: "/logo.png", contentType: "image/png" }),
      ],
    });
  });

  test("accepts complete-project assets larger than the legacy JSON limit", () => {
    const root = directory();
    const worker = join(root, "worker.mjs");
    const assets = join(root, "public");
    mkdirSync(assets);
    writeFileSync(worker, "export default {};");
    writeFileSync(join(assets, "large.bin"), Buffer.alloc(13 * 1024 * 1024, 7));

    const artifact = loadWorkerArtifact(worker, undefined, {
      directory: assets,
      binding: "ASSETS",
    });

    expect(artifact.kind).toBe("bundle");
    if (!("bundle" in artifact.upload)) throw new Error("expected bundle");
    expect(artifact.upload.bundle.assets?.files[0]).toEqual(
      expect.objectContaining({
        path: "/large.bin",
        encoding: "base64",
        contentType: "application/octet-stream",
      }),
    );
  });

  test("rejects missing relative modules and static website assets", () => {
    const root = directory();
    writeFileSync(
      join(root, "worker.js"),
      'import "./missing.js"; export default {};',
    );
    expect(() => loadWorkerArtifact(root, "worker.js")).toThrow(
      "imports that are not in the Artifact",
    );

    writeFileSync(join(root, "missing.js"), "export {};");
    writeFileSync(join(root, "index.html"), "<h1>site</h1>");
    expect(() => loadWorkerArtifact(root, "worker.js")).toThrow(
      "static-assets workflow",
    );
  });
});

test("routes a large single module through the multipart bundle channel, with or without assets", () => {
  const root = directory();
  const source = "/*" + "x".repeat(2 * 1024 * 1024) + "*/ export default {};";
  const path = join(root, "worker.mjs");
  writeFileSync(path, source);
  const artifact = loadWorkerArtifact(path);
  expect(artifact.kind).toBe("bundle");
  if (!("bundle" in artifact.upload)) throw Error("bundle");
  expect(artifact.upload.bundle.modules[0].content).toBe(source);
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<h1>large worker</h1>");
  const withAssets = loadWorkerArtifact(path, undefined, {
    directory: assets,
    binding: "ASSETS",
  });
  if (!("bundle" in withAssets.upload)) throw Error("bundle");
  expect(withAssets.upload.bundle.modules[0].content).toBe(source);
  expect(withAssets.upload.bundle.assets?.files).toHaveLength(1);
});

test("accepts more than 200 directory modules", () => {
  const root = directory();
  writeFileSync(join(root, "index.js"), "export default {};");
  for (let i = 0; i < 300; i++)
    writeFileSync(join(root, `${i}.js`), "export {};");
  const artifact = loadWorkerArtifact(root, "index.js");
  if (!("bundle" in artifact.upload)) throw Error("bundle");
  expect(artifact.upload.bundle.modules).toHaveLength(301);
});
