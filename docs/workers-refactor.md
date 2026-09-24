# Workers consolidation — 2026-09-23

Development branch: `feature/workers-refactor`, created from current `origin/main`.
This is a development baseline, not a release approval. No version, tag, global CI workflow, or production environment changed.

Sources: #31 (`a6a3016`, native placement/metadata), #35 (`1ade83c`, Container + skill), #34 (`c48bb0a`, managed initial DO migrations / workspace and large-artifact compatibility). Duplicate Wrangler metadata changes are included once. Existing main inspect/plan and credentials handling are preserved. Container declarations now survive multipart serialization, covered by a failing-then-passing client test.

Open P1 carried forward: #31 discussion_r4057644575 (placementMode omitted from deployment identity). The combined PR uses feat(skill) to satisfy bundled-skill release classification. Do not mark runtime P1 resolved because old PRs are superseded. #37 Release Please stays open and unmerged.

Verification: bun install --frozen-lockfile; bun run typecheck; bun run build; bun run test (550 pass); npm pack --dry-run --ignore-scripts — all passed. No live xAPI / npm publish verification is claimed.

Cross-repository inventory: xapi-backend, docs/plan/workers-refactor/README.md on the same branch. No protected-branch reset and no unrelated worktree changes.
