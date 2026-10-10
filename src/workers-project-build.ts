import { requestDeadline } from "./request-deadline.ts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STATIC_APPLICATION_WORKER_SOURCE } from "./workers-framework-init.ts";
import type { LoadedWorkerArtifact } from "./workers-artifact.ts";
import {
  loadWorkerArtifactInput,
  validateNativeDeploymentMetadata,
  withNativeWorkerOptions,
  WorkerArtifactError,
  withWorkerVars,
  attachWorkerPublicVariables,
  attachWorkerNativeMetadata,
  attachWorkerObservability,
} from "./workers-artifact.ts";
import type { LoadedWorkerProject } from "./workers-project.ts";
import { workerEnvironmentContainers, resolveWorkerProjectPath } from "./workers-project.ts";
import {
  readWranglerDeploymentSettings,
  readWranglerPublicVars,
  findGeneratedWranglerConfig,
  parseWrangler,
} from "./workers-wrangler-import.ts";

const BUILD_TIMEOUT_MS = 15 * 60_000;

export type WorkerProjectBuildRunner = (
  command: string,
  cwd: string,
  timeoutMs?: number,
) => Promise<void>;

export class WorkerProjectBuildError extends Error {
  constructor(
    message: string,
    public readonly recovery: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkerProjectBuildError";
  }
}

function sanitizedBuildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i.test(
          name,
        ) && name !== "XAPI_KEY",
    ),
  );
}

export async function runWorkerProjectBuild(
  command: string,
  cwd: string,
  timeoutMs = BUILD_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: sanitizedBuildEnvironment(),
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    // stdout is reserved for the CLI's JSON contract. Build tools routinely
    // print progress to stdout, so forward both streams to stderr where they
    // remain visible without corrupting `--format json` output.
    child.stdout?.pipe(process.stderr);
    child.stderr?.pipe(process.stderr);
    const timer = requestDeadline(() => {
      child.kill("SIGTERM");
      reject(
        new WorkerProjectBuildError(
          `Build exceeded the ${timeoutMs / 60_000} minute timeout`,
          { buildCommand: command, projectRoot: cwd },
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      timer.dispose();
      reject(
        new WorkerProjectBuildError(`Unable to start build: ${error.message}`, {
          buildCommand: command,
          projectRoot: cwd,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      timer.dispose();
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new WorkerProjectBuildError(
          code === 127
            ? "Build command could not run because a required executable was not found"
            : `Build failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
          {
            buildCommand: command,
            projectRoot: cwd,
            ...(code === 127
              ? {
                  next: "Install the package manager used by build.command, then rerun the command",
                }
              : {}),
          },
        ),
      );
    });
  });
}

export async function loadWorkerProjectBundle(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
): Promise<LoadedWorkerArtifact> {
  const path = resolveWorkerProjectPath(
    project,
    project.config.build.output,
    "build.output",
  );
  try {
    const settings = readWranglerDeploymentSettings(project, environment, project.config.build.output.endsWith(".bundle") ? "application/vnd.xapi.worker-bundle+json" : undefined);
    // A static initializer cannot stand in for a server produced by the real
    // application build. Only the generated adapter is guarded; custom Worker
    // entrypoints and ordinary SPA output retain their existing behavior.
    if (project.config.build.output === "xapi-worker/index.mjs" && existsSync(path) &&
        readFileSync(path, "utf8") === STATIC_APPLICATION_WORKER_SOURCE) {
      const generated = findGeneratedWranglerConfig(project.rootDir);
      if (generated) {
        const native = parseWrangler(resolveWorkerProjectPath(project, generated, "generated Wrangler configuration")).config;
        const main = typeof native.main === "string" ? resolve(project.rootDir, dirname(generated), native.main) : undefined;
        if (main && existsSync(main) && statSync(main).isFile() && main !== path) throw new WorkerProjectBuildError(
          `The application build produced a native Worker entrypoint. Preserve its server behavior: run xapi workers init --from-wrangler ${generated} --force, review the import report and build.output, then use the project's Wrangler deploy --dry-run --outfile packaging script before plan/push`,
          { remoteChangesApplied: false, generatedWrangler: generated, serverEntrypoint: main },
        );
      }
    }
    const built = await loadWorkerArtifactInput(
      path,
      project.config.build.main,
      settings.assets
        ? {
            ...settings.assets,
            directory: resolveWorkerProjectPath(
              project,
              settings.assets.directory,
              "assets.directory",
            ),
          }
        : undefined,
      workerEnvironmentContainers(project.config, environment),
      settings.uploadSourceMaps,
    );
    const decorated = attachWorkerNativeMetadata(attachWorkerObservability(withNativeWorkerOptions(built, settings), settings.observability, settings.queueBindingAliases), settings.nativeMetadata);
    const bundle = settings.variables !== undefined
      ? attachWorkerPublicVariables(decorated, settings.variables)
      : withWorkerVars(decorated, readWranglerPublicVars(project, environment));
    const vars =
      "bundle" in bundle.upload ? bundle.upload.bundle.vars : undefined;
    const occupied = new Set([
      ...project.config.environments[environment].resources.map(
        (resource) => resource.bindingName,
      ),
      ...(project.config.environments[environment].secrets || []),
      ...(settings.assets?.binding
        ? [settings.assets.binding]
        : []),
    ]);
    const versionBinding =
      "bundle" in bundle.upload
        ? bundle.upload.bundle.versionMetadata?.binding
        : undefined;
    if (
      versionBinding &&
      (occupied.has(versionBinding) ||
        Object.hasOwn(vars || {}, versionBinding))
    ) {
      throw new WorkerArtifactError(
        `Duplicate Worker binding: ${versionBinding}`,
      );
    }
    for (const name of Object.keys(vars || {})) {
      if (occupied.has(name))
        throw new WorkerArtifactError(`Duplicate Worker binding: ${name}`);
    }
    validateNativeDeploymentMetadata(
      bundle,
      settings,
      project.config.environments[environment].resources,
      project.config.environments[environment].secrets,
    );
    return bundle;
  } catch (error) {
    if (error instanceof WorkerArtifactError) {
      throw new WorkerProjectBuildError(error.message, {
        buildOutput: project.config.build.output,
        remoteChangesApplied: false,
      });
    }
    throw error;
  }
}

export async function prepareWorkerProjectBundle(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
  runner: WorkerProjectBuildRunner = runWorkerProjectBuild,
  timeoutMs = BUILD_TIMEOUT_MS,
): Promise<LoadedWorkerArtifact> {
  await runner(project.config.build.command, project.rootDir, timeoutMs);
  return loadWorkerProjectBundle(project, environment);
}
