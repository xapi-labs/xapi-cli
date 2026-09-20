import { describe, expect, test } from "bun:test";
import {
  WORKERS_INIT_HELP,
  WORKERS_RESOURCES_HELP,
} from "../commands/workers.ts";

describe("Workers focused help", () => {
  test("init help separates new, frontend, Wrangler, and Next SSR paths", () => {
    expect(WORKERS_INIT_HELP).toContain("New Worker");
    expect(WORKERS_INIT_HELP).toContain("Existing React, Vite, Vue");
    expect(WORKERS_INIT_HELP).toContain("Existing Worker with Wrangler");
    expect(WORKERS_INIT_HELP).toContain("Next.js SSR");
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
});
