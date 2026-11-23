---
phase: 01-isolated-backend-fork
plan: 07
subsystem: ci
tags: [github-actions, ci, push]
requirements-completed: [FND-01, FND-05]
key-files:
  created: [.github/workflows/backend.yml, .github/workflows/app.yml]
  modified: [backend/package-lock.json, .railway/package.json, .railway/package-lock.json]
---

# Plan 01-07: CI workflows and push — Summary

**Workflows written and pushed; GitHub refused to start the runs because of an account billing hold. FND-05 green-run proof is pending owner billing fix.**

## Done
- `backend.yml` (paths `backend/**`, Node 24, `npm ci`, `tsc --noEmit`, `vitest run`, no Python; `TEST_DATABASE_URL` secret enables integration suites).
- `app.yml` (paths `virtumetry/**`, writes `expo-env.d.ts` first, `expo lint`, `tsc --noEmit`).
- Pre-push gates passed: no tracked `.env`, no `.env` in any of 34 pushed commits, secret-value scan of full pushed history clean (only placeholder `user:pass` URLs), FND-01 grep clean, leftover `virtspace-*` package names renamed (c661c14).
- Pushed `fec8a04..c661c14` to `origin/main` (fast-forward).

## Blocked
- Runs 45150189343 (backend) and 45150189815 (app) failed in ~4 s with zero steps: "The job was not started because recent account payments have failed or your spending limit needs to be increased."
- Owner chose to continue without CI for now. To finish FND-05: fix billing, then `gh run rerun 45150189343 -R mrbarnaclebot-ux/Virtumetry` and `gh run rerun 45150189815 -R mrbarnaclebot-ux/Virtumetry`.

## Local evidence standing in for CI
- Backend full suite with `TEST_DATABASE_URL` = Neon dev direct host: **29 files, 241/241 passed**, including `integration/queue.pg.test.ts` (7) and `integration/quota.pg.test.ts` (5).
- App: `npx expo lint` and `npx tsc --noEmit` clean.

## Commits
- 6a0d39d ci: backend.yml without Python + app.yml
- c661c14 chore: rename leftover virtspace package names


## CI resolved (2026-11-23)

The repo was made public, so GitHub Actions runs again. Reruns of 45150189343 (backend, 241/241 incl. queue.pg + quota.pg) and 45150189815 (app) both passed. FND-05 is complete.
