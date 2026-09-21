# Workers open-source deployment findings — 2026-09-21

## Scope

This record covers two real preview deployments:

- a Next.js 16 application adapted with Vinext and packaged as Wrangler's
  native multipart bundle;
- a Vite SPA with a Worker-first `/api/*` route and xAPI AI calls.

Both applications were published through xAPI Workers. Wrangler was used only
for local framework packaging where needed.

## Existing platform work that must not be duplicated

xapi-backend PRs #248 and #250 already provide the backend contract used by
these deployments:

- complete code-module and static-asset Artifacts;
- multipart upload with bounded memory and integrity verification;
- native Smart Placement metadata;
- D1/R2 default resource location;
- web-application completeness checks before provider or financial effects.

#250 is the clean promotion replay of #248, not a second implementation. This
CLI branch must remain complementary to that backend work.

## Confirmed CLI gaps addressed here

1. Generated Wrangler metadata such as `configPath`, `userConfigPath`, and
   `definedEnvironments` was reported as unsupported even though it is build
   provenance, not Worker runtime state.
2. Wrangler `vars` were combined with Secret names. Public values must not be
   copied, leaked into reports, or silently converted into Secrets.
3. Wrangler imports always generated `npm run build` and
   `dist/worker.mjs`, even when a framework package already declared a native
   `build:worker` command and `--outfile` bundle.
4. The repository may contain Workers commands before the currently published
   npm package. Skills need to detect and report that release mismatch.
5. Project commands and low-level Artifact primitives appeared in one flat help
   list. Help now makes `plan → push → promote` the normal path and labels
   `build`, `upload`, and `deploy` as custom-CI or recovery operations.
6. Runtime inspection required several separate commands. `workers inspect`
   now provides one read-only report while preserving failed sources as
   `UNKNOWN` and excluding Secret values.

## Deferred backend work

The following should be implemented only after the native deployment candidate
has completed its normal dev → staging → main promotion:

- first-class desired state and API mutations for Cloudflare `plain_text`
  bindings;
- one correlation ID spanning Dispatcher/User Worker logs and downstream xAPI
  AI usage records;
- structured runtime error classes that distinguish Worker, xAPI gateway,
  provider, authentication, and response-schema failures.

Until plain-text bindings exist, the importer fails closed on non-empty
Wrangler `vars`. `--accept-partial` records an explicit user decision but still
does not copy their values.

## Items confirmed outside platform scope

- model output that omitted application-specific JSON fields;
- selecting Gemini or DeepSeek instead of native Jev;
- drone hover/landing control behavior;
- browser-cookie quotas;
- absence of KV, D1, R2, Queue, Durable Object, or Workflow when the application
  does not require them.

These are application design or integration concerns and must not be fixed by
restricting the Workers platform.
