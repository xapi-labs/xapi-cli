import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { XAPI_ACTION_HOST, XAPI_API_HOST, getConfig, requireApiKey } from "../config.ts";
import { err, output, type OutputFormat } from "../format.ts";
import * as client from "../workers-client.ts";
import {
  initWorkerProject,
  type WorkerStarterTemplate,
} from "../workers-init.ts";
import { listWorkerTemplates } from "../workers-templates.ts";
import { importWranglerProject } from "../workers-wrangler-import.ts";
import { createWorkerPlan } from "../workers-plan.ts";
import {
  formatWorkerPlan,
  useHumanWorkerPlanOutput,
} from "../workers-plan-output.ts";
import { pushWorkerProject, WorkerPushError } from "../workers-push.ts";
import {
  formatWorkerPushResult,
  useHumanWorkerPushOutput,
} from "../workers-push-output.ts";
import { promoteWorkerProject } from "../workers-promote.ts";
import { rollbackWorkerProject } from "../workers-rollback.ts";
import { readWorkerLogs, tailWorkerLogs } from "../workers-logs.ts";
import {
  addProjectResource,
  destroyProjectResource,
  pullProjectResources,
  removeProjectResource,
  updateProjectResource,
} from "../workers-project-resources.ts";
import { collectWorkerBillingLedger } from "../workers-billing-ledger.ts";
import { formatWorkerMetering } from "../workers-metering-output.ts";
import {
  loadWorkerArtifactInput,
  WorkerArtifactError,
} from "../workers-artifact.ts";
import {
  printWorkerBillingResponse,
  workerBillingOutputMode,
} from "../workers-billing-output.ts";
import { bindXdomainWorker } from "../workers-domain-bind.ts";

export const WORKERS_HELP = `xapi-to workers - Deploy and manage xAPI-hosted Cloudflare Workers

USAGE
  xapi-to workers <command> [args] [flags]

COMMANDS
  templates
  init [directory] --template TEMPLATE
  plan --env preview|production
  push --env preview
  promote --to production [--artifact ARTIFACT_ID]
  rollback --env preview|production (--to previous | --deployment DEPLOYMENT_ID)
  list
  get <worker-id>
  create --name NAME --slug SLUG --preview-budget USD --production-budget USD
  upload <worker-id> --file dist/index.mjs|dist/ [--main worker.js]
  artifacts <worker-id>
  build <worker-id> --project . --entrypoint src/index.ts --command "npm run build"
  builds <worker-id>
  deploy <worker-id> --artifact ARTIFACT_ID --env preview|production
  budget <worker-id> <environment> --daily-usd USD
  audit <worker-id>
  invocations <worker-id> --env preview|production
  logs <worker-id> --env preview|production [--tail] [--since 10m]
  usage <worker-id> [--env preview|production]
  metering <worker-id> --env preview|production [--json]
  billing-status
  billing ledger <worker-id> --env ENV [--all] [--snapshot-time ISO] [--json]
  retention show|quote|accept|pause|resume|keep-paused|delete <worker-id> --env ENV
  billing prices|overview|usage|ledger|forecast|risk|lifecycle <worker-id> --env preview|production
  domains list <worker-id>
  domains attach <worker-id> --env ENV --xdomain-domain-id ID [--subdomain @]
  domains detach <worker-id> <domain-id> --yes
  domains retry <worker-id> <domain-id>
  schedules list <worker-id>
  schedules create <worker-id> --name NAME --cron "*/15 * * * *" --env preview --path /cron
  schedules runs <worker-id> <schedule-id>
  schedules run <worker-id> <schedule-id>
  schedules pause|resume <worker-id> <schedule-id>
  schedules delete <worker-id> <schedule-id> --yes
  bindings
  resources add --env preview|production|both --type TYPE --binding NAME
  resources update --env preview|production|both --type TYPE --binding NAME
  resources pull --env preview|production|both
  resources remove --env preview|production|both --binding NAME
  resources destroy --env preview|production --binding NAME --yes
  secrets list <worker-id> --env preview|production
  secrets status <worker-id> --env preview|production
  secrets set <worker-id> <NAME> --env ENV (--from-env VARIABLE | --stdin | --env-file .env)
  secrets apply <worker-id> --env ENV --env-file .env [--delete OLD_NAME,OTHER_NAME]
  secrets delete <worker-id> <NAME> --env ENV --yes
  provider-status
  capabilities
  artifact-provider-status
  build-provider-status
  delete <worker-id> --yes

CREATE FLAGS
  --template worker|agent       Official starter type (default: worker)
  --description TEXT
  --preview-budget 0.10..100    Explicit preview daily budget
  --production-budget 0.10..100 Explicit production daily budget

INIT FLAGS
  --template TEMPLATE                   worker|agent|chat|webhook|persistent-agent
  --from-wrangler PATH                  Import an existing wrangler.jsonc or wrangler.toml
  --accept-partial                      Write only after explicitly accepting unsupported fields
  --name NAME                           Worker display name
  --slug SLUG                           Stable lowercase Worker slug
  --preview-budget 0.10..100            Default: 0.25
  --production-budget 0.10..100         Default: 2
  --force                               Overwrite template-managed files only
  --framework auto|react|vite|vue|next  Override existing package detection

PLAN FLAGS
  --env preview|production              Environment to compare (required)
  --config PATH                         Explicit xapi.worker.json path
  Interactive terminals show a review view by default; use --format json for CI

PUSH FLAGS
  --env preview                         Required; production uses workers promote
  --config PATH                         Explicit xapi.worker.json path
  --non-interactive                     CI mode; never bypasses BLOCKED checks
  --retention-price-version VERSION     Explicit accepted freeze quote; does not auto-accept policy

PROMOTE FLAGS
  --to production                       Required explicit production target
  --artifact ARTIFACT_ID                ACTIVE preview Artifact (default: latest)
  --config PATH                         Explicit xapi.worker.json path
  --non-interactive                     CI mode after all production preflights pass
  --retention-price-version VERSION     Explicit accepted freeze quote for new production resources

ROLLBACK FLAGS
  --env preview|production              Environment whose code will be rolled back
  --to previous                         Select the latest different successful version
  --deployment DEPLOYMENT_ID            Select an explicit historical deployment
  --config PATH                         Explicit xapi.worker.json path
  --non-interactive                     Explicit CI confirmation for production

LOG FLAGS
  --tail                                Poll continuously; Ctrl-C stops cleanly
  --since 30s|10m|2h                    Include only recent log events
  --level debug|info|log|warn|error     Filter by exact log level
  --request-id ID                       Filter one xAPI request trace
  --deployment DEPLOYMENT_ID            Filter by the derived deployment timeline

BILLING FLAGS
  --env preview|production              Environment to inspect (required)
  --json                                Emit the public API schema unchanged
  --snapshot-time ISO                   Reuse one coherent Backend snapshot
  --from ISO --to ISO                   Usage range on five-minute boundaries
  --metric NAME --resource-id ID        Filter usage or ledger
  --cursor OPAQUE --limit 1..100        Page ledger without decoding its cursor

UPLOAD FLAGS
  --file PATH                   Single ES module or code-module directory (required)
  --main PATH                   Entrypoint relative to --file when it is a directory
  --idempotency-key KEY         Stable retry key (generated when omitted)

OPTIONAL SANDBOX BUILD FLAGS
  --project PATH                Project directory (default: current directory)
  --entrypoint PATH             Source entrypoint inside the project (required)
  --command COMMAND             Sandbox build command (required)
  --output PATH                 Bundled ES module path (default: dist/index.mjs)
  --idempotency-key KEY         Stable retry key (generated when omitted)

DEPLOY FLAGS
  --artifact ARTIFACT_ID        Immutable uploaded or built artifact (required)
  --env preview|production      Target environment (default: preview)
  --compatibility-date YYYY-MM-DD
  --compatibility-flags a,b
  --idempotency-key KEY         Stable retry key (generated when omitted)

RESOURCE FLAGS
  --env preview|production|both Project resource environment
  --config PATH                 Explicit xapi.worker.json path
  --type kv|d1|r2|do|queue|workflow
  --class-name NAME             Exported class for a Durable Object
  --location REGION             D1/R2 placement: wnam|enam|weur|eeur|apac|oc
  --read-replication MODE       D1 replicas: auto|disabled
  --binding NAME                Uppercase env binding, for example STATE or FILES
  --yes                         Required for physical resource destruction

ADVANCED REMOTE RESOURCE COMMANDS
  These recovery/debug commands mutate live state without updating xapi.worker.json.
  resources list <worker-id> --env preview|production
  resources create <worker-id> --env ENV --type TYPE --binding NAME
  resources delete <worker-id> <resource-id> --env ENV --yes

SECRET FLAGS
  --from-env VARIABLE           Read value from a local environment variable
  --stdin                       Read one value from stdin without shell history
  --env-file PATH               Read one named value or apply all entries in memory
  --delete NAME,NAME            Delete names in the same batch apply

AUTHORIZATION
  API keys need workers:read for reads and workers:write for mutations.
  XAPI_KEY overrides XAPI_API_KEY and ~/.xapi/config.json.

EXAMPLES
  xapi-to workers templates
  xapi-to workers init my-agent --template persistent-agent
  xapi-to workers init . --framework vite
  xapi-to workers init --from-wrangler ./wrangler.jsonc
  xapi-to workers plan --env preview --format json
  xapi-to workers push --env preview
  xapi-to workers promote --to production
  xapi-to workers rollback --env production --to previous
  xapi-to workers create --name "Daily agent" --slug daily-agent \
    --preview-budget 0.25 --production-budget 2
  xapi-to workers upload <id> --file dist/index.mjs
  xapi-to workers upload <id> --file dist/ --main worker.js
  xapi-to workers deploy <id> --artifact <artifact-id> --env preview
  xapi-to workers billing overview <id> --env production
  xapi-to workers billing usage <id> --env production --json
  xapi-to workers build <id> --entrypoint src/index.ts --command "npm run build"
  xapi-to workers resources add --env both --type d1 --binding DB
  xapi-to workers resources update --env preview --type d1 --binding DB --location weur
  xapi-to workers resources pull --env preview
  DEEPSEEK_KEY=... xapi-to workers secrets set <id> MODEL_KEY \
    --env preview --from-env DEEPSEEK_KEY
  xapi-to workers list --format table
`;

export const WORKERS_INIT_HELP = `xapi-to workers init - Initialize an xAPI Worker project

USAGE
  xapi-to workers init [directory] [flags]

STARTING POINTS
  New Worker
    xapi workers init my-agent --template persistent-agent

  Existing React, Vite, Vue, or static Next.js package
    cd app && xapi workers init
    Detection preserves existing dev, build, and test scripts.

  Existing Worker with Wrangler
    xapi workers init --from-wrangler ./wrangler.jsonc

  Next.js SSR
    Run vinext check/init first, then import its generated Wrangler config.

WRITES
  Existing frontends gain xapi.worker.json, wrangler.jsonc,
  xapi-worker/index.ts, and xapi:* package scripts. Re-running init is not a
  resource synchronization operation.

FLAGS
  --template worker|agent|chat|webhook|persistent-agent
  --framework auto|react|vite|vue|next
  --from-wrangler PATH
  --accept-partial
  --name NAME
  --slug SLUG
  --preview-budget USD
  --production-budget USD
  --force
`;

export const WORKERS_RESOURCES_HELP = `xapi-to workers resources - Reconcile managed Worker resources

STATE MODEL
  xapi.worker.json is desired state. xAPI is live state. workers plan reads and
  compares both; the CLI keeps no third cached state file.

PROJECT COMMANDS
  add      Declare a new resource locally; plan then push/promote.
  update   Replace one complete existing declaration locally; linked resource
           type and Durable Object class cannot change in place.
  pull     Adopt supported healthy live-only resources into desired state.
  remove   Stop declaring a resource; live data remains and may keep billing.
  destroy  Remove one environment declaration and request live data deletion;
           requires --yes and a prior backup.

USAGE
  xapi workers resources add --env preview|production|both --type TYPE --binding NAME
  xapi workers resources update --env preview|production|both --type TYPE --binding NAME
  xapi workers resources pull --env preview|production|both
  xapi workers resources remove --env preview|production|both --binding NAME
  xapi workers resources destroy --env preview|production --binding NAME --yes

RESOURCE FLAGS
  --type kv|d1|r2|do|queue|workflow
  --class-name NAME
  --location wnam|enam|weur|eeur|apac|oc
  --read-replication auto|disabled
  --config PATH

SAFE FLOW
  xapi workers resources add --env preview --type d1 --binding DB --location apac
  xapi workers plan --env preview
  xapi workers push --env preview

  Live location and D1 replication changes cannot be updated in place. Create a
  new binding, migrate data, and switch explicitly when plan reports BLOCKED.

ADVANCED LIVE-ONLY COMMANDS
  list/create/delete <worker-id> operate on live state without updating the
  project file. Use them only for recovery or custom control-plane automation.
`;

const COMMON_FLAGS = new Set(["help", "format"]);

function options() {
  const cfg = getConfig();
  requireApiKey(cfg);
  return { apiHost: XAPI_API_HOST, apiKey: cfg.apiKey! };
}

function printWorkerPlan(
  plan: Awaited<ReturnType<typeof createWorkerPlan>>,
  flagFormat?: string,
) {
  if (
    useHumanWorkerPlanOutput({
      flagFormat,
      envFormat: process.env.XAPI_OUTPUT,
      stdoutIsTTY: process.stdout.isTTY,
    })
  ) {
    console.log(formatWorkerPlan(plan));
    return;
  }
  output(plan, flagFormat as OutputFormat | undefined);
}

function printWorkerPushResult(
  result: Awaited<ReturnType<typeof pushWorkerProject>>,
  flagFormat?: string,
) {
  if (
    useHumanWorkerPushOutput({
      flagFormat,
      envFormat: process.env.XAPI_OUTPUT,
      stdoutIsTTY: process.stdout.isTTY,
    })
  ) {
    console.log(formatWorkerPushResult(result));
    return;
  }
  output(result, flagFormat as OutputFormat | undefined);
}

function required(value: string | undefined, flag: string): string {
  if (!value || value === "true") err(`${flag} is required`);
  return value;
}

function budget(value: string | undefined, flag: string): number {
  const amount = Number(required(value, flag));
  if (!Number.isFinite(amount) || amount < 0.1 || amount > 100) {
    err(`${flag} must be between 0.10 and 100`);
  }
  return amount;
}

function durationMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) err("--timeout must use ms, s, or m, for example 120s");
  const amount = Number(match![1]);
  const scale = match![2] === "ms" ? 1 : match![2] === "s" ? 1_000 : 60_000;
  const result = amount * scale;
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 10 * 60_000) {
    err("--timeout must be between 1s and 10m");
  }
  return result;
}

function assertFlags(
  flags: Record<string, string>,
  allowed: readonly string[] = [],
): void {
  const valid = new Set([...COMMON_FLAGS, ...allowed]);
  const unknown = Object.keys(flags).filter((flag) => !valid.has(flag));
  if (unknown.length) {
    err(
      `unknown workers flag: ${unknown.map((flag) => `--${flag}`).join(", ")}`,
      {
        validFlags: [...valid].sort().map((flag) => `--${flag}`),
      },
    );
  }
}

function oneId(args: string[], usage: string): string {
  if (args.length !== 1) err(usage);
  return args[0];
}

function environment(value: string | undefined): string {
  const result = required(value, "--env");
  if (!["preview", "production"].includes(result)) {
    err("--env must be preview or production");
  }
  return result;
}

export function parseWorkerSecretEnv(source:string):Record<string,string> {
  const values:Record<string,string>={};
  for(const [index,raw] of source.split(/\r?\n/).entries()) {
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    const normalized=line.startsWith('export ')?line.slice(7).trim():line;
    const separator=normalized.indexOf('=');
    if(separator<=0)err(`invalid secret env entry on line ${index+1}`);
    const name=normalized.slice(0,separator).trim();
    if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(name))err(`invalid secret name on line ${index+1}`);
    let value=normalized.slice(separator+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(!value)err(`secret ${name} is empty`);
    values[name]=value;
  }
  return values;
}

async function readSecretStdin() {
  let value='';
  for await(const chunk of process.stdin)value+=chunk.toString();
  value=value.replace(/[\r\n]+$/,'');
  if(!value)err('stdin secret value is empty');
  return value;
}

async function secretValue(flags:Record<string,string>,bindingName:string) {
  const sources=['from-env','stdin','env-file'].filter(flag=>flags[flag]!==undefined);
  if(sources.length!==1)err('choose exactly one of --from-env, --stdin, or --env-file');
  if(flags['from-env']) {
    const value=process.env[flags['from-env']];
    if(!value)err(`environment variable ${flags['from-env']} is empty or missing`);
    return value;
  }
  if(flags.stdin==='true')return readSecretStdin();
  if(!flags['env-file']||flags['env-file']==='true')err('--env-file requires a path');
  const values=parseWorkerSecretEnv(await readFile(resolve(flags['env-file']),'utf8'));
  const key=flags['from-env']||bindingName;
  if(!values[key])err(`secret ${key} is empty or missing from ${flags['env-file']}`);
  return values[key];
}

const IGNORED_DIRECTORIES = new Set([
  ".aws",
  ".docker",
  ".git",
  ".gnupg",
  ".ssh",
  ".xapi",
  "dist",
  "node_modules",
]);
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.git-credentials|\.netrc|\.npmrc|\.yarnrc(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ecdsa|ed25519))$/i;

async function projectFiles(project: string) {
  const files: Array<{
    path: string;
    content: string;
    encoding: "utf8" | "base64";
  }> = [];
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (SECRET_FILE.test(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      if (info.size > 1_000_000) err(`source file exceeds 1 MB: ${absolute}`);
      const buffer = await readFile(absolute);
      total += buffer.length;
      if (total > 2 * 1024 * 1024)
        err("Worker project exceeds the 2 MB source limit");
      if (files.length >= 200) err("Worker project exceeds the 200 file limit");
      const path = relative(project, absolute).split(sep).join("/");
      const binary = buffer.includes(0);
      files.push({
        path,
        content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
        encoding: binary ? "base64" : "utf8",
      });
    }
  }
  await walk(project);
  return files;
}

export async function workersCommand(
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  if (flags.help) {
    if (args[0] === "init") {
      console.log(WORKERS_INIT_HELP);
      return;
    }
    if (args[0] === "resources") {
      console.log(WORKERS_RESOURCES_HELP);
      return;
    }
    console.log(WORKERS_HELP);
    return;
  }
  if (args.length === 0) {
    console.log(WORKERS_HELP);
    return;
  }
  const [command, ...rest] = args;
  switch (command) {
    case "templates": {
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers templates");
      output(listWorkerTemplates());
      return;
    }
    case "init": {
      assertFlags(flags, [
        "template",
        "from-wrangler",
        "accept-partial",
        "name",
        "slug",
        "preview-budget",
        "production-budget",
        "force",
        "framework",
      ]);
      if (rest.length > 1) {
        err("usage: xapi-to workers init [directory] [flags]");
      }
      if (Object.hasOwn(flags, "from-wrangler")) {
        if (!flags["from-wrangler"] || flags["from-wrangler"] === "true") {
          err("--from-wrangler requires a .jsonc, .json, or .toml path");
        }
        if (rest.length || flags.template || flags.name || flags.slug || flags.framework) {
          err(
            "--from-wrangler cannot be combined with a target directory, --template, --name, --slug, or --framework",
          );
        }
        if (flags["accept-partial"] && flags["accept-partial"] !== "true") {
          err("--accept-partial does not accept a value");
        }
        if (flags.force && flags.force !== "true") {
          err("--force does not accept a value");
        }
        let result;
        try {
          result = importWranglerProject({
            wranglerPath: flags["from-wrangler"],
            acceptPartial: flags["accept-partial"] === "true",
            force: flags.force === "true",
            previewDailyBudgetUsd: flags["preview-budget"]
              ? budget(flags["preview-budget"], "--preview-budget")
              : 0.25,
            productionDailyBudgetUsd: flags["production-budget"]
              ? budget(flags["production-budget"], "--production-budget")
              : 2,
          });
        } catch (error) {
          err(
            error instanceof Error
              ? error.message
              : "Unable to import Wrangler project",
          );
        }
        output(result);
        if (!result.wrote) {
          err(
            "Wrangler import contains unsupported fields; no files were written",
          );
        }
        return;
      }
      if (flags["accept-partial"]) {
        err("--accept-partial is only valid with --from-wrangler");
      }
      if (flags.framework === "true" || flags.framework === "") {
        err("--framework requires auto, react, vite, vue, or next");
      }
      const template = (flags.template || "worker") as WorkerStarterTemplate;
      if (flags.force && flags.force !== "true") {
        err("--force does not accept a value");
      }
      try {
        output(
          initWorkerProject({
            target: rest[0] || ".",
            template,
            name: flags.name === "true" ? undefined : flags.name,
            slug: flags.slug === "true" ? undefined : flags.slug,
            previewDailyBudgetUsd: flags["preview-budget"]
              ? budget(flags["preview-budget"], "--preview-budget")
              : 0.25,
            productionDailyBudgetUsd: flags["production-budget"]
              ? budget(flags["production-budget"], "--production-budget")
              : 2,
            force: flags.force === "true",
            framework: flags.framework === "true" ? undefined : flags.framework,
          }),
        );
      } catch (error) {
        err(
          error instanceof Error
            ? error.message
            : "Unable to initialize Worker project",
        );
      }
      return;
    }
    case "plan": {
      assertFlags(flags, ["env", "config"]);
      if (rest.length) err("usage: xapi-to workers plan --env ENV");
      if (flags.config === "true" || flags.config === "") {
        err("--config requires a path");
      }
      const plan = await createWorkerPlan({
        environment: environment(flags.env) as "preview" | "production",
        configPath: flags.config,
        clientOptions: options(),
      });
      printWorkerPlan(plan, flags.format);
      return;
    }
    case "retention": {
      assertFlags(flags, ["env", "type", "price-version", "yes"]);
      const [action, id, ...extra] = rest;
      if (!id || extra.length || !["show", "quote", "accept", "pause", "resume", "keep-paused", "delete"].includes(action)) err("usage: workers retention show|quote|accept|pause|resume|keep-paused|delete <worker-id> --env ENV");
      const env = environment(flags.env);
      if (["accept", "delete"].includes(action) && flags.yes !== "true") err("--yes is required to accept automatic reserve-exhaustion deletion or delete this environment");
      const result = await client.workerRetention(options(), id, env,
        action === "quote" ? `/quote/${encodeURIComponent(flags.type || "WORKER")}` : action === "accept" ? "/accept" : action === "show" ? "" : "/actions",
        action === "accept" ? { policyVersion: "retention-v3", automaticDeletionAccepted: true, priceVersion: required(flags["price-version"], "--price-version") } : ["show", "quote"].includes(action) ? undefined : { action });
      if (flags.format === "json") output(result);
      else {
        const state = result.lifecycle || result;
        console.log(`Worker ${id} · ${env}\nState: ${state.state || (result.enabled === false ? "retention disabled" : "quote / policy")}`);
        for (const [label, key] of [["Available balance", "availableBalanceUsd"], ["Freeze quote", "freezeUsd"], ["Available after freeze (estimate)", "availableAfterFreezeUsd"], ["Reserve target", "targetUsd"], ["Reserve remaining", "remainingUsd"], ["Reserve consumed", "consumedUsd"], ["Reserve released", "releasedUsd"]]) {
          if (result[key] != null) console.log(`${label}: $${result[key]}`);
        }
        if (result.priceVersion) console.log(`Price version: ${result.priceVersion}`);
        if (result.retentionHours) console.log(`Retention: ${result.retentionHours} hours. Automatic deletion at expiry.`);
        if (result.estimateBasisHours) console.log(`Freeze estimate basis: ${result.estimateBasisHours} hours (not a fixed retention period).`);
        if (result.policyVersion === "retention-v3" || state.retentionPolicyVersion === "retention-v3") {
          console.log("Manual recovery only. Deposits do not replenish reserve or resume execution. Cleanup starts when this environment reserve reaches its cleanup allowance, even if the account has available funds.");
          if (result.reserveBudget) console.log(`Remaining for retention: $${result.reserveBudget.retentionSpendableUsd ?? "unknown"}; cleanup allowance: $${result.reserveBudget.cleanupReserveUsd ?? "unknown"}`);
        }
        if (state.pauseReason) console.log(`Pause reason: ${state.pauseReason}`);
        if (result.fundingSource) console.log(`Funding: ${result.fundingSource}`);
        if (state.graceDeadlineAt) console.log(`Deletion deadline: ${state.graceDeadlineAt}`);
        console.log("Frozen funds remain yours; freezing is not a consumption charge. Use --format json for full evidence.");
      }
      return;
    }
    case "push": {
      assertFlags(flags, ["env", "config", "non-interactive", "retention-price-version"]);
      if (flags["retention-price-version"] === "true" || flags["retention-price-version"] === "") {
        err("--retention-price-version requires the explicitly accepted quote version");
      }
      if (rest.length) err("usage: xapi-to workers push --env preview");
      if (flags.config === "true" || flags.config === "") {
        err("--config requires a path");
      }
      if (flags["non-interactive"] && flags["non-interactive"] !== "true") {
        err("--non-interactive does not accept a value");
      }
      const selectedEnvironment = environment(flags.env);
      if (selectedEnvironment !== "preview") {
        err(
          "workers push only accepts --env preview; use workers promote for production",
        );
      }
      const nonInteractive = flags["non-interactive"] === "true";
      try {
        const result = await pushWorkerProject({
          environment: "preview",
          configPath: flags.config,
          clientOptions: options(),
          nonInteractive,
          retentionPriceVersion: flags["retention-price-version"],
          onPlan: nonInteractive
            ? undefined
            : (plan) => printWorkerPlan(plan, flags.format),
        });
        printWorkerPushResult(result, flags.format);
      } catch (error) {
        if (error instanceof WorkerPushError) {
          err(error.message, error.recovery);
        }
        err(error instanceof Error ? error.message : "Preview push failed");
      }
      return;
    }
    case "promote": {
      assertFlags(flags, [
        "to",
        "artifact",
        "config",
        "non-interactive",
        "retention-price-version",
      ]);
      if (rest.length) err("usage: xapi-to workers promote --to production");
      if (flags.to !== "production") {
        err("workers promote requires --to production");
      }
      if (flags.artifact === "true" || flags.artifact === "") {
        err("--artifact requires an Artifact ID");
      }
      if (flags.config === "true" || flags.config === "") {
        err("--config requires a path");
      }
      if (flags["non-interactive"] && flags["non-interactive"] !== "true") {
        err("--non-interactive does not accept a value");
      }
      if (
        flags["retention-price-version"] === "true" ||
        flags["retention-price-version"] === ""
      ) {
        err("--retention-price-version requires the explicitly accepted quote version");
      }
      const nonInteractive = flags["non-interactive"] === "true";
      try {
        output(
          await promoteWorkerProject({
            to: "production",
            artifactId: flags.artifact,
            configPath: flags.config,
            clientOptions: options(),
            nonInteractive,
            retentionPriceVersion: flags["retention-price-version"],
            onPlan: nonInteractive ? undefined : (plan) => output(plan),
          }),
        );
      } catch (error) {
        if (error instanceof WorkerPushError) {
          err(error.message, error.recovery);
        }
        err(
          error instanceof Error
            ? error.message
            : "Production promotion failed",
        );
      }
      return;
    }
    case "rollback": {
      assertFlags(flags, [
        "env",
        "to",
        "deployment",
        "config",
        "non-interactive",
      ]);
      if (rest.length) {
        err(
          "usage: xapi-to workers rollback --env ENV (--to previous | --deployment DEPLOYMENT_ID)",
        );
      }
      const selectedEnvironment = environment(flags.env) as
        | "preview"
        | "production";
      if (flags.to && flags.to !== "previous") {
        err("--to currently supports only previous");
      }
      if (flags.deployment === "true" || flags.deployment === "") {
        err("--deployment requires a Deployment ID");
      }
      if ((flags.to === "previous") === !!flags.deployment) {
        err(
          "choose exactly one of --to previous or --deployment DEPLOYMENT_ID",
        );
      }
      if (flags.config === "true" || flags.config === "") {
        err("--config requires a path");
      }
      if (flags["non-interactive"] && flags["non-interactive"] !== "true") {
        err("--non-interactive does not accept a value");
      }
      const nonInteractive = flags["non-interactive"] === "true";
      try {
        output(
          await rollbackWorkerProject({
            environment: selectedEnvironment,
            to: flags.to === "previous" ? "previous" : undefined,
            deploymentId: flags.deployment,
            configPath: flags.config,
            clientOptions: options(),
            nonInteractive,
            onPlan: nonInteractive ? undefined : (plan) => output(plan),
          }),
        );
      } catch (error) {
        if (error instanceof WorkerPushError) {
          err(error.message, error.recovery);
        }
        err(error instanceof Error ? error.message : "Worker rollback failed");
      }
      return;
    }
    case "list":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers list");
      output(await client.listWorkers(options()));
      return;
    case "get":
      assertFlags(flags);
      output(
        await client.getWorker(
          options(),
          oneId(rest, "usage: xapi-to workers get <worker-id>"),
        ),
      );
      return;
    case "create": {
      assertFlags(flags, [
        "name",
        "slug",
        "description",
        "template",
        "preview-budget",
        "production-budget",
      ]);
      if (rest.length) err("usage: xapi-to workers create [flags]");
      const template = flags.template || "worker";
      if (!["worker", "agent"].includes(template))
        err("--template must be worker or agent");
      output(
        await client.createWorker(options(), {
          name: required(flags.name, "--name"),
          slug: required(flags.slug, "--slug"),
          description: flags.description,
          template,
          previewDailyBudgetUsd: budget(
            flags["preview-budget"],
            "--preview-budget",
          ),
          productionDailyBudgetUsd: budget(
            flags["production-budget"],
            "--production-budget",
          ),
        }),
      );
      return;
    }
    case "upload": {
      assertFlags(flags, ["file", "main", "idempotency-key"]);
      const id = oneId(
        rest,
        "usage: xapi-to workers upload <worker-id> --file PATH",
      );
      if (flags.main === "true" || flags.main === "") {
        err("--main requires a path relative to the output directory");
      }
      let artifact;
      try {
        artifact = await loadWorkerArtifactInput(
          resolve(required(flags.file, "--file")),
          flags.main,
        );
      } catch (error) {
        if (error instanceof WorkerArtifactError) err(error.message);
        throw error;
      }
      output(
        await client.uploadWorkerArtifact(options(), id, {
          ...artifact.upload,
          idempotencyKey: flags["idempotency-key"] || randomUUID(),
        }),
      );
      return;
    }
    case "artifacts":
      assertFlags(flags);
      output(
        await client.listWorkerArtifacts(
          options(),
          oneId(rest, "usage: xapi-to workers artifacts <worker-id>"),
        ),
      );
      return;
    case "build": {
      assertFlags(flags, [
        "project",
        "entrypoint",
        "command",
        "output",
        "idempotency-key",
      ]);
      const id = oneId(
        rest,
        "usage: xapi-to workers build <worker-id> --entrypoint PATH --command COMMAND",
      );
      const project = resolve(flags.project || ".");
      const entrypoint = required(flags.entrypoint, "--entrypoint").replace(
        /^\.\//,
        "",
      );
      const files = await projectFiles(project).catch((error) => {
        err(`cannot read Worker project: ${project}`, error.message);
      });
      output(
        await client.createWorkerBuild(options(), id, {
          files,
          entrypoint,
          buildCommand: required(flags.command, "--command"),
          outputPath: (flags.output || "dist/index.mjs").replace(/^\.\//, ""),
          idempotencyKey: flags["idempotency-key"] || randomUUID(),
        }),
      );
      return;
    }
    case "builds":
      assertFlags(flags);
      output(
        await client.listWorkerBuilds(
          options(),
          oneId(rest, "usage: xapi-to workers builds <worker-id>"),
        ),
      );
      return;
    case "deploy": {
      assertFlags(flags, [
        "artifact",
        "env",
        "compatibility-date",
        "compatibility-flags",
        "idempotency-key",
        "retention-price-version",
      ]);
      const id = oneId(
        rest,
        "usage: xapi-to workers deploy <worker-id> --artifact ARTIFACT_ID [--env preview]",
      );
      const environment = flags.env || "preview";
      if (!["preview", "production"].includes(environment))
        err("--env must be preview or production");
      output(
        await client.deployWorker(options(), id, {
          environment,
          artifactId: required(flags.artifact, "--artifact"),
          retentionPriceVersion: flags["retention-price-version"],
          idempotencyKey: flags["idempotency-key"] || randomUUID(),
          compatibilityDate: flags["compatibility-date"],
          compatibilityFlags: flags["compatibility-flags"]
            ?.split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      );
      return;
    }
    case "budget": {
      assertFlags(flags, ["daily-usd"]);
      if (rest.length !== 2)
        err(
          "usage: xapi-to workers budget <worker-id> <preview|production> --daily-usd USD",
        );
      if (!["preview", "production"].includes(rest[1]))
        err("environment must be preview or production");
      output(
        await client.updateWorkerBudget(
          options(),
          rest[0],
          rest[1],
          budget(flags["daily-usd"], "--daily-usd"),
        ),
      );
      return;
    }
    case "audit":
      assertFlags(flags);
      output(
        await client.workerAuditLogs(
          options(),
          oneId(rest, "usage: xapi-to workers audit <worker-id>"),
        ),
      );
      return;
    case "invocations":
      assertFlags(flags, ["env"]);
      output(
        await client.workerInvocationLogs(
          options(),
          oneId(
            rest,
            "usage: xapi-to workers invocations <worker-id> --env ENV",
          ),
          environment(flags.env),
        ),
      );
      return;
    case "logs": {
      assertFlags(flags, [
        "env",
        "tail",
        "since",
        "level",
        "request-id",
        "deployment",
      ]);
      const id = oneId(
        rest,
        "usage: xapi-to workers logs <worker-id> --env ENV [--tail] [filters]",
      );
      const selectedEnvironment = environment(flags.env) as
        | "preview"
        | "production";
      if (flags.tail && flags.tail !== "true") {
        err("--tail does not accept a value");
      }
      for (const flag of ["since", "level", "request-id", "deployment"]) {
        if (flags[flag] === "true" || flags[flag] === "") {
          err(`--${flag} requires a value`);
        }
      }
      const query = {
        workerId: id,
        environment: selectedEnvironment,
        clientOptions: options(),
        since: flags.since,
        level: flags.level,
        requestId: flags["request-id"],
        deploymentId: flags.deployment,
      };
      if (flags.tail === "true") {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        try {
          await tailWorkerLogs({
            ...query,
            signal: controller.signal,
            onBatch: (batch) => output(batch),
            onTransientError: () =>
              console.error(
                JSON.stringify({
                  warning: "Worker log poll failed; retrying",
                }),
              ),
          });
        } finally {
          process.removeListener("SIGINT", stop);
        }
      } else {
        output(await readWorkerLogs(query));
      }
      return;
    }
    case "usage":
      assertFlags(flags, ["env"]);
      output(
        await client.workerUsage(
          options(),
          oneId(rest, "usage: xapi-to workers usage <worker-id> [--env ENV]"),
          flags.env ? environment(flags.env) : undefined,
        ),
      );
      return;
    case "billing-status":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers billing-status");
      output(await client.workerBillingStatus(options()));
      return;
    case "metering": {
      assertFlags(flags, ["env", "json"]);
      let mode;
      try { mode = workerBillingOutputMode(flags); }
      catch (error) { err(error instanceof Error ? error.message : String(error)); }
      const response = await client.workerMeteredUsage(options(), oneId(rest, "usage: xapi-to workers metering <worker-id> --env ENV [--json]"), environment(flags.env));
      if (mode === "json") output(response);
      else console.log(formatWorkerMetering(response));
      return;
    }
    case "billing": {
      const [kindValue, ...billingArgs] = rest;
      const kinds = [
        "prices",
        "overview",
        "usage",
        "ledger",
        "forecast",
        "risk",
        "lifecycle",
      ] as const;
      if (!kinds.includes(kindValue as (typeof kinds)[number])) {
        err(
          "usage: xapi-to workers billing prices|overview|usage|ledger|forecast|risk|lifecycle <worker-id> --env ENV",
        );
      }
      const kind = kindValue as (typeof kinds)[number];
      const allowed = ["env", "json"];
      if (kind === "overview") allowed.push("snapshot-time");
      if (kind === "usage") {
        allowed.push("snapshot-time", "from", "to", "metric", "resource-id");
      }
      if (kind === "ledger") {
        allowed.push(
          "snapshot-time",
          "all",
          "cursor",
          "limit",
          "metric",
          "resource-id",
        );
      }
      assertFlags(flags, allowed);
      let mode;
      try {
        mode = workerBillingOutputMode(flags);
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
      }
      if (flags.limit) {
        const limit = Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          err("--limit must be an integer from 1 to 100");
        }
      }
      for (const flag of [
        "snapshot-time",
        "from",
        "to",
        "metric",
        "resource-id",
        "cursor",
      ]) {
        if (flags[flag] === "true") err(`--${flag} requires a value`);
      }
      if (Object.hasOwn(flags, "all") && flags.all !== "true") {
        err("--all does not accept a value");
      }
      if (flags.all && flags.cursor) err("--all cannot be combined with --cursor");
      const workerId = oneId(
        billingArgs,
        `usage: xapi-to workers billing ${kind} <worker-id> --env ENV`,
      );
      const env = environment(flags.env);
      const query: client.WorkerBillingQuery = {
        snapshotTime: flags["snapshot-time"],
        from: flags.from,
        to: flags.to,
        metric: flags.metric,
        resourceId: flags["resource-id"],
        cursor: flags.cursor,
        limit: flags.limit,
      };
      const fetchPage = (pageQuery: client.WorkerBillingQuery) =>
        client.workerBillingQuery(options(), workerId, env, kind, pageQuery);
      const response = flags.all
        ? await collectWorkerBillingLedger(fetchPage, query)
        : await fetchPage(query);
      printWorkerBillingResponse(kind, response, mode);
      return;
    }
    case "domains": {
      const [action, ...domainArgs] = rest;
      if (action === "list") {
        assertFlags(flags);
        output(
          await client.listWorkerDomains(
            options(),
            oneId(
              domainArgs,
              "usage: xapi-to workers domains list <worker-id>",
            ),
          ),
        );
        return;
      }
      if (action === "attach") {
        assertFlags(flags, ["env", "xdomain-domain-id", "subdomain", "timeout"]);
        const workerId = oneId(
          domainArgs,
          "usage: xapi-to workers domains attach <worker-id> --env ENV --xdomain-domain-id ID [--subdomain @]",
        );
        const cfg = getConfig();
        requireApiKey(cfg);
        output(
          await bindXdomainWorker({
            workerOptions: options(),
            actionOptions: {
              actionHost: cfg.actionHost || XAPI_ACTION_HOST,
              apiKey: cfg.apiKey!,
            },
            workerId,
            environment: environment(flags.env) as "preview" | "production",
            domainId: required(flags["xdomain-domain-id"], "--xdomain-domain-id"),
            subdomain: flags.subdomain || "@",
            waitMs: durationMs(flags.timeout, 120_000),
          }),
        );
        return;
      }
      if (action === "detach") {
        assertFlags(flags, ["yes"]);
        if (domainArgs.length !== 2) {
          err("usage: xapi-to workers domains detach <worker-id> <domain-id> --yes");
        }
        if (flags.yes !== "true") {
          err("refusing to detach a custom domain without --yes");
        }
        output(
          await client.deleteWorkerDomain(
            options(),
            domainArgs[0],
            domainArgs[1],
          ),
        );
        return;
      }
      if (action === "retry") {
        assertFlags(flags);
        if (domainArgs.length !== 2) {
          err("usage: xapi-to workers domains retry <worker-id> <domain-id>");
        }
        output(
          await client.retryWorkerDomain(
            options(),
            domainArgs[0],
            domainArgs[1],
          ),
        );
        return;
      }
      err("usage: xapi-to workers domains <list|attach|detach|retry> ...");
    }
    case "schedules": {
      const [action, ...scheduleArgs] = rest;
      if (action === "list") {
        assertFlags(flags);
        output(
          await client.listWorkerSchedules(
            options(),
            oneId(
              scheduleArgs,
              "usage: xapi-to workers schedules list <worker-id>",
            ),
          ),
        );
        return;
      }
      if (action === "create") {
        assertFlags(flags, [
          "name",
          "cron",
          "env",
          "path",
          "timezone",
          "method",
          "body",
          "timeout-ms",
          "max-retries",
        ]);
        const id = oneId(
          scheduleArgs,
          "usage: xapi-to workers schedules create <worker-id> [flags]",
        );
        let body: Record<string, unknown> | undefined;
        if (flags.body) {
          try {
            body = JSON.parse(flags.body);
          } catch {
            err("--body must be valid JSON");
          }
        }
        output(
          await client.createWorkerSchedule(options(), id, {
            name: required(flags.name, "--name"),
            cron: required(flags.cron, "--cron"),
            environment: environment(flags.env) as "preview" | "production",
            path: required(flags.path, "--path"),
            timezone: flags.timezone || "UTC",
            method: (flags.method || "POST").toUpperCase(),
            body,
            timeoutMs: flags["timeout-ms"]
              ? Number(flags["timeout-ms"])
              : 30000,
            maxRetries: flags["max-retries"] ? Number(flags["max-retries"]) : 2,
          }),
        );
        return;
      }
      if (action === "runs") {
        assertFlags(flags);
        if (scheduleArgs.length !== 2)
          err(
            "usage: xapi-to workers schedules runs <worker-id> <schedule-id>",
          );
        output(
          await client.workerScheduleRuns(
            options(),
            scheduleArgs[0],
            scheduleArgs[1],
          ),
        );
        return;
      }
      if (action === "run") {
        assertFlags(flags);
        if (scheduleArgs.length !== 2)
          err("usage: xapi-to workers schedules run <worker-id> <schedule-id>");
        output(
          await client.runWorkerScheduleNow(
            options(),
            scheduleArgs[0],
            scheduleArgs[1],
          ),
        );
        return;
      }
      if (action === "pause" || action === "resume") {
        assertFlags(flags);
        if (scheduleArgs.length !== 2)
          err(
            `usage: xapi-to workers schedules ${action} <worker-id> <schedule-id>`,
          );
        output(
          await client.updateWorkerSchedule(
            options(),
            scheduleArgs[0],
            scheduleArgs[1],
            { enabled: action === "resume" },
          ),
        );
        return;
      }
      if (action === "delete") {
        assertFlags(flags, ["yes"]);
        if (scheduleArgs.length !== 2)
          err(
            "usage: xapi-to workers schedules delete <worker-id> <schedule-id> --yes",
          );
        if (flags.yes !== "true")
          err("refusing to delete a schedule without --yes");
        output(
          await client.deleteWorkerSchedule(
            options(),
            scheduleArgs[0],
            scheduleArgs[1],
          ),
        );
        return;
      }
      err(
        "usage: xapi-to workers schedules list|create|runs|pause|resume|delete ...",
      );
    }
    case "bindings":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers bindings");
      output(await client.workerBindingCatalog(options()));
      return;
    case "resources": {
      const [action, ...resourceArgs] = rest;
      if (action === "destroy") {
        assertFlags(flags, ["env", "config", "binding", "yes"]);
        if (resourceArgs.length) {
          err("usage: xapi-to workers resources destroy --env preview|production --binding NAME --yes");
        }
        if (flags.yes !== "true") {
          err("refusing to destroy a managed resource without --yes");
        }
        output(
          await destroyProjectResource({
            configPath: flags.config,
            environment: environment(flags.env) as "preview" | "production",
            bindingName: required(flags.binding, "--binding"),
            clientOptions: options(),
          }),
        );
        return;
      }
      if (action === "pull") {
        assertFlags(flags, ["env", "config"]);
        if (resourceArgs.length) {
          err("usage: xapi-to workers resources pull --env preview|production|both");
        }
        const selected = required(flags.env, "--env");
        if (!["preview", "production", "both"].includes(selected)) {
          err("--env must be preview, production, or both");
        }
        const environments = (selected === "both"
          ? ["preview", "production"]
          : [selected]) as Array<"preview" | "production">;
        output(
          await pullProjectResources({
            configPath: flags.config,
            environments,
            clientOptions: options(),
          }),
        );
        return;
      }
      if (action === "add" || action === "update" || action === "remove") {
        assertFlags(flags, [
          "env",
          "config",
          "type",
          "binding",
          "class-name",
          "location",
          "read-replication",
        ]);
        if (resourceArgs.length) {
          err(`usage: xapi-to workers resources ${action} --env preview|production|both --binding NAME`);
        }
        const selected = required(flags.env, "--env");
        if (!["preview", "production", "both"].includes(selected)) {
          err("--env must be preview, production, or both");
        }
        const environments = (selected === "both"
          ? ["preview", "production"]
          : [selected]) as Array<"preview" | "production">;
        const bindingName = required(flags.binding, "--binding");
        if (action === "remove") {
          if (flags.type || flags["class-name"] || flags.location || flags["read-replication"]) {
            err("resources remove accepts only --env, --binding, and --config");
          }
          output(
            removeProjectResource({
              configPath: flags.config,
              environments,
              bindingName,
            }),
          );
          return;
        }
        const type = required(flags.type, "--type");
        const typeMap: Record<string, "kv_namespace" | "d1_database" | "r2_bucket" | "durable_object" | "queue" | "workflow"> = {
          kv: "kv_namespace",
          d1: "d1_database",
          r2: "r2_bucket",
          do: "durable_object",
          queue: "queue",
          workflow: "workflow",
        };
        if (!typeMap[type]) err("--type must be kv, d1, r2, do, queue, or workflow");
        const edit = action === "add" ? addProjectResource : updateProjectResource;
        output(
          edit({
            configPath: flags.config,
            environments,
            resource: {
              type: typeMap[type],
              bindingName,
              ...(flags["class-name"]
                ? { className: flags["class-name"] }
                : {}),
              ...(flags.location
                ? {
                    location: flags.location as
                      | "wnam"
                      | "enam"
                      | "weur"
                      | "eeur"
                      | "apac"
                      | "oc",
                  }
                : {}),
              ...(flags["read-replication"]
                ? {
                    readReplication: flags["read-replication"] as
                      | "auto"
                      | "disabled",
                  }
                : {}),
            },
          }),
        );
        return;
      }
      if (action === "list") {
        assertFlags(flags, ["env"]);
        output(
          await client.listWorkerResources(
            options(),
            oneId(
              resourceArgs,
              "usage: xapi-to workers resources list <worker-id> --env ENV",
            ),
            environment(flags.env),
          ),
        );
        return;
      }
      if (action === "create") {
        assertFlags(flags, ["env", "type", "binding", "class-name", "location", "read-replication", "retention-price-version"]);
        const id = oneId(
          resourceArgs,
          "usage: xapi-to workers resources create <worker-id> --env ENV --type kv|d1|r2|do|queue|workflow --binding NAME",
        );
        const type = required(flags.type, "--type");
        const typeMap: Record<string, string> = {
          kv: "kv_namespace",
          d1: "d1_database",
          r2: "r2_bucket",
          do: "durable_object",
          queue: "queue",
          workflow: "workflow",
        };
        if (!typeMap[type])
          err("--type must be kv, d1, r2, do, queue, or workflow");
        const className =
          type === "do"
            ? required(flags["class-name"], "--class-name")
            : undefined;
        const location = flags.location;
        if (
          location &&
          !["wnam", "enam", "weur", "eeur", "apac", "oc"].includes(location)
        ) {
          err("--location must be wnam, enam, weur, eeur, apac, or oc");
        }
        if (location && type !== "d1" && type !== "r2") {
          err("--location is only valid with --type d1 or r2");
        }
        const readReplication = flags["read-replication"];
        if (
          readReplication &&
          readReplication !== "auto" &&
          readReplication !== "disabled"
        ) {
          err("--read-replication must be auto or disabled");
        }
        if (readReplication && type !== "d1") {
          err("--read-replication is only valid with --type d1");
        }
        output(
          await client.createWorkerResource(
            options(),
            id,
            environment(flags.env),
            {
              type: typeMap[type],
              retentionPriceVersion: flags["retention-price-version"],
              bindingName: required(flags.binding, "--binding"),
              ...(className ? { className } : {}),
              ...(location ? { location } : {}),
              ...(readReplication ? { readReplication } : {}),
            },
          ),
        );
        return;
      }
      if (action === "delete") {
        assertFlags(flags, ["env", "yes"]);
        if (resourceArgs.length !== 2) {
          err(
            "usage: xapi-to workers resources delete <worker-id> <resource-id> --env ENV --yes",
          );
        }
        if (flags.yes !== "true") {
          err("refusing to delete a managed resource without --yes");
        }
        output(
          await client.deleteWorkerResource(
            options(),
            resourceArgs[0],
            environment(flags.env),
            resourceArgs[1],
          ),
        );
        return;
      }
      err("usage: xapi-to workers resources <add|update|pull|remove|destroy|list|create|delete> ...");
    }
    case "secrets": {
      const [action, ...secretArgs] = rest;
      if (action === "list") {
        assertFlags(flags, ["env"]);
        output(
          await client.listWorkerSecrets(
            options(),
            oneId(
              secretArgs,
              "usage: xapi-to workers secrets list <worker-id> --env ENV",
            ),
            environment(flags.env),
          ),
        );
        return;
      }
      if (action === "status") {
        assertFlags(flags,["env"]);
        output(await client.workerSecretProviderStatus(options(),oneId(secretArgs,"usage: xapi-to workers secrets status <worker-id> --env ENV"),environment(flags.env)));
        return;
      }
      if (action === "set") {
        assertFlags(flags, ["env", "from-env", "stdin", "env-file"]);
        if (secretArgs.length !== 2) {
          err(
            "usage: xapi-to workers secrets set <worker-id> <NAME> --env ENV (--from-env VARIABLE | --stdin | --env-file .env)",
          );
        }
        const value=await secretValue(flags,secretArgs[1]);
        output(
          await client.putWorkerSecret(
            options(),
            secretArgs[0],
            environment(flags.env),
            secretArgs[1],
            value,
          ),
        );
        return;
      }
      if(action==="apply") {
        assertFlags(flags,["env","env-file","delete"]);
        const id=oneId(secretArgs,"usage: xapi-to workers secrets apply <worker-id> --env ENV --env-file .env [--delete NAME,NAME]");
        if(!flags['env-file']||flags['env-file']==='true')err('--env-file requires a path');
        const values=parseWorkerSecretEnv(await readFile(resolve(flags['env-file']),'utf8'));
        const deletes=(flags.delete&&flags.delete!=='true'?flags.delete.split(',').map(name=>name.trim()).filter(Boolean):[]);
        if(!Object.keys(values).length&&!deletes.length)err('secret apply input is empty');
        const duplicates=deletes.filter(name=>Object.hasOwn(values,name));
        if(duplicates.length)err(`cannot set and delete the same secret: ${duplicates.join(', ')}`);
        output(await client.applyWorkerSecrets(options(),id,environment(flags.env),[
          ...Object.entries(values).map(([name,value])=>({name,value})),
          ...deletes.map(name=>({name,delete:true})),
        ]));
        return;
      }
      if (action === "delete") {
        assertFlags(flags, ["env", "yes"]);
        if (secretArgs.length !== 2) {
          err(
            "usage: xapi-to workers secrets delete <worker-id> <NAME> --env ENV --yes",
          );
        }
        if (flags.yes !== "true") {
          err("refusing to delete a secret without --yes");
        }
        output(
          await client.deleteWorkerSecret(
            options(),
            secretArgs[0],
            environment(flags.env),
            secretArgs[1],
          ),
        );
        return;
      }
      err("usage: xapi-to workers secrets <list|status|set|apply|delete> ...");
    }
    case "provider-status":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers provider-status");
      output(await client.workerProviderStatus(options()));
      return;
    case "capabilities":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers capabilities");
      output(await client.workerProviderCapabilities(options()));
      return;
    case "artifact-provider-status":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers artifact-provider-status");
      output(await client.workerArtifactProviderStatus(options()));
      return;
    case "build-provider-status":
      assertFlags(flags);
      if (rest.length) err("usage: xapi-to workers build-provider-status");
      output(await client.workerBuildProviderStatus(options()));
      return;
    case "delete":
      assertFlags(flags, ["yes"]);
      if (flags.yes !== "true")
        err("refusing to delete without --yes", {
          retention: "soft-deleted for 30 days",
        });
      output(
        await client.deleteWorker(
          options(),
          oneId(rest, "usage: xapi-to workers delete <worker-id> --yes"),
        ),
      );
      return;
    default:
      err(`unknown workers command: ${command}`, {
        hint: "run xapi-to workers --help",
      });
  }
}
