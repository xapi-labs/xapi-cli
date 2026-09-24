import { expect, test } from "bun:test";
import { ensureActiveDeployment } from "../workers-push.ts";
import { deploymentPrefix } from "../workers-deployment-state.ts";
import { RequestTimeoutError } from "../client.ts";

function platform() {
  const environment = { id: "env", name: "PREVIEW", activeDeploymentId: null as string | null, bindings: [], placementMode: "off" };
  const resources: Record<string, unknown>[] = [];
  const secrets: Record<string, unknown>[] = [];
  const deployments: Record<string, unknown>[] = [];
  let failOnce = false;
  const api = {
    getWorker: async () => ({ id: "worker", environments: [environment], deployments }),
    listWorkerResources: async () => resources,
    listWorkerSecrets: async () => secrets,
    deployWorker: async (_options: unknown, _id: string, input: Record<string, unknown>) => {
      const d = { ...input, id: `d${deployments.length}`, environmentId: "env", status: "ACTIVE" };
      deployments.push(d);
      environment.activeDeploymentId = d.id;
      if (failOnce) { failOnce = false; throw new RequestTimeoutError(1000); }
      return d;
    },
  };
  const run = (date = "2026-09-07", artifact = "same-artifact") => ensureActiveDeployment(api, { apiHost: "localhost:3148", apiKey: "test" }, "worker", artifact,
    "preview", { compatibilityDate: date, compatibilityFlags: [] }, async () => {});
  return { run, resources, secrets, deployments, environment, uncertain: () => { failOnce = true; } };
}

test("same code: add, replace and explicitly remove bindings deploy; unchanged repeats do not", async () => {
  const p = platform();
  const first = await p.run();
  expect((await p.run()).deployment.id).toBe(first.deployment.id);
  p.resources.push({ id: "resource", bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE", providerResourceId: "kv1" });
  const added = await p.run();
  expect(added.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(added.deployment.id);
  p.resources[0].providerResourceId = "kv2";
  const replaced = await p.run();
  expect(replaced.deployment.id).not.toBe(added.deployment.id);
  p.resources.length = 0;
  const removed = await p.run();
  expect(removed.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(removed.deployment.id);
  expect(p.deployments).toHaveLength(4);
});

test("compatibility changes deploy; independent Secret changes do not redeploy code", async () => {
  const p = platform();
  await p.run();
  await p.run("2026-09-06");
  p.secrets.push({ bindingName: "TOKEN", version: 1 });
  await p.run("2026-09-06");
  p.secrets[0].version = 2;
  await p.run("2026-09-06");
  await p.run("2026-09-06");
  expect(p.deployments).toHaveLength(2);
  expect(new Set(p.deployments.map(d => d.artifactId)).size).toBe(1);
});

test("historical ACTIVE artifact is not mistaken for the current activation; lost response reconciles", async () => {
  const p = platform();
  await p.run();
  await p.run("2026-09-07", "other-artifact");
  p.uncertain();
  const restored = await p.run();
  expect(restored.deployment.id).toBe("d2");
  expect((await p.run()).deployment.id).toBe("d2");
  expect(p.deployments).toHaveLength(3);
  expect(restored.idempotencyKey.length).toBeLessThanOrEqual(128);
});

test("fingerprint ignores polling noise and resource order, but includes environment bindings", () => {
  const fingerprint = (resources: Record<string, unknown>[], bindings: unknown[] = []) =>
    deploymentPrefix("worker", "preview", "artifact", {}, { bindings }, resources, []);
  const a = { id: "1", bindingName: "A", type: "D1_DATABASE", status: "ACTIVE", config: { file_size: 10 } };
  const b = { id: "2", bindingName: "B", type: "KV_NAMESPACE", status: "ACTIVE" };
  expect(fingerprint([a, b])).toBe(fingerprint([b, { ...a, updatedAt: "later", config: { file_size: 20 } }]));
  expect(fingerprint([a])).not.toBe(fingerprint([a], [{ type: "plain_text", name: "MODE", text: "new" }]));
});


test("placement changes deploy the same artifact once, including returning to off", async () => {
  const p = platform();
  const first = await p.run();
  p.environment.placementMode = "smart";
  const smart = await p.run();
  expect(smart.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(smart.deployment.id);
  p.environment.placementMode = "off";
  const off = await p.run();
  expect(off.deployment.id).not.toBe(smart.deployment.id);
  expect(off.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(off.deployment.id);
  expect(p.deployments).toHaveLength(3);
});

test("missing placement uses the native off default", () => {
  const prefix = (state: Record<string, unknown>) => deploymentPrefix("worker", "preview", "artifact", {}, state, [], []);
  expect(prefix({})).toBe(prefix({ placementMode: "off" }));
  expect(prefix({})).not.toBe(prefix({ placementMode: "smart" }));
});
