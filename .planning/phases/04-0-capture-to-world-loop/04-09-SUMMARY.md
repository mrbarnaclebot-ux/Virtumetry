---
phase: 04-0-capture-to-world-loop
plan: 09
subsystem: deploy + phase gate
tags: [docker, railway-dev, budget, uat]
requires: [04-08]
provides: [image-ships-mock-outputs, budget-reset-dev, phase-4-uat-checklist]
affects: [Dockerfile, .dockerignore, backend/scripts, virtumetry/README.md]
tech-stack:
  added: []
  patterns: [dev-guarded operator script with exported pure helper + spawn guard test]
key-files:
  created:
    - backend/scripts/budget-reset-dev.ts
    - backend/test/integration/budget-reset-dev.pg.test.ts
    - backend/test/docker-mock-outputs.test.ts
    - .planning/phases/04-0-capture-to-world-loop/04-HUMAN-UAT.md
  modified:
    - Dockerfile
    - .dockerignore
    - backend/package.json
    - backend/src/provider/mock.ts
    - virtumetry/README.md
decisions:
  - "budget:reset-dev guards MIGRATE_DATABASE_URL (direct Neon dev host), same as seed:library, not DATABASE_URL"
metrics:
  duration: 15min
  completed: 2026-11-24
---

# Phase 4 Plan 09: Make the loop runnable on the phone Summary

The Railway image now ships the mock provider's outputs so dev scans can reach Ready. A dev-guarded `npm run budget:reset-dev` clears today's mock spend. The exact dev env values and an 11-step Expo Go owner checklist are in 04-HUMAN-UAT.md. Both full gates are green.

## Railway dev env values

Railway project, **dev environment only**. Production: unchanged. ALLOW_PAID_PROVIDER: unset.

| Variable | Service(s) | Value |
|----------|------------|-------|
| `CAPTURE_CONFIG_JSON` | api, worker | `{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}` |
| `DAILY_CREDIT_BUDGET` | api, worker | `10000` |
| `MONTHLY_CREDIT_BUDGET` | api, worker | `100000` |
| `DAILY_SCAN_QUOTA` | api | `30` |
| `TRACK_POLL_SECONDS` (optional) | worker | `10` |
| `MOCK_PROCESSING_SECONDS` (optional) | worker | `20` |

Then redeploy dev api + worker from this commit (the Dockerfile now ships mock-outputs). `capture-config.ts` merges partial JSON over defaults, so the omitted keys keep their default values.

## Tasks

| # | Task | Commit |
|---|------|--------|
| 1 | Ship mock outputs in the image + guarded budget:reset-dev | 6321ca2 |
| 2 | Dev env values, owner UAT checklist, README Phase 4 section | 128e10f |

## Phase gate results

- App: `npx expo lint` clean, `npx tsc --noEmit` clean, `npx jest --ci` 19 suites / 195 tests passed.
- Backend: `npx tsc --noEmit` clean, `npx vitest run` 343 passed (93 pg/s3 skipped), `npm run test:pg` 14 files / 101 tests passed (1 skipped).
- No `docker build` was run (the plan says it's optional). The Dockerfile and .dockerignore lines are asserted by `test/docker-mock-outputs.test.ts`.

## Deviations from Plan

1. **[Rule 1 - Bug] budget:reset-dev guards `MIGRATE_DATABASE_URL`, not `DATABASE_URL`.** `assertDevDb` takes a variable name and refuses `-pooler` hosts. The repo's direct dev host lives in MIGRATE_DATABASE_URL, which is the same variable that seed:library and test-pg use. The guard test spawns the script with a non-dev URL in that variable.
2. **mock.ts comment updated.** The old comment said the outputs were "not in the Docker image"; it now points at the COPY instead. This is a comment-only change.

## Requirements

CAP-01, CAP-05, CAP-07 and CAP-10 are marked complete: prep/priming, the remotely tunable readiness meter, the mini-map and the fixture source are all delivered in code and tests across plans 04-04..04-08. PROC-03 stays Pending, because background continuation while the phone is locked or the app suspended can only be checked on a device (Phase 8 dev build). The force-quit resume part is covered by jest and UAT step 10.

## Known Stubs

None.

## Self-Check: PASSED

- All created files exist; commits 6321ca2 and 128e10f are in git log.
