import { describe, expect, test } from "bun:test";
import { planWorkerVariables, readWorkerArtifactVariableConfiguration, readWorkerVariableState, workerVariableDeclaration, workerArtifactBindingNames } from "../workers-variable-plan.ts";

describe("Worker public variable decisions", () => {
  test("native prototype-like variable names cannot inherit a varTypes entry", () => {
    const vars = JSON.parse('{"constructor":"normal","__proto__":"normal","toString":"normal","hasOwnProperty":"normal","J":"json-string"}');
    const declaration = workerVariableDeclaration({ vars, varTypes: { J: "json" } });
    const plan = planWorkerVariables(declaration, []);
    expect(plan.find(item => item.name === "J")?.type).toBe("json");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(plan.find(item => item.name === name)).toMatchObject({ type: "plain_text", decision: "SET" });
    const typedProto = workerVariableDeclaration({ vars, varTypes: JSON.parse('{"__proto__":"json","constructor":"json"}') });
    expect(typedProto.variables.find(item => item.name === "__proto__")?.type).toBe("json");
    expect(typedProto.variables.find(item => item.name === "constructor")?.type).toBe("json");
  });
  test("sets explicit vars, preserves JSON-string types and never exposes values", () => {
    const declaration = workerVariableDeclaration({
      vars: { TEXT: "private-marker", JSON_STRING: "private-json-marker", OBJECT: { nested: "private-object-marker" } },
      varTypes: { JSON_STRING: "json" }, keepBindings: ["plain_text", "json"],
    });
    const plan = planWorkerVariables(declaration, [{ name: "TEXT", type: "plain_text" }, { name: "JSON_STRING", type: "plain_text" }]);
    expect(plan.map(({ name, decision, type }) => ({ name, decision, type }))).toEqual([
      { name: "JSON_STRING", decision: "REPLACE", type: "json" },
      { name: "OBJECT", decision: "SET", type: "json" },
      { name: "TEXT", decision: "SET", type: "plain_text" },
    ]);
    expect(JSON.stringify({ declaration, plan })).not.toContain("private-");
  });

  test.each(["plain_text", "json"] as const)("retains only native %s vars", type => {
    const other = type === "json" ? "plain_text" : "json";
    const plan = planWorkerVariables(workerVariableDeclaration({ keepBindings: [type] }), [
      { name: "KEEP", type }, { name: "DROP", type: other },
    ]);
    expect(plan.map(({ name, decision }) => ({ name, decision }))).toEqual([
      { name: "DROP", decision: "REMOVE" }, { name: "KEEP", decision: "RETAIN" },
    ]);
  });

  test("explicit resource, Secret, assets and version metadata replace retained vars", () => {
    const names = ["RESOURCE", "SECRET", "ASSETS", "VERSION"];
    const declaration = workerVariableDeclaration({ keepBindings: ["plain_text", "json"] }, ["ASSETS", "VERSION"]);
    const plan = planWorkerVariables(declaration, names.map(name => ({ name, type: "json" })), ["RESOURCE", "SECRET"]);
    expect(plan).toHaveLength(4);
    expect(plan.every(item => item.decision === "REPLACE" && item.currentType === "json" && !item.type)).toBe(true);
    expect(planWorkerVariables(workerVariableDeclaration({}), [])).toEqual([]);
  });

  test("rejects an explicit public variable colliding with a preserved Secret or resource", () => {
    const declaration = workerVariableDeclaration({ vars: { OCCUPIED: "private-marker" } });
    expect(() => planWorkerVariables(declaration, [], ["OCCUPIED"])).toThrow("conflicts with an explicit binding");
  });

  test("environment public bindings are explicit SET, non-public bindings replace and values stay private", () => {
    const plan = planWorkerVariables(workerVariableDeclaration({}), [
      { name: "PUBLIC", type: "plain_text" }, { name: "NATIVE", type: "json" },
    ], [], [
      { name: "PUBLIC", type: "plain_text", text: "private-marker" },
      { name: "JSON_STRING", type: "json", json: "private-json-marker" },
      { name: "NATIVE", type: "service", service: "private-service-marker" },
      { name: "XAPI_AI_BASE_URL", type: "plain_text", text: "private-platform-marker" },
    ]);
    expect(plan.map(({ name, decision, type }) => ({ name, decision, type }))).toEqual([
      { name: "JSON_STRING", decision: "SET", type: "json" },
      { name: "NATIVE", decision: "REPLACE", type: undefined },
      { name: "PUBLIC", decision: "SET", type: "plain_text" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("private-");
    expect(plan.every(item => item.message.startsWith("If deployment occurs"))).toBe(true);
    expect(() => planWorkerVariables(workerVariableDeclaration({ vars: { PUBLIC: "value" } }), [], [], [{ name: "PUBLIC", type: "json" }])).toThrow("conflicts with an environment binding");
    expect(() => planWorkerVariables(workerVariableDeclaration({}), [], [], {})).toThrow("invalid environment bindings");
  });

  test("internal Container resource IDs do not occupy native binding names", () => {
    const name = "CONTAINER_14C2529EB4498C5D1FFD6915D05BF58A91BDDA796AF59F41D480D11C099D0479";
    const artifact = { containers: [{ name: "api" }], assets: { binding: "ASSETS" }, versionMetadata: { binding: "VERSION" } };
    const bindingNames = workerArtifactBindingNames(artifact);
    expect(bindingNames).toEqual(["ASSETS", "VERSION"]);
    const declaration = workerVariableDeclaration({ vars: { [name]: "legitimate-public-var" }, keepBindings: ["plain_text"] }, bindingNames);
    const plan = planWorkerVariables(declaration, [{ name, type: "plain_text" }, { name: "ACTUAL_DO", type: "plain_text" }], ["ACTUAL_DO", "ACTUAL_DO"]);
    expect(plan).toHaveLength(2);
    expect(plan.find(item => item.name === name)).toMatchObject({ decision: "SET", type: "plain_text" });
    expect(plan.find(item => item.name === "ACTUAL_DO")?.decision).toBe("REPLACE");
    expect(planWorkerVariables(workerVariableDeclaration({ keepBindings: ["plain_text"] }, bindingNames), [{ name, type: "plain_text" }])[0].decision).toBe("RETAIN");
  });

  test("rejects incomplete, mismatched and missing native state", () => {
    const state = { environment: "preview", activeDeploymentId: "active", exists: true, variables: [] };
    expect(readWorkerVariableState(state, "preview", "active")).toEqual([]);
    for (const change of [
      { environment: "production" }, { activeDeploymentId: "other" }, { activeDeploymentId: undefined },
      { exists: false }, { variables: undefined }, { variables: [{ name: "A", type: "secret_text" }] },
      { variables: [{ name: "A", type: "json" }, { name: "A", type: "json" }] },
    ]) expect(() => readWorkerVariableState({ ...state, ...change }, "preview", "active")).toThrow();
    expect(readWorkerVariableState({ ...state, activeDeploymentId: null, exists: false }, "preview", null)).toEqual([]);
  });

  test("validates immutable identity and strips unexpected response values", () => {
    const data = { artifactId: "selected", contentSha256: "a".repeat(64), keepBindings: ["json"],
      variables: [{ name: "JSON", type: "json", value: "private-marker" }], bindingNames: ["ASSETS"] };
    const result = readWorkerArtifactVariableConfiguration(data, "selected", data.contentSha256);
    expect(JSON.stringify(result)).not.toContain("private-marker");
    expect(() => readWorkerArtifactVariableConfiguration(data, "other", data.contentSha256)).toThrow();
    expect(() => readWorkerArtifactVariableConfiguration(data, "selected", "b".repeat(64))).toThrow();
    for (const change of [{ variables: undefined }, { keepBindings: undefined }, { bindingNames: undefined }, { keepBindings: ["secret_text"] }])
      expect(() => readWorkerArtifactVariableConfiguration({ ...data, ...change }, "selected", data.contentSha256)).toThrow();
  });
});
