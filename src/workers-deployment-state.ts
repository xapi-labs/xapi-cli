import { createHash } from "node:crypto";

type Row = Record<string, unknown>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const sorted = (rows: Row[]) => rows.sort((a, b) => String(a.bindingName).localeCompare(String(b.bindingName)));

// Only deployment inputs: polling timestamps, storage size and other changing
// Provider observations must not cause deployments. No secret plaintext is read.
export function deploymentPrefix(workerId: string, environment: string, artifactId: string,
  compatibility: { compatibilityDate?: string; compatibilityFlags?: string[] },
  environmentState: Row, resources: Row[], secrets: Row[]): string {
  return `v2-${hash({ workerId, environment: environment.toLowerCase(), artifactId,
    compatibilityDate: compatibility.compatibilityDate,
    compatibilityFlags: [...(compatibility.compatibilityFlags || [])].sort(),
    bindings: environmentState.bindings || [],
    resources: sorted(resources.map(r => {
      const config = (r.config || {}) as Row;
      return { id: r.id, bindingName: r.bindingName, type: r.type,
        providerResourceId: r.providerResourceId, providerResourceName: r.providerResourceName,
        className: config.className, state: config.state,
        status: r.status === "PROVISIONING" ? "ACTIVE" : r.status };
    })),
    secrets: sorted(secrets.map(s => ({ bindingName: s.bindingName, version: s.version }))),
  })}-`;
}

export function currentMatchingDeployment(deployments: Row[], environmentState: Row,
  artifactId: string, prefix: string): Row | undefined {
  return deployments.find(d => d.id === environmentState.activeDeploymentId &&
    d.environmentId === environmentState.id && d.artifactId === artifactId &&
    d.status === "ACTIVE" && typeof d.idempotencyKey === "string" && d.idempotencyKey.startsWith(prefix));
}

// Scope to the previous activation: returning to an older configuration must
// create a fresh deployment, not replay an inactive historical one.
export function deploymentKey(prefix: string, environmentState: Row): string {
  return prefix + hash(environmentState.activeDeploymentId || "initial").slice(0, 32);
}
