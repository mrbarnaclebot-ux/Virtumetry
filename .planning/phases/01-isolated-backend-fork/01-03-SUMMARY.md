---
phase: 01-isolated-backend-fork
plan: 03
subsystem: backend
tags: [strip, routes, schema, queue]
requires: [01-01]
provides:
  - "routes/worlds.ts: create / presign / uploads:refresh / frames:done / get / list / delete only"
  - "frames:done terminal flip uploading -> uploaded, no job enqueued (job_id null)"
  - "schema: 5 world statuses, JOB_KINDS ['purge'], no World Labs columns"
affects: [01-04, 01-05]
tech-stack:
  added: []
  patterns: ["conditional UPDATE as the state gate, side writes in the same tx"]
key-files:
  created: []
  modified:
    - backend/src/routes/worlds.ts
    - backend/src/storage/index.ts
    - backend/src/db/schema.ts
    - backend/test/frames-done.test.ts
    - backend/test/upload-size.test.ts
    - backend/test/atomic-flip.test.ts
    - backend/test/worlds.idempotency.test.ts
    - backend/test/worlds.uploads-refresh.test.ts
    - backend/test/zod-contract.test.ts
    - backend/test/queue.lease.test.ts
    - backend/test/integration/queue.pg.test.ts
    - backend/test/worlds.list.test.ts
    - backend/test/quota.charge.test.ts
    - backend/test/worker.progress.test.ts
  deleted:
    - backend/src/depth.ts
    - backend/test/worlds.enhance.test.ts
    - backend/test/worlds.retry.test.ts
decisions:
  - "frames:done only flips from 'uploading' (failed_stitch re-entry gone); replay from any other status is 200, job_id null, no writes"
  - "Pose fields featureDepthMedian and depth dropped from the typed schema; .passthrough() still stores any extra keys verbatim"
  - "budget.ts budgetFits left in place (now unused in src); Echo-3 budget caps may reuse it in a later phase"
metrics:
  duration: ~8min
  completed: 2026-11-23
  tasks: 2
  files: 17
---

# Phase 1 Plan 03: Strip World Labs routes, depth and schema Summary

The `:enhance`/`:retry` routes, depth uploads (`src/depth.ts`, `MAX_DEPTH_BYTES`, `depth_uploads`) and the `pano_url` asset field are gone. `frames:done` now flips `uploading → uploaded` in one conditional UPDATE, with the poses write in the same transaction, and enqueues nothing. The schema is down to 5 statuses, `JOB_KINDS = ['purge']`, and has no pano/draft/hq columns.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 47cb68a | refactor(backend): strip World Labs enhance/retry and depth routes |
| 2 | ddd4d08 | refactor(backend): drop World Labs schema columns, statuses and job kinds |

## Verification

- `npx tsc --noEmit` clean. `npx vitest run`: 201 passed / 12 skipped (25 files, 2 skipped integration files).
- Task 1 gate `depth|enhance|retry_path|panoUrl` (case-insensitive) over worlds.ts, storage/index.ts and the six tests prints nothing.
- Task 2 gate `failed_stitch|'stitch'|generate_draft|generate_hq|draft_world_id|hq_world_id|pano_url|panoUrl` over src and test (config.ts and config.test.ts excluded) prints nothing.
- `schema.ts` has 0 matches for `pano_url|draft_world_id|hq_world_id|draft_model|hq_model`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Scrub] Incidental `depth`/`enhance` tokens in worlds.ts**
- The case-insensitive gate also matched a loop variable `depth` in `hasPgCode` (renamed to `hops`) and a `:enhance` example in the `isInvalidTextRepresentation` doc comment (now `:foo`). `sendScanQuotaExceeded` was kept, and `sendCreditBudgetExceeded` and `ScanQuotaRefused` were removed with retry/enhance.
- Commit: 47cb68a

**2. [Rule 2 - Threat T-01-31] Queue legacy-kind guard moved to the actual source**
- The old assertion `not.toContain("'stitch'")` only checked the rendered SQL, and a literal `'stitch'` in the test would trip the plan's own grep gate. It became a regex over the SQL (`/'(purge|stitch|generate_\w+)'/`, so no kind is ever interpolated) plus a new test that reads `src/queue.ts` and asserts no `'stitch'` or `'generate_*'` literal.
- Commit: ddd4d08

**3. Extra fixture cleanup beyond the listed files**
- Removed columns and statuses also appeared in fixtures in frames-done, upload-size, worlds.idempotency, worlds.uploads-refresh and worker.progress. They were cleaned in Task 2, because vitest does not typecheck. The `'processing'` placeholder status from 01-01 became `'uploaded'`, and `'draft_ready'` became `'complete'`.
- Commit: ddd4d08

## Known follow-ups (owned by later plans)

- Drizzle migrations still create the dropped columns. Plan 01-04 regenerates them.
- `config.ts` / `config.test.ts` still reference World Labs and stitcher settings (plan 01-05).
- `src/queue.ts` comments still mention `worlds:generate` as prose, with no kind literal. They are harmless and can be reworded when the Echo-3 job kind lands.

## Self-Check: PASSED

- MISSING as intended: backend/src/depth.ts, backend/test/worlds.enhance.test.ts, backend/test/worlds.retry.test.ts
- FOUND: `'uploaded'` in backend/src/routes/worlds.ts; `JOB_KINDS = ['purge']` in backend/src/db/schema.ts
- FOUND commits: 47cb68a, ddd4d08
