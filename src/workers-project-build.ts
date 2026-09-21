import { spawn } from "node:child_process";
import type { LoadedWorkerArtifact } from "./workers-artifact.ts";
import {
  loadWorkerArtifactInput,
  validateNativeDeploymentMetadata,
  WorkerArtifactError,
} from "./workers-artifact.ts";
import type { LoadedWorkerProject } from "./workers-project.ts";
import { resolveWorkerProjectPath } from "./workers-project.ts";
import { readWranglerDeploymentSettings } from "./workers-wrangler-import.ts";

const BUILD_TIMEOUT_MS = 15 * 60_000;

export type WorkerProjectBuildRunner = (
  command: string,
  cwd: string,
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new WorkerProjectBuildError(
          `Build exceeded the ${BUILD_TIMEOUT_MS / 60_000} minute timeout`,
          { buildCommand: command, projectRoot: cwd },
        ),
      );
    }, BUILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new WorkerProjectBuildError(`Unable to start build: ${error.message}`, {
          buildCommand: command,
          projectRoot: cwd,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
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
                  next:
                    "Install the package manager used by build.command, then rerun the command",
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
    const bundle = await loadWorkerArtifactInput(
      path,
      project.config.build.main,
      project.config.assets
        ? {
            ...project.config.assets,
            directory: resolveWorkerProjectPath(
              project,
              project.config.assets.directory,
              "assets.directory",
            ),
          }
        : undefined,
    );
    validateNativeDeploymentMetadata(
      bundle,
      readWranglerDeploymentSettings(project, environment),
      project.config.environments[environment].resources,
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
): Promise<LoadedWorkerArtifact> {
  await runner(project.config.build.command, project.rootDir);
  return loadWorkerProjectBundle(project, environment);
}
