import { requestDeadline } from "./request-deadline.ts";
import { conflictingWorkerSecretBinding } from "./workers-binding-validation.ts";
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
const BUILD_KILL_GRACE_MS = 500;
const BUILD_CLOSE_GRACE_MS = 250;

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
    const unix = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      env: sanitizedBuildEnvironment(),
      shell: true,
      // A separate group lets us signal only this build and its descendants.
      detached: unix,
      stdio: ["inherit", "pipe", "pipe"],
    });
    // stdout is reserved for the CLI's JSON contract. Build tools routinely
    // print progress to stdout, so forward both streams to stderr where they
    // remain visible without corrupting `--format json` output.
    child.stdout?.pipe(process.stderr);
    child.stderr?.pipe(process.stderr);
    let stopping: WorkerProjectBuildError | undefined;
    let cancelledBy: "SIGINT" | "SIGTERM" | undefined;
    let closed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let treeKiller: ReturnType<typeof spawn> | undefined;
    const finish = (error?: WorkerProjectBuildError) => {
      if (settled) return;
      settled = true;
      timer.dispose();
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve();
      // detached builds no longer receive terminal signals automatically.
      // Restore the CLI's default cancellation behavior after cleanup, while
      // leaving any existing caller signal handlers in control.
      if (cancelledBy && process.listenerCount(cancelledBy) === 0) {
        process.exitCode = cancelledBy === "SIGINT" ? 130 : 143;
        process.kill(process.pid, cancelledBy);
      }
    };
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH" && stopping)
          stopping.recovery.buildTermination = "unconfirmed";
      }
    };
    const stop = (error: WorkerProjectBuildError) => {
      if (stopping || settled) return;
      stopping = error;
      timer.dispose();
      if (unix) {
        signalGroup("SIGTERM");
        // Do not cancel escalation on shell exit/pipe closure: a descendant
        // may ignore TERM and keep writing files even without inherited pipes.
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          if (closed) finish(error);
          else closeTimer = setTimeout(() => finish(error), BUILD_CLOSE_GRACE_MS);
        }, BUILD_KILL_GRACE_MS);
      } else if (child.pid) {
        // Windows has no POSIX process groups. Kill the owned tree before its
        // shell disappears; taskkill does not receive any build credentials.
        treeKiller = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          env: sanitizedBuildEnvironment(), stdio: "ignore", windowsHide: true,
        });
        const killed = (confirmed: boolean) => {
          if (settled) return;
          if (!confirmed) {
            error.recovery.buildTermination = "unconfirmed";
            child.kill("SIGKILL");
          }
          finish(error);
        };
        treeKiller.once("error", () => killed(false));
        treeKiller.once("close", code => killed(code === 0));
        killTimer = setTimeout(() => { treeKiller?.kill(); killed(false); }, 1000);
      } else finish(error);
    };
    const cancel = (signal: "SIGINT" | "SIGTERM") => {
      cancelledBy = signal;
      stop(new WorkerProjectBuildError(`Build cancelled with ${signal}`, {
        buildCommand: command, projectRoot: cwd,
      }));
    };
    const interrupt = () => cancel("SIGINT");
    const terminate = () => cancel("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const timer = requestDeadline(() => stop(new WorkerProjectBuildError(
      `Build exceeded the ${timeoutMs / 60_000} minute timeout`,
      { buildCommand: command, projectRoot: cwd },
    )), timeoutMs);
    child.once("error", error => finish(new WorkerProjectBuildError(
      `Unable to start build: ${error.message}`, { buildCommand: command, projectRoot: cwd },
    )));
    // exit only observes the shell. close also waits for inherited output pipes.
    child.once("close", (code, signal) => {
      closed = true;
      if (stopping) return;
      if (code === 0) {
        finish();
        return;
      }
      finish(
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
    const settings = readWranglerDeploymentSettings(project, environment, project.config.build.output.endsWith(".bundle") ? "application/vnd.xapi.worker-bundle.v2+json" : undefined);
    const secretCollision = conflictingWorkerSecretBinding(settings.requiredSecrets || [], [
      ...project.config.environments[environment].resources.map(resource => resource.bindingName),
      ...(settings.assets?.binding ? [settings.assets.binding] : []),
    ]);
    if (secretCollision) throw new WorkerArtifactError(`Duplicate Worker binding: ${secretCollision}`);
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
      ...(settings.requiredSecrets || []),
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
      settings.requiredSecrets || [],
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
