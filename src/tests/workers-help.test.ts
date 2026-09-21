import { describe, expect, test } from "bun:test";
import {
  WORKERS_HELP,
  WORKERS_INIT_HELP,
  WORKERS_RESOURCES_HELP,
} from "../commands/workers.ts";

describe("Workers focused help", () => {
  test("init help separates new, frontend, Wrangler, and Next SSR paths", () => {
    expect(WORKERS_INIT_HELP).toContain("New Worker");
    expect(WORKERS_INIT_HELP).toContain("Existing React, Vite, Vue");
    expect(WORKERS_INIT_HELP).toContain("Existing Worker with Wrangler");
    expect(WORKERS_INIT_HELP).toContain("Next.js SSR");
    expect(WORKERS_INIT_HELP).toContain("--build-command");
    expect(WORKERS_INIT_HELP).toContain("--build-output");
    expect(WORKERS_INIT_HELP).toContain("--build-main");
    expect(WORKERS_INIT_HELP).toContain("Re-running init is not a");
  });

  test("resource help distinguishes every project state transition", () => {
    expect(WORKERS_RESOURCES_HELP).toContain(
      "xapi.worker.json is desired state",
    );
    for (const command of ["add", "update", "pull", "remove", "destroy"]) {
      expect(WORKERS_RESOURCES_HELP).toContain(`  ${command}`);
    }
    expect(WORKERS_RESOURCES_HELP).toContain("requires --yes");
    expect(WORKERS_RESOURCES_HELP).toContain("without updating the");
    expect(WORKERS_RESOURCES_HELP).toContain("cannot be updated in place");
  });

  test("top-level help separates the normal project flow from primitives", () => {
    expect(WORKERS_HELP).toContain("NORMAL PROJECT WORKFLOW (recommended)");
    expect(WORKERS_HELP).toContain("ADVANCED ARTIFACT PRIMITIVES");
    expect(WORKERS_HELP).toContain("init -> plan -> push -> promote");
    expect(WORKERS_HELP).toContain("build creates an Artifact");
    expect(WORKERS_HELP).toContain("deploy activates an existing Artifact");
    expect(WORKERS_HELP).toContain("There is no workers inspect command");
  });
});
