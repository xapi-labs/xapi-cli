import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkerProject } from "../workers-init.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function init(template: string) {
  const root = mkdtempSync(join(tmpdir(), "xapi-agent-onboarding-"));
  roots.push(root);
  return initWorkerProject({ cwd: root, target: template, template });
}

describe("Agent/Chat generated setup requirements", () => {
  for (const template of ["agent", "chat"]) {
    test(`${template} explains the generated toolchain and works without a global CLI`, () => {
      const project = init(template);
      const pkg = JSON.parse(readFileSync(join(project.rootDir, "package.json"), "utf8"));
      const readme = readFileSync(join(project.rootDir, "README.md"), "utf8");
      const guide = readFileSync(join(project.rootDir, "TEMPLATE.md"), "utf8");
      expect(pkg.engines.node).toBe(">=22.12.0");
      expect(readme).toContain("Node.js 22.12.0");
      expect(guide).toContain("Node.js 22.12.0");
      expect(guide).toContain("npm install");
      expect(guide).toContain("unreleased local checkout");
      expect(guide).toContain("node /absolute/path/to/xapi-cli/dist/index.js");
      expect(guide).toMatch(/A local package version is not\s+proof/);
      expect(guide).toContain("npx xapi-to workers create");
      expect(guide).not.toMatch(/^xapi workers /m);
      expect(project.nextSteps).toContain("node --version");
      expect(project.nextSteps).toContain("npx xapi-to workers create --config xapi.worker.json");
      expect(project.nextSteps).not.toContain("xapi workers plan --env preview");
      // a key-free local plan first, then each Secret after create returns the Worker ID
      const steps = project.nextSteps.join("\n");
      expect(steps).toContain("workers plan --env preview --local");
      expect(steps.indexOf("workers create")).toBeLessThan(steps.indexOf("secrets set <worker-id> APP_TOKEN"));
      expect(steps).toContain("secrets set <worker-id> MODEL_KEY --env preview --from-env MODEL_KEY");
      expect(project.budgets).toEqual({
        preview: { dailyBudgetUsd: 0.25 },
        production: { dailyBudgetUsd: null },
      });
    });
  }
  test("ordinary templates keep their existing requirements and steps", () => {
    const project = init("worker");
    const pkg = JSON.parse(readFileSync(join(project.rootDir, "package.json"), "utf8"));
    expect(pkg.engines).toBeUndefined();
    expect(project.nextSteps).toContain("npm run dev");
    expect(project.nextSteps).toContain("xapi workers plan --env preview");
    expect(project.nextSteps).not.toContain("node --version");
  });
});
