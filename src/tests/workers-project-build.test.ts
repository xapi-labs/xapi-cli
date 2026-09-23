import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerProject } from "../workers-project.ts";
import { loadWorkerProjectBundle } from "../workers-project-build.ts";
import { loadWorkerArtifactInput } from "../workers-artifact.ts";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const container = {
  name: "api",
  className: "ApiContainer",
  image: "docker.io/example/api:v1",
  instanceType: "lite" as const,
  maxInstances: 2,
  rolloutActiveGracePeriod: 0,
};

function project(native: boolean, withContainer = true) {
  const root = mkdtempSync(join(tmpdir(), "container-project-build-"));
  roots.push(root);
  const output = native ? "worker.bundle" : "worker.mjs";
  const source =
    'export class ApiContainer {}\nexport default { fetch() { return new Response("ok"); } };';
  const settings = {
    main_module: "worker.mjs",
    compatibility_date: "2026-09-10",
    bindings: [
      {
        name: "API_CONTAINER",
        type: "durable_object_namespace",
        class_name: container.className,
      },
    ],
    containers: [
      {
        name: "wrangler-generated-apicontainer",
        class_name: container.className,
      },
    ],
  };
  writeFileSync(
    join(root, output),
    native
      ? `--test-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(settings)}\r\n--test-boundary\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n${source}\r\n--test-boundary--\r\n`
      : source,
  );
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({ compatibility_date: "2026-09-10" }),
  );
  const environment = {
    dailyBudgetUsd: 0.25,
    resources: [
      {
        type: "durable_object",
        bindingName: "API_CONTAINER",
        className: "ApiContainer",
      },
    ],
  };
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify({
      version: 1,
      worker: { name: "Container build", slug: "container-build" },
      wrangler: "wrangler.jsonc",
      build: { command: "unused", output },
      ...(withContainer ? { containers: [container] } : {}),
      environments: { preview: environment, production: environment },
    }),
  );
  return loadWorkerProject(root);
}

for (const native of [false, true]) {
  test(`project build preserves Container intent and artifact identity (${native ? "native bundle" : "module"})`, async () => {
    const config = project(native);
    const actual = await loadWorkerProjectBundle(config, "preview");
    const expected = await loadWorkerArtifactInput(
      join(config.rootDir, config.config.build.output),
      undefined,
      undefined,
      [container],
    );
    expect(actual.upload).toEqual(expected.upload);
    expect(actual.contentSha256).toBe(expected.contentSha256);
    expect(actual.sizeBytes).toBe(expected.sizeBytes);
    if (!("bundle" in actual.upload))
      throw new Error("Container requires bundle");
    expect(actual.upload.bundle.containers).toEqual([container]);
  });
}
test("native Container class without explicit project intent remains rejected", async () => {
  await expect(
    loadWorkerProjectBundle(project(true, false), "preview"),
  ).rejects.toThrow("Container classes differ");
});
