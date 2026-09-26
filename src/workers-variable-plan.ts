import type { WorkerVariableOptions, WorkerVariableType } from "./workers-artifact.ts";
import { normalizeWorkerVariableOptions } from "./workers-artifact.ts";
import { WorkerProjectConfigError } from "./workers-project.ts";

export interface WorkerVariableMetadata {
  name: string;
  type: WorkerVariableType;
}

export interface WorkerVariableDeclaration {
  keepBindings: WorkerVariableType[];
  variables: WorkerVariableMetadata[];
  bindingNames: string[];
}

export interface WorkerVariableDecision {
  name: string;
  decision: "SET" | "RETAIN" | "REMOVE" | "REPLACE";
  currentType?: WorkerVariableType;
  type?: WorkerVariableType;
  message: string;
}

function invalid(message: string): never {
  throw new WorkerProjectConfigError("worker_plan_invalid_response", message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("xAPI returned invalid variable metadata");
  return value as Record<string, unknown>;
}

function variableType(value: unknown): value is WorkerVariableType {
  return value === "plain_text" || value === "json";
}

function variables(value: unknown): WorkerVariableMetadata[] {
  if (!Array.isArray(value)) return invalid("xAPI returned missing variable metadata");
  const names = new Set<string>();
  return value.map(item => {
    const entry = record(item);
    if (typeof entry.name !== "string" || !entry.name || !variableType(entry.type) || names.has(entry.name))
      return invalid("xAPI returned invalid or duplicate variable metadata");
    names.add(entry.name);
    // Copy only the public metadata, even if a response unexpectedly contains values.
    return { name: entry.name, type: entry.type };
  });
}

/**
 * Native state is a moment-of-read snapshot. The deployment ID detects xAPI
 * deployment races only; external provider edits need not change that ID.
 * This metadata informs management plans, never website request handling.
 */
export function readWorkerVariableState(
  value: unknown,
  environment: "preview" | "production",
  activeDeploymentId: string | null,
): WorkerVariableMetadata[] {
  const state = record(value);
  if (state.environment !== environment || typeof state.exists !== "boolean" ||
      !(state.activeDeploymentId === null || typeof state.activeDeploymentId === "string" && state.activeDeploymentId.length > 0))
    return invalid("xAPI returned invalid Worker variable state");
  if (state.activeDeploymentId !== activeDeploymentId)
    return invalid("Worker deployment changed while reading variable state; rerun the plan");
  const result = variables(state.variables);
  if (!state.exists && (activeDeploymentId !== null || result.length > 0))
    return invalid("Native Worker variable state is missing for the selected deployment");
  return result;
}

export function readWorkerArtifactVariableConfiguration(
  value: unknown,
  artifactId: string,
  contentSha256: string,
): WorkerVariableDeclaration {
  const declaration = record(value);
  if (declaration.artifactId !== artifactId || declaration.contentSha256 !== contentSha256)
    return invalid("Variable configuration does not match the selected immutable Artifact");
  if (!Array.isArray(declaration.keepBindings) || !declaration.keepBindings.every(variableType) ||
      !Array.isArray(declaration.bindingNames) || !declaration.bindingNames.every(name => typeof name === "string" && name.length > 0))
    return invalid("xAPI returned invalid Artifact variable configuration");
  return {
    keepBindings: [...new Set(declaration.keepBindings)],
    variables: variables(declaration.variables),
    bindingNames: [...new Set(declaration.bindingNames as string[])],
  };
}

export function workerVariableDeclaration(
  input: WorkerVariableOptions,
  bindingNames: string[] = [],
): WorkerVariableDeclaration {
  const normalized = normalizeWorkerVariableOptions(input);
  return {
    keepBindings: normalized.keepBindings || [],
    variables: Object.entries(normalized.vars || {}).map(([name, value]) => ({
      name,
      type: normalized.varTypes?.[name] === "json" || typeof value !== "string" ? "json" : "plain_text",
    })),
    bindingNames: [...new Set(bindingNames)],
  };
}

export function workerArtifactBindingNames(
  bundle: { assets?: { binding?: string }; versionMetadata?: { binding: string } },
): string[] {
  return [...new Set([
    bundle.assets?.binding,
    bundle.versionMetadata?.binding,
  ].filter((name): name is string => !!name))];
}

/** Describe native upload semantics using names and types only; never compare values. */
export function planWorkerVariables(
  declaration: WorkerVariableDeclaration,
  current: WorkerVariableMetadata[],
  bindingNames: string[] = [],
  environmentBindings: unknown = [],
): WorkerVariableDecision[] {
  const desired = new Map(declaration.variables.map(variable => [variable.name, variable.type]));
  const previous = new Map(current.map(variable => [variable.name, variable.type]));
  const occupied = new Set([...declaration.bindingNames, ...bindingNames]);
  const environmentVars = new Set<string>();
  if (!Array.isArray(environmentBindings)) return invalid("xAPI returned invalid environment bindings");
  const environmentNames = new Set<string>();
  for (const value of environmentBindings) {
    const binding = record(value);
    if (typeof binding.name !== "string" || !binding.name || typeof binding.type !== "string" || !binding.type || environmentNames.has(binding.name))
      return invalid("xAPI returned invalid or duplicate environment bindings");
    environmentNames.add(binding.name);
    // The backend excludes this platform-owned variable from its public state.
    if (variableType(binding.type) && binding.name !== "XAPI_AI_BASE_URL") {
      if (desired.has(binding.name)) return invalid("Artifact public variable conflicts with an environment binding");
      desired.set(binding.name, binding.type);
      environmentVars.add(binding.name);
    } else {
      occupied.add(binding.name);
    }
  }
  const keep = new Set(declaration.keepBindings);
  return [...new Set([...desired.keys(), ...previous.keys()])].sort().map(name => {
    const currentType = previous.get(name);
    const type = desired.get(name);
    const base = { name, ...(currentType ? { currentType } : {}) };
    if (occupied.has(name)) {
      if (type) return invalid("Artifact public variable conflicts with an explicit binding");
      return { ...base, decision: "REPLACE", message: "If deployment occurs, the explicit binding replaces the public variable; its value is not retained" };
    }
    if (type) return {
      ...base, type,
      decision: currentType && currentType !== type ? "REPLACE" : "SET",
      message: `If deployment occurs, set the value declared by ${environmentVars.has(name) ? "the environment binding" : "the Artifact"}; values are not displayed or compared`,
    };
    if (keep.has(currentType!)) return {
      ...base, type: currentType!, decision: "RETAIN",
      message: "If deployment occurs, retain the native public variable by binding type without reading or replaying its value",
    };
    return { ...base, decision: "REMOVE", message: "If deployment occurs, remove the undeclared public variable; its binding type is not retained" };
  });
}
