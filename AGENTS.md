# Project instructions

This file applies to the entire `xapi-cli` repository. The repository publishes
the `xapi-to` npm package and the `xapi`/`xapi-to` executables.

## Required verification

Before completing a code or release-related change, run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
npm pack --dry-run --ignore-scripts
```

Report each command that passed. Do not describe these checks as npm, GitHub
Release, or live xAPI end-to-end verification.

## Release source of truth

- Release Please is the only authority for release versions, release tags,
  generated changelog entries, and GitHub Releases.
- Do not run `npm version`, create a release tag, create a GitHub Release, or
  edit the package version as part of an ordinary feature or fix.
- Do not directly edit an already released section of `CHANGELOG.md`.
- Do not publish from an arbitrary branch or commit. Normal publication must
  come from a Release Please tag; recovery publication must check out that
  existing tag.
- AI may improve release-note inputs and wording, but it must not decide the
  version, tag, or whether a release is published.

## Commit and pull request titles

Use Conventional Commits for every commit that can reach `main`:

- `feat(scope): ...` for user-visible functionality
- `fix(scope): ...` for user-visible bug fixes
- `perf(scope): ...` for measurable performance improvements
- `docs(scope): ...` for documentation-only changes
- `test(scope): ...` for tests only
- `refactor(scope): ...` for behavior-preserving restructuring
- `build(scope): ...` or `ci(scope): ...` for build and automation changes
- `chore(scope): ...` for internal maintenance
- `revert(scope): ...` when reverting a released change
- Add `!` and a `BREAKING CHANGE:` footer for breaking changes

Write subjects from the user's perspective and describe behavior or benefit,
not just implementation. Do not include secrets, internal incidents, raw
prompts, or speculative claims.

Prefer squash merging and make the pull request title the final Conventional
Commit subject. If a pull request is merged without squash, every included
commit must follow these rules.

## Changelog classification for bundled skills

The `skills/` directory is shipped in the npm package, so it is product content:

- Use `feat(skill): ...` when a bundled skill gains a user-visible workflow,
  capability, or supported behavior.
- Use `fix(skill): ...` when skill instructions, action IDs, safety rules, or
  executable workflows are corrected.
- Use `docs(skill): ...` only for explanation or wording that does not change
  what an agent is instructed to do.

Before finishing a task, verify that its final commit or PR classification will
produce an accurate release note.

## Normal release procedure

1. Develop changes in a pull request. Make the final PR title a clear
   Conventional Commit subject and ensure CI passes.
2. Merge the development PR into `main`. Do not change `package.json` version.
3. Wait for the `Release` workflow to update or open the Release Please PR.
4. Review the Release Please PR before merging it:
   - Confirm the proposed SemVer matches the commit types. Before 1.0, ordinary
     `feat` and `fix` changes increment patch; a breaking change increments
     minor under this repository's configuration.
   - Confirm `package.json`, `.release-please-manifest.json`, the proposed tag,
     and the top `CHANGELOG.md` heading all use the same version.
   - Confirm every user-visible CLI and bundled-skill change is present and
     understandable, with migration steps for breaking changes.
   - Remove secrets, internal-only details, unsupported promises, duplicate
     entries, and implementation-only noise.
   - Confirm required checks and human approvals pass.
5. If wording needs improvement, prefer correcting the Conventional Commit/PR
   input before it reaches `main`. Changes made directly to an open generated
   Release Please PR can be replaced when the bot updates that PR, so re-review
   it after every update.
6. Merge the Release Please PR only when the team intends to publish. The next
   `Release` workflow run verifies the tagged commit, creates the GitHub Release,
   and publishes the same version to npm.
7. After publication, verify all of the following:
   - The GitHub Release and `vX.Y.Z` tag exist on the Release Please merge commit.
   - `npm view xapi-to@X.Y.Z version` returns the expected version.
   - `npx xapi-to@X.Y.Z --help` starts successfully on a supported Node version.
   - The GitHub Release notes match the released `CHANGELOG.md` section.

## First Release Please rollout

- Before merging the rollout PR, complete this one-time repository setup:
  1. In GitHub Actions settings, grant workflow `GITHUB_TOKEN` read/write
     permission and allow Actions to create pull requests.
  2. Confirm the `npm_token` Actions secret is a valid npm access token with
     publish permission for `xapi-to`.
  3. Decide whether Release Please PRs must run required checks. If they must,
     configure a narrowly scoped `RELEASE_PLEASE_TOKEN`, because events created
     by the default `GITHUB_TOKEN` do not trigger another workflow.
  4. Confirm no `v0.1.19` tag, GitHub Release, or npm version already exists.
  5. Protect `main` from direct feature/release pushes and require human review
     of the Release Please PR.
- The checked-in baseline is `0.1.18`, the latest GitHub/npm release when
  Release Please was introduced.
- `bootstrap-sha` is the `v0.1.18` commit, so the first generated changelog must
  contain only later commits.
- With the configured pre-1.0 policy, the current releasable changes should
  normally produce `0.1.19`. Unless a new intentional `BREAKING CHANGE` was
  merged after this rollout, treat another first proposed version or inclusion
  of older history as a migration error and do not merge the release PR.
- After the rollout PR reaches `main`, the `Release` workflow should open the
  first Release Please PR. Review it using the normal release procedure above;
  merging that generated PR is the explicit decision to publish `0.1.19`.

## Publication failure recovery

- If the `publish` job fails after the GitHub Release was created, rerun only
  the failed `publish` job in that same workflow run. Do not rerun the entire
  workflow first, because Release Please will no longer report a new release.
- If the original run cannot be reused, run the `Release` workflow manually and
  provide the exact existing tag, such as `v0.1.19`. The recovery path checks
  out that tag and refuses a tag/package version mismatch.
- Before recovery, confirm `npm view xapi-to@X.Y.Z version` does not already
  return the version. npm versions are immutable; never reuse or overwrite one.
- Never create a replacement tag or increment a version merely to hide a failed
  publication. Diagnose the failure, preserve the existing GitHub Release, and
  publish the matching package version.
