# 9. Release through a release pull request, Conventional Commits and squash merges

- Status: Accepted (replaces the tag-on-change releases of #34)
- Decided: 2026-11-23
- Changes: #52, #58, #63

## Context

Releases were cut for every change that shipped, which was too often and gave no place to review what a release contains.

## Decision

release-please keeps a pull request `chore(main): release X.Y.Z` open on `main`; merging it tags the version, creates the GitHub release and builds the zips. The version comes from Conventional Commits (`feat` minor, `fix` / `perf` / `revert` patch, `!` major), enforced on pull requests by `scripts/check-commits.js`. `main` accepts squash merges only, so one pull request is one changelog line. A preview build can be started by hand from any branch and publishes nothing.

## Consequences

- The pull request title is the changelog entry; a wrong one is corrected with a `BEGIN_COMMIT_OVERRIDE` block in the body, not by editing the changelog.
- `version` in `package.json` is never edited by hand.
- Branches are not stacked on unmerged work, because a squash merge makes them conflict.
