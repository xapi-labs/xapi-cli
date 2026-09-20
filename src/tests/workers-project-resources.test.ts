import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkerProject } from "../workers-init.ts";
import {
  addProjectResource,
  destroyProjectResource,
  pullProjectResources,
  removeProjectResource,
  updateProjectResource,
} from "../workers-project-resources.ts";
import { loadWorkerProject } from "../workers-project.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "xapi-resource-edit-")));
  roots.push(parent);
  return initWorkerProject({ cwd: parent, target: "demo" }).rootDir;
}

function linkedProject(): string {
  const root = project();
  const path = join(root, "xapi.worker.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.workerId = "12345678-1234-4234-8234-123456789abc";
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

describe("project resource declarations", () => {
  test("adds one declaration to both environments and is idempotent", () => {
    const root = project();
    const first = addProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      resource: {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "auto",
      },
    });
    expect(first.changed).toBe(true);
    const second = addProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      resource: {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "auto",
      },
    });
    expect(second.changed).toBe(false);
    const config = loadWorkerProject(root).config;
    expect(config.environments.preview.resources).toEqual([
      {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "auto",
      },
    ]);
    expect(config.environments.production.resources).toEqual(
      config.environments.preview.resources,
    );
  });

  test("rejects binding conflicts and invalid resource-specific fields", () => {
    const root = project();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "kv_namespace", bindingName: "STATE" },
    });
    expect(() =>
      addProjectResource({
        cwd: root,
        environments: ["preview"],
        resource: { type: "r2_bucket", bindingName: "STATE" },
      }),
    ).toThrow("already declares kv_namespace");
    expect(() =>
      addProjectResource({
        cwd: root,
        environments: ["preview"],
        resource: { type: "durable_object", bindingName: "ROOM" },
      }),
    ).toThrow("className");
  });

  test("removes declarations without pretending the remote resource was deleted", () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      resource: { type: "r2_bucket", bindingName: "FILES" },
    });
    const result = removeProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      bindingName: "FILES",
    });
    expect(result.nextSteps).toContain(
      "Delete its data after backup: xapi workers resources destroy --env preview --binding FILES --yes",
    );
    expect(result.nextSteps).not.toContain("xapi workers push --env preview");
    const config = loadWorkerProject(root).config;
    expect(config.environments.preview.resources).toEqual([]);
    expect(config.environments.production.resources).toEqual([]);
  });

  test("removes an undeployed declaration without suggesting remote destruction", () => {
    const root = project();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "kv_namespace", bindingName: "CACHE" },
    });
    const result = removeProjectResource({
      cwd: root,
      environments: ["preview"],
      bindingName: "CACHE",
    });
    expect(result.nextSteps).toEqual([
      "xapi workers plan --env preview",
      "xapi workers push --env preview",
    ]);
  });

  test("updates a complete local declaration atomically", () => {
    const root = project();
    addProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      resource: {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "disabled",
      },
    });
    const result = updateProjectResource({
      cwd: root,
      environments: ["preview", "production"],
      resource: {
        type: "d1_database",
        bindingName: "DB",
        location: "weur",
        readReplication: "auto",
      },
    });
    expect(result.changed).toBe(true);
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([
      {
        type: "d1_database",
        bindingName: "DB",
        location: "weur",
        readReplication: "auto",
      },
    ]);
    expect(loadWorkerProject(root).config.environments.production.resources).toEqual(
      loadWorkerProject(root).config.environments.preview.resources,
    );
  });

  test("rejects missing, type-changing, and Durable Object class updates", () => {
    const root = linkedProject();
    expect(() =>
      updateProjectResource({
        cwd: root,
        environments: ["preview"],
        resource: { type: "kv_namespace", bindingName: "CACHE" },
      }),
    ).toThrow("use resources add first");
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: {
        type: "durable_object",
        bindingName: "ROOM",
        className: "Room",
      },
    });
    expect(() =>
      updateProjectResource({
        cwd: root,
        environments: ["preview"],
        resource: { type: "kv_namespace", bindingName: "ROOM" },
      }),
    ).toThrow("changing a resource type in place is unsafe");
    expect(() =>
      updateProjectResource({
        cwd: root,
        environments: ["preview"],
        resource: {
          type: "durable_object",
          bindingName: "ROOM",
          className: "AnotherRoom",
        },
      }),
    ).toThrow("create a new binding and migrate state");
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([
      {
        type: "durable_object",
        bindingName: "ROOM",
        className: "Room",
      },
    ]);
  });

  test("allows a complete type correction before a project is linked", () => {
    const root = project();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "kv_namespace", bindingName: "CACHE" },
    });
    updateProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "r2_bucket", bindingName: "CACHE", location: "apac" },
    });
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([
      { type: "r2_bucket", bindingName: "CACHE", location: "apac" },
    ]);
  });

  test("pulls remote-only resources into desired state without provider IDs", async () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "kv_namespace", bindingName: "LOCAL_PENDING" },
    });
    const result = await pullProjectResources({
      cwd: root,
      environments: ["preview"],
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: {
        listWorkerResources: async () => [
          {
            id: "provider-id-must-not-be-written",
            bindingName: "FILES",
            type: "R2_BUCKET",
            status: "ACTIVE",
            config: {
              requestedLocation: "APAC",
              created_in_region: "APAC",
            },
          },
          {
            bindingName: "ROOM",
            type: "DURABLE_OBJECT",
            status: "PROVISIONING",
            config: { className: "Room" },
          },
        ],
      },
    });
    expect(result.changed).toBe(true);
    expect(result.environments[0]?.added).toEqual(["FILES", "ROOM"]);
    const text = readFileSync(join(root, "xapi.worker.json"), "utf8");
    expect(text).not.toContain("provider-id-must-not-be-written");
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([
      { type: "kv_namespace", bindingName: "LOCAL_PENDING" },
      { type: "r2_bucket", bindingName: "FILES", location: "apac" },
      { type: "durable_object", bindingName: "ROOM", className: "Room" },
    ]);
  });

  test("pull is idempotent and enriches known remote configuration", async () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "d1_database", bindingName: "DB" },
    });
    const client = {
      listWorkerResources: async () => [
        {
          bindingName: "DB",
          type: "D1_DATABASE",
          status: "ACTIVE",
          config: {
            requestedLocation: "weur",
            readReplication: { mode: "auto" },
          },
        },
      ],
    };
    const first = await pullProjectResources({
      cwd: root,
      environments: ["preview"],
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    const second = await pullProjectResources({
      cwd: root,
      environments: ["preview"],
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    expect(first.environments[0]?.updated).toEqual(["DB"]);
    expect(second.changed).toBe(false);
    expect(second.environments[0]?.unchanged).toEqual(["DB"]);
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([
      {
        type: "d1_database",
        bindingName: "DB",
        location: "weur",
        readReplication: "auto",
      },
    ]);
  });

  test("rejects drift atomically instead of overwriting local intent", async () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "kv_namespace", bindingName: "STATE" },
    });
    const path = join(root, "xapi.worker.json");
    const before = readFileSync(path, "utf8");
    await expect(
      pullProjectResources({
        cwd: root,
        environments: ["preview"],
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: {
          listWorkerResources: async () => [
            {
              bindingName: "STATE",
              type: "R2_BUCKET",
              status: "ACTIVE",
              config: {},
            },
          ],
        },
      }),
    ).rejects.toThrow("differs between xapi.worker.json and the live resource");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("does not import incomplete or unhealthy remote state", async () => {
    const root = linkedProject();
    await expect(
      pullProjectResources({
        cwd: root,
        environments: ["preview"],
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: {
          listWorkerResources: async () => [
            {
              bindingName: "JOBS",
              type: "QUEUE",
              status: "DELETE_FAILED",
            },
          ],
        },
      }),
    ).rejects.toThrow("DELETE_FAILED");
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([]);
  });

  test("destroys one project resource by binding and removes desired state first", async () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "r2_bucket", bindingName: "FILES" },
    });
    const calls: string[] = [];
    const result = await destroyProjectResource({
      cwd: root,
      environment: "preview",
      bindingName: "FILES",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: {
        listWorkerResources: async () => [
          {
            id: "resource-files",
            bindingName: "FILES",
            type: "R2_BUCKET",
            status: "ACTIVE",
          },
        ],
        deleteWorkerResource: async (_options, _workerId, environment, id) => {
          calls.push(`${environment}:${id}`);
          expect(
            loadWorkerProject(root).config.environments.preview.resources,
          ).toEqual([]);
          return { id, status: "DELETING" };
        },
      },
    });
    expect(calls).toEqual(["preview:resource-files"]);
    expect(result).toMatchObject({
      localDeclarationRemoved: true,
      remoteDeletionRequested: true,
      resourceId: "resource-files",
    });
    expect(result.nextSteps[0]).toContain("Wait until binding FILES is absent");
  });

  test("keeps failed destruction recoverable without accidental recreation", async () => {
    const root = linkedProject();
    addProjectResource({
      cwd: root,
      environments: ["preview"],
      resource: { type: "queue", bindingName: "JOBS" },
    });
    await expect(
      destroyProjectResource({
        cwd: root,
        environment: "preview",
        bindingName: "JOBS",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: {
          listWorkerResources: async () => [
            {
              id: "resource-jobs",
              bindingName: "JOBS",
              type: "QUEUE",
              status: "ACTIVE",
            },
          ],
          deleteWorkerResource: async () => {
            throw new Error("provider timeout");
          },
        },
      }),
    ).rejects.toThrow("resources pull --env preview");
    expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([]);
  });
});
