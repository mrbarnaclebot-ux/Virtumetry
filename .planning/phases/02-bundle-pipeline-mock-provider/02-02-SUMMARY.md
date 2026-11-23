---
phase: 02-bundle-pipeline-mock-provider
plan: 02
subsystem: backend-data
tags: [drizzle, migrations, neon, queue, config, integration-tests]

requires:
  - phase: 01-backend-foundation
    provides: drizzle schema/0000_init, src/migrate.ts, queue, worlds routes, isolation checks
provides:
  - "D-15 schema: statuses uploading..cancelled, FAILURE_STAGES, JOB_KINDS pack/submit/track/purge, failure/budget/submission columns, asset keys, webhook_deliveries"
  - "Migrations 0001_phase2_add + 0002_phase2_drop, applied to Neon dev"
  - "Config: MOCK_SCENARIO(S), MONTHLY_CREDIT_BUDGET, MOCK_PROCESSING_SECONDS, TRACK_POLL_SECONDS, BUNDLE_URL_TTL_SECONDS, RATE_LIMIT_WEBHOOK_MAX"
  - "queue.snoozeJob and failJob(delaySeconds?)"
  - "scripts/dev-guard.mjs, migrate-dev.mjs, test-pg.mjs; test/helpers/pg-schema.ts createTestSchema"
  - "frames:done flips uploading -> packing and enqueues pack in the same tx"
affects: [02-03 pack, 02-04 mock provider/budget, 02-05 submit/track/webhook]

tech-stack:
  added: []
  patterns:
    - "Split drizzle generates: adds and drops in separate migrations (no rename prompt)"
    - "Dev-only scripts assert the Neon dev direct host before touching the DB; errors name the variable, never the value"
    - "pg integration tests build a throwaway schema from the committed migration SQL"

key-files:
  created:
    - backend/drizzle/0001_phase2_add.sql
    - backend/drizzle/0002_phase2_drop.sql
    - backend/drizzle/meta/0001_snapshot.json
    - backend/drizzle/meta/0002_snapshot.json
    - backend/scripts/dev-guard.mjs
    - backend/scripts/migrate-dev.mjs
    - backend/scripts/test-pg.mjs
    - backend/test/helpers/pg-schema.ts
  modified:
    - backend/src/db/schema.ts
    - backend/src/config.ts
    - backend/src/queue.ts
    - backend/src/worker.ts
    - backend/src/routes/worlds.ts
    - backend/drizzle/meta/_journal.json
    - backend/test/config.test.ts
    - backend/test/integration/queue.pg.test.ts
    - backend/test/migrate-folder.test.ts
    - backend/test/queue.lease.test.ts
    - backend/test/worker.lease.test.ts
    - backend/test/worker.progress.test.ts
    - backend/test/frames-done.test.ts
    - backend/test/worlds.list.test.ts
    - backend/test/worlds.uploads-refresh.test.ts
    - backend/test/worlds.idempotency.test.ts
    - backend/test/upload-size.test.ts
    - backend/test/quota.charge.test.ts
    - backend/test/atomic-flip.test.ts

key-decisions:
  - "Migrations split into 0001 adds and 0002 drops so drizzle-kit never prompts for a rename"
  - "frames:done enqueues the pack job in the same transaction as the uploading->packing flip; job_id is now returned"
  - "Stale-upload reaper marks worlds failed with failure_stage upload and code UPLOAD_STALE"
  - "pg-schema helper sends each migration file as one multi-statement query (statement-breakpoint is a SQL comment)"

requirements-completed: []  # schema groundwork for PROC-06/07/08; behaviour lands in 02-04..02-07, so not marked complete

duration: recovery run (~30 min this session)
completed: 2026-11-23
---

# Phase 2 Plan 02: D-15 Schema, Dev Migrations and Queue Additions Summary

This plan adds the D-15 data foundation. The status set, failure, budget and submission columns, re-hosted asset keys and the `webhook_deliveries` table are now on the Neon dev branch through two split migrations. The plan also adds guarded dev-DB scripts, a pg-schema helper that builds real-migration schemas for integration tests, `snoozeJob`, and the Phase 1 code repairs needed for the new schema.

## Recovery note

The first executor stalled partway through. It had committed Task 1 (f5fcae4) and left the four Task 2 files untracked. This recovery run checked those files against the plan and kept them unchanged. It then ran the guarded migration and committed Task 2. After that it completed Task 3. The config tests mentioned in the stalled executor's last words were already in f5fcae4: defaults, MOCK_SCENARIO accept/reject, and live refused without ALLOW_PAID_PROVIDER.

## Tasks

| # | Task | Commit |
|---|------|--------|
| 1 | D-15 schema, 0001 adds / 0002 drops, Phase 2 config vars + tests | f5fcae4 |
| 2 | dev-guard / migrate-dev / test-pg scripts, pg-schema helper, migrations applied to Neon dev | 9ad8b91 |
| 3 | snoozeJob, failJob delay, Phase 1 code/test repair, queue.pg on real migrations | 0e2089f |

## Verification

- Migrations: `0001_phase2_add.sql` and `0002_phase2_drop.sql`. `scripts/migrate-dev.mjs` ran twice. Both runs exited 0 and printed "[migrate] up to date", so they were already applied or idempotent. A read-only check on the dev branch found 3 rows in `drizzle.__drizzle_migrations`, `webhook_deliveries` present, and the old World Labs columns gone.
- The guard refuses a non-dev host and a `-pooler` host, exiting 1 before connecting. Its messages name only `MIGRATE_DATABASE_URL`.
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 30 files passed, 2 skipped (pg). 268 tests passed, 14 skipped.
- `node --env-file=.env scripts/test-pg.mjs test/integration`: 2 files, 14/14 passed. That is quota.pg 5 and queue.pg 9, including the new snooze and delay cases.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The pg-schema helper timed out the beforeAll hook against remote Neon**
- **Found during:** Task 3
- **Issue:** Running one query per DDL statement went over vitest's 10 s hook timeout.
- **Fix:** Each migration file is now sent as one multi-statement query, and the queue.pg hook timeouts were raised to 60 s / 30 s.
- **Files:** backend/test/helpers/pg-schema.ts, backend/test/integration/queue.pg.test.ts
- **Commit:** 0e2089f

**2. [Rule 1 - Bug] Updated test/migrate-folder.test.ts, which was not in the plan's list**
- It asserted a single 0000_init migration. It now asserts the 0000, 0001, 0002 journal order.
- **Commit:** 0e2089f

**3. Seeded user and world in queue.pg.test**
- The real migrations include the `jobs.world_id` foreign key, which the old hand-written DDL omitted. The test now seeds one user and one world.

## Deferred / Notes

- `backend/src/provider/types.ts` and `mock.ts` still use World Labs field names (`thumbnailUrl`). Plan 02-04 rewrites the provider, so I left them alone.
- `test/integration/quota.pg.test.ts` still uses its own hand-written DDL. It is outside this plan's file list and still passes.

## Self-Check: PASSED

- Files exist: scripts/dev-guard.mjs, migrate-dev.mjs, test-pg.mjs, test/helpers/pg-schema.ts, drizzle/0001_phase2_add.sql, drizzle/0002_phase2_drop.sql
- Commits exist: f5fcae4, 9ad8b91, 0e2089f
