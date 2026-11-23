# Phase 1: Isolated Backend Fork - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-23
**Phase:** 1-Isolated Backend Fork
**Areas discussed:** Copy & strip scope, Neon topology, R2 + secrets layout, Railway topology & deploy, CI & push (all auto-selected, `--auto`)

---

## Copy & strip scope
| Option | Description | Selected |
|--------|-------------|----------|
| Copy verbatim, then strip in separate commits | Reviewable diff | ✓ |
| Re-scaffold and port selectively | More work, loses tests | |
[auto] → recommended. Fresh migration history (D-05) chosen over replaying VirtSpace migrations.

## Neon topology
| Option | Description | Selected |
|--------|-------------|----------|
| One project, `production` + `dev` branches | Neon-idiomatic, cheap | ✓ |
| Two separate projects | Stronger isolation, more admin | |
[auto] → recommended.

## R2 + secrets layout
| Option | Description | Selected |
|--------|-------------|----------|
| `virtumetry-dev` / `virtumetry-prod`, secrets in `backend/.env` | Env-specific, app holds no backend secrets | ✓ |
| One bucket with prefixes | Easier, weaker isolation | |
[auto] → recommended.

## Railway topology & deploy
| Option | Description | Selected |
|--------|-------------|----------|
| New project, api + worker, IaC, `railway up` | Same proven pattern as VirtSpace | ✓ |
| GitHub-linked auto deploy | Deploys on every push | |
[auto] → recommended.

## CI & push
| Option | Description | Selected |
|--------|-------------|----------|
| GitHub Actions in private repo, backend + app workflows | Free Linux minutes, saves EAS CI | ✓ |
| EAS Workflows | Burns 60 free CI minutes | |
[auto] → recommended.

## Claude's Discretion
Route/table deletion list, reaper/purge keep vs stub, Node base image variant.

## Deferred Ideas
Better Auth (P3), ReconProvider/Echo-3 (P2/P6), push (P7), retention (P9).
