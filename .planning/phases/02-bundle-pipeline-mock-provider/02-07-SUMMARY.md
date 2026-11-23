---
phase: 02-bundle-pipeline-mock-provider
plan: 07
subsystem: backend/pipeline
tags: [scenarios, budget, concurrency, e2e, readme, mock-provider]
requires: [02-05 startPipeline harness + pipeline handlers, 02-04 mock provider scenarios, 02-03 S3 storage driver, 02-02 config + guarded scripts]
provides: [PROC-10 scenario matrix (SC4), concurrent over-budget refusal proof (SC5), npm run fixture:e2e, npm scripts db:migrate:dev / test:pg / test:r2, Phase 2 README]
affects: [backend/src/pipeline.ts (export-pending recheck), backend/test/helpers/pipeline.ts (drain deps override)]
tech-stack:
  added: []
  patterns: [one fresh pipeline per scenario, Promise.all of two drains with distinct workerIds, guarded dev-resource script with refusals before any write]
key-files:
  created: [backend/test/integration/scenarios.pg.test.ts, backend/scripts/fixture-e2e.ts]
  modified: [backend/src/pipeline.ts, backend/test/helpers/pipeline.ts, backend/package.json, backend/README.md]
decisions:
  - "Export-pending re-checks after min(TRACK_POLL_SECONDS, 5) s instead of the full poll interval (one line, not configurable)"
  - "Dead-job → world-failed gap (02-05) left open: no scenario leaves a world non-terminal; deferred, see below"
metrics:
  duration: ~25 min
  completed: 2026-11-23
  tasks: 2
  files: 6
requirements-completed: [PROC-10, PROC-08, PROC-04, PROC-07]
---

# Phase 2 Plan 07: Failure scenarios, concurrent budget, fixture:e2e, README Summary

Scripted FAILED, 402, 409, 429 and 503 each end in their documented state with one submission key and no extra submit. Two concurrent over-cap scans produce exactly one reservation, and the refused scan never reaches the provider. `npm run fixture:e2e` took the committed fixture to `ready` on virtumetry-dev R2 + Neon dev with the mock ($0) and purged everything afterwards.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Scenario matrix + concurrent over-budget refusal against real Postgres | 5adbaf4 |
| 2 | fixture:e2e dev loop on virtumetry-dev + README + phase gate run | 5884400 |

## Scenario results (`scenarios.pg.test.ts`, 6/6 passed, none skipped)

| Scenario | End state | Submits | Ledger |
|---|---|---|---|
| failed | failed / processing / WORLD_GENERATION_FAILED, charged false | 1 | reserve + release (release dated at the reservation), net 0 |
| 402 | failed / submit / INSUFFICIENT_CREDITS | 1 | reserve + release, net 0 |
| 409 | failed / submit / IDEMPOTENCY_KEY_REUSED, submit job `dead`, key unchanged | 1 | reserve only (kept) |
| 429 | ready | 2, same key, byte-identical body | reserve only |
| 503 | ready | 2, same key, byte-identical body | reserve only |
| concurrent (daily = 1.5 x quote) | one past submitting, one failed / submit / BUDGET_EXCEEDED | 1 (the winner's key) | exactly one reserve row (the winner) |

No handler bug was exposed.

## Verification (phase gate)

- `npx tsc --noEmit`: clean
- `npx vitest run`: 32 files passed, 7 skipped; **293 tests passed**, 37 skipped (Phase 1 baseline 229)
- `npm run test:pg -- test/integration`: 6 files passed, 1 skipped (R2); **36 tests passed**, 1 skipped
- `npm run test:r2`: 1/1 passed
- `npm run fixture:e2e`: exit 0, output has no `https://` and no `postgres://`
- Refusals checked: `S3_BUCKET=virtumetry-prod` exits 1 (config isolation), `PROVIDER_MODE=live` exits 1 (paid guard), `PROVIDER_MODE=live ALLOW_PAID_PROVIDER=1` exits 1 (`PROVIDER_MODE refused: must be mock`), all before any write

### fixture:e2e log (ids/keys/timings only)

```
[e2e +31.3s] world 614cb07a-d514-49c0-9857-9087cfae5181 capture 992c5f0e-b183-4d05-a49c-e8bcec461520: uploaded 32 files (30 frames)
[e2e +33.1s] status packing
[e2e +70.3s] status submitting
[e2e +81.2s] status processing
[e2e +82.8s] status importing
[e2e +98.7s] status ready
[e2e +98.9s] bundle bundles/992c5f0e-b183-4d05-a49c-e8bcec461520/capture_bundle.zip (1573439 bytes)
[e2e +99.3s] asset worlds/614cb07a-d514-49c0-9857-9087cfae5181/v1/cameras.json (21407 bytes)
[e2e +99.3s] asset worlds/614cb07a-d514-49c0-9857-9087cfae5181/v1/collider.ply (359 bytes)
[e2e +99.3s] asset worlds/614cb07a-d514-49c0-9857-9087cfae5181/v1/floorplan.json (982 bytes)
[e2e +99.3s] asset worlds/614cb07a-d514-49c0-9857-9087cfae5181/v1/floorplan.png (203 bytes)
[e2e +99.3s] asset worlds/614cb07a-d514-49c0-9857-9087cfae5181/v1/splat.ply (805 bytes)
[e2e +99.3s] submission key ef7d8c51-3338-4395-a436-6e21bdf3d5c2, credits 930
[e2e +120.9s] purged captures/992c5f0e-b183-4d05-a49c-e8bcec461520/: 0 objects left
[e2e +121.2s] purged bundles/992c5f0e-b183-4d05-a49c-e8bcec461520/: 0 objects left
[e2e +121.6s] purged worlds/614cb07a-d514-49c0-9857-9087cfae5181/: 0 objects left
```

Most of the wall time is laptop-to-Neon/R2 round trips (fixture upload ~31 s, pack ~37 s).

## Deviations from Plan

1. **[Rule 3 - Blocking] `drain()` takes an optional `deps` override** (test/helpers/pipeline.ts). The concurrent test needs two drains with different workerIds. Commit 5adbaf4.
2. **Optional gap 2 (from 02-06) done:** after an export-pending response, track now re-checks after `min(TRACK_POLL_SECONDS, 5)` s instead of the full poll interval (one line in src/pipeline.ts). Commit 5adbaf4.
3. README had no env table, so I added an "Environment (Phase 2 additions)" table instead of extending one.

## Deferred Issues

- **Gap 1 (from 02-05), not fixed:** a pack/submit/track job that dies through the generic `failJob` path (5 thrown errors, or a lease that expires on its last attempt) is parked dead without failing its world, so the world stays in `packing`/`submitting`/`processing`. None of the scripted scenarios reach this: 429/503 are bounded by `SUBMIT_MAX_ATTEMPTS = 4` and end in `refuse`, and 409 calls `failWorld` before it parks the job. The plan only allows src/pipeline.ts fixes that a scenario test proves. Suggested fix (worker.ts): when `failJob` returns `'dead'` or `reapExhaustedJobs` parks a pipeline job, call `failWorld(db, job.worldId, [non-terminal statuses], stage-by-kind, 'JOB_EXHAUSTED', ...)`. Do not release credits there, because the outcome is uncertain. Do this before Phase 6.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: backend/test/integration/scenarios.pg.test.ts, backend/scripts/fixture-e2e.ts
- FOUND commits: 5adbaf4, 5884400
