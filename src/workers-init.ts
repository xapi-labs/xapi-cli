import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "path";
import {
  WORKER_PROJECT_SCHEMA_URL,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
} from "./workers-project.ts";
import {
  loadWorkerTemplate,
  renderWorkerTemplateFiles,
  type WorkerTemplate,
} from "./workers-templates.ts";
import { initExistingFrameworkProject } from "./workers-framework-init.ts";

export type WorkerStarterTemplate = string;

export interface InitWorkerProjectOptions {
  cwd?: string;
  target?: string;
  template?: WorkerStarterTemplate;
  name?: string;
  slug?: string;
  previewDailyBudgetUsd?: number;
  productionDailyBudgetUsd?: number;
  force?: boolean;
  compatibilityDate?: string;
  framework?: string;
}

export interface InitWorkerProjectResult {
  rootDir: string;
  configPath: string;
  template: WorkerStarterTemplate;
  files: string[];
  nextSteps: string[];
  mode?: "new" | "existing";
  framework?: string;
}

const COMMON_MANAGED_FILES = [
  ".gitignore",
  "README.md",
  "package.json",
  "tsconfig.json",
  "wrangler.jsonc",
  "xapi.worker.json",
] as const;

function safeTarget(cwd: string, target: string): string {
  if (!target || target.includes("\0") || isAbsolute(target)) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_target",
      "Worker project target must be a relative path",
    );
  }
  const parts = target.split(/[\\/]/);
  if (parts.includes("..")) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_target",
      "Worker project target must not contain '..'",
    );
  }
  const rootDir = resolve(cwd, target);
  const traversal = relative(cwd, rootDir);
  if (
    traversal === ".." ||
    traversal.startsWith(`..${sep}`) ||
    isAbsolute(traversal)
  ) {
    throw new WorkerProjectConfigError(
      "worker_init_target_outside_cwd",
      "Worker project target must stay inside the current directory",
    );
  }
  let cursor = cwd;
  for (const part of traversal.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new WorkerProjectConfigError(
        "worker_init_symlink_target",
        `Worker project target crosses a symbolic link: ${cursor}`,
      );
    }
  }
  return rootDir;
}

function inferredSlug(rootDir: string): string {
  return basename(rootDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
}

function validateSlug(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,47}[a-z0-9]$/.test(value)) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_slug",
      "Worker slug must be 3-49 lowercase characters and may contain digits or hyphens",
    );
  }
  return value;
}

function displayName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function projectFiles(
  slug: string,
  name: string,
  template: WorkerTemplate,
  previewDailyBudgetUsd: number,
  productionDailyBudgetUsd: number,
  compatibilityDate: string,
): Record<string, string> {
  const config: WorkerProjectConfig = {
    $schema: WORKER_PROJECT_SCHEMA_URL,
    version: 1,
    worker: {
      name,
      slug,
      template: template.productTemplate,
      description: `${template.name} template v${template.version}`,
    },
    wrangler: "wrangler.jsonc",
    build: { command: "npm run build", output: "dist/worker.mjs" },
    environments: {
      preview: {
        dailyBudgetUsd: previewDailyBudgetUsd,
        healthCheck: "/health",
        resources: template.defaultResources,
        secrets: template.defaultSecrets,
      },
      production: {
        dailyBudgetUsd: productionDailyBudgetUsd,
        healthCheck: "/health",
        resources: template.defaultResources,
        secrets: template.defaultSecrets,
      },
    },
  };
  return {
    ".gitignore": "node_modules\ndist\n.dev.vars\n.env*\n!.env.example\n",
    "README.md": `# ${name}\n\nCreated from xAPI Worker template \`${template.id}@${template.version}\`.\n\n${template.description}\n\n\`\`\`bash\nnpm install\nnpm run dev\nnpm run build\nxapi workers plan --env preview\nxapi workers push --env preview\n\`\`\`\n\nDeclared resources are provisioned and bound by xAPI during plan/push. Set runtime secrets with \`xapi workers secrets set\`; never commit secret values to this project.\n`,
    "package.json": `${JSON.stringify(
      {
        name: slug,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          build:
            "esbuild src/index.ts --bundle --format=esm --platform=neutral --target=es2022 --outfile=dist/worker.mjs",
          dev: "wrangler dev",
          typecheck: "tsc --noEmit",
          ...template.packageScripts,
        },
        devDependencies: {
          esbuild: "^0.25.0",
          typescript: "^5.9.0",
          wrangler: "^4.0.0",
        },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "WebWorker"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "wrangler.jsonc": `${JSON.stringify(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        name: slug,
        main: "src/index.ts",
        compatibility_date: compatibilityDate,
      },
      null,
      2,
    )}\n`,
    "xapi.worker.json": `${JSON.stringify(config, null, 2)}\n`,
    ...renderWorkerTemplateFiles(template, {
      PROJECT_NAME: name,
      PROJECT_SLUG: slug,
      COMPATIBILITY_DATE: compatibilityDate,
      PREVIEW_DAILY_BUDGET_USD: String(previewDailyBudgetUsd),
      PRODUCTION_DAILY_BUDGET_USD: String(productionDailyBudgetUsd),
    }),
  };
}

export function initWorkerProject(
  options: InitWorkerProjectOptions = {},
): InitWorkerProjectResult {
  const cwd = resolve(options.cwd || process.cwd());
  const target = options.target || ".";
  const rootDir = safeTarget(cwd, target);
  const template = loadWorkerTemplate(options.template || "worker");
  const slug = validateSlug(options.slug || inferredSlug(rootDir));
  const name = options.name?.trim() || displayName(slug);
  if (name.length < 2 || name.length > 80) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_name",
      "Worker name must be between 2 and 80 characters",
    );
  }
  const compatibilityDate =
    options.compatibilityDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
    throw new WorkerProjectConfigError(
      "worker_init_invalid_compatibility_date",
      "compatibilityDate must use YYYY-MM-DD",
    );
  }
  const previewDailyBudgetUsd = options.previewDailyBudgetUsd ?? 0.25;
  const productionDailyBudgetUsd = options.productionDailyBudgetUsd ?? 2;
  for (const [environment, amount] of [
    ["preview", previewDailyBudgetUsd],
    ["production", productionDailyBudgetUsd],
  ] as const) {
    if (!Number.isFinite(amount) || amount < 0.1 || amount > 100) {
      throw new WorkerProjectConfigError(
        "worker_init_invalid_budget",
        `${environment} daily budget must be between 0.10 and 100 USD`,
      );
    }
  }
  if (existsSync(rootDir)) {
    if (!lstatSync(rootDir).isDirectory()) {
      throw new WorkerProjectConfigError(
        "worker_init_target_not_directory",
        `Worker project target is not a directory: ${rootDir}`,
      );
    }
    const entries = readdirSync(rootDir);
    if (entries.length && !options.force) {
      if (existsSync(join(rootDir, "package.json"))) {
        const adopted = initExistingFrameworkProject({
          rootDir,
          name,
          slug,
          compatibilityDate,
          previewDailyBudgetUsd,
          productionDailyBudgetUsd,
          framework: options.framework,
        });
        return {
          rootDir,
          configPath: adopted.configPath,
          template: "worker",
          files: adopted.files,
          nextSteps: adopted.nextSteps,
          mode: "existing",
          framework: adopted.framework,
        };
      }
      throw new WorkerProjectConfigError(
        "worker_init_target_not_empty",
        `Worker project target is not empty and has no package.json: ${rootDir}`,
      );
    }
  } else {
    mkdirSync(rootDir, { recursive: true });
  }

  const files = projectFiles(
    slug,
    name,
    template,
    previewDailyBudgetUsd,
    productionDailyBudgetUsd,
    compatibilityDate,
  );
  const managedFiles = [...COMMON_MANAGED_FILES, ...template.files.map((file) => file.target)];

  // Preflight every managed path before writing anything. This prevents a
  // partially overwritten project when a nested directory (for example src/)
  // is a symbolic link to a location outside the project.
  for (const file of managedFiles) {
    const absolute = join(rootDir, file);
    let cursor = rootDir;
    for (const part of relative(rootDir, absolute).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new WorkerProjectConfigError(
          "worker_init_symlink_file",
          `Refusing to write through symbolic link: ${cursor}`,
        );
      }
    }
  }
  for (const file of managedFiles) {
    const absolute = join(rootDir, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, files[file], { encoding: "utf8", flag: "w" });
  }
  return {
    rootDir,
    configPath: join(rootDir, "xapi.worker.json"),
    template: template.id,
    files: managedFiles,
    nextSteps: [
      `cd ${relative(cwd, rootDir) || "."}`,
      "npm install",
      "npm run dev",
      "xapi workers plan --env preview",
      "xapi workers push --env preview",
    ],
    mode: "new",
  };
}
