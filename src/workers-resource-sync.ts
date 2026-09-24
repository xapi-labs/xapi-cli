import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  WorkerProjectConfigError,
  workerManagedResourceSchema,
} from "./workers-project.ts";
import type { WorkerDesiredResource as Resource } from "./workers-resource-state.ts";

type Baseline = { local: Resource[]; remote: Resource[] };
type State = {
  version: 1;
  environments: Partial<Record<"preview" | "production", Baseline>>;
};

export function sameResource(
  a: Resource | undefined,
  b: Resource | undefined,
): boolean {
  const value = (item: Resource | undefined) =>
    item && Object.entries(item).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(value(a)) === JSON.stringify(value(b));
}

/** Metadata only. The baseline is scoped to this file, API host and Worker. */
export function resourceSyncState(
  configPath: string,
  apiHost: string,
  workerId: string,
) {
  const key = createHash("sha256")
    .update(JSON.stringify([configPath, apiHost, workerId]))
    .digest("hex")
    .slice(0, 24);
  const path = join(dirname(configPath), ".xapi", `resource-sync-${key}.json`);
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  let state: State = { version: 1, environments: {} };
  if (original) {
    try {
      const parsed = JSON.parse(original);
      if (
        parsed.version !== 1 ||
        !parsed.environments ||
        typeof parsed.environments !== "object"
      )
        throw new Error();
      for (const [environment, baseline] of Object.entries(
        parsed.environments,
      ) as Array<[string, Baseline]>) {
        if (!["preview", "production"].includes(environment) || !baseline)
          throw new Error();
        for (const entries of [baseline.local, baseline.remote]) {
          if (
            !Array.isArray(entries) ||
            new Set(entries.map((r) => r.bindingName)).size !== entries.length
          )
            throw new Error();
          for (const resource of entries)
            workerManagedResourceSchema.parse(resource);
        }
      }
      state = parsed;
    } catch {
      throw new WorkerProjectConfigError(
        "worker_resource_sync_invalid",
        "Resource sync baseline is invalid; preserve it for inspection before starting a fresh pull",
      );
    }
  }
  const assertUnchanged = () => {
    const latest = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (latest !== original)
      throw new WorkerProjectConfigError(
        "worker_resource_sync_changed",
        "Another resource pull updated the baseline; run pull again",
      );
  };
  return {
    state,
    assertUnchanged,
    save() {
      assertUnchanged();
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path);
    },
  };
}

export function mergeResourceChanges(
  local: Resource[],
  remote: Resource[],
  base: Baseline,
  environment: string,
): Resource[] {
  const byName = (rows: Resource[]) =>
    new Map(rows.map((row) => [row.bindingName, row]));
  const currentLocal = byName(local),
    currentRemote = byName(remote);
  const oldLocal = byName(base.local),
    oldRemote = byName(base.remote);
  const merged = new Map(currentLocal);
  for (const name of new Set([...oldRemote.keys(), ...currentRemote.keys()])) {
    const next = currentRemote.get(name),
      desired = currentLocal.get(name);
    if (sameResource(next, oldRemote.get(name))) continue;
    const localChanged = !sameResource(desired, oldLocal.get(name));
    if (localChanged && !sameResource(desired, next)) {
      throw new WorkerProjectConfigError(
        "worker_project_resource_pull_conflict",
        `${environment} binding ${name} changed both locally and remotely since the last pull; neither side was overwritten`,
      );
    }
    if (next) merged.set(name, next);
    else merged.delete(name);
  }
  return [...merged.values()];
}
