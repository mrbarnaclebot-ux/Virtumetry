---
phase: 06-live-echo-3-provider
plan: 02
subsystem: database
tags: [postgres, drizzle, retry, purge]
requires: []
provides:
  - worlds.submit_attempt, world_attempts, budget_alerts (migration 0005, applied to Neon dev)
  - isRetryable(world) pure rule (src/retry.ts)
  - purge deletes archived attempts at provider and in DB
affects: [06-04 budget alerts, 06-07 retry route, worlds payload retryable flag]
tech-stack:
  added: []
  patterns: ["append-only attempt archive keyed by (world_id, attempt)", "unique index as alert dedupe"]
key-files:
  created:
    - backend/drizzle/0005_phase6_retry_alerts.sql
    - backend/drizzle/meta/0005_snapshot.json
    - backend/src/retry.ts
    - backend/test/retryable.test.ts
  modified:
    - backend/src/db/schema.ts
    - backend/drizzle/meta/_journal.json
    - backend/src/worker.ts
    - backend/test/integration/purge-cascade.pg.test.ts
key-decisions:
  - "isRetryable processing stage checks failure_code plus every failure_message token against the validation regex; bare FAILED and empty codes are not retryable"
  - "Purge deletes current + archived provider requests in one loop; any non-404 error rethrows so the purge job retries"
requirements-completed: [LIB-02, OPS-06]
duration: 12min
completed: 2026-11-25
---

# Phase 6 Plan 02: Retry data model, isRetryable, purge fix Summary

**Additive migration 0005 (submit_attempt, world_attempts, budget_alerts) on Neon dev, a pure 42-row-tested isRetryable rule, and a purge that removes archived attempts at the provider and in the DB.**

## Accomplishments
- Task 1 (7134183): schema + drizzle-kit generated `0005_phase6_retry_alerts.sql` (CREATE TABLE x2, ADD COLUMN with DEFAULT, FK, 3 unique indexes; no DROP). `npm run db:migrate:dev` ran via the dev guard and reported up to date. budget.pg.test.ts 8/8 green on the new migrations.
- Task 2 (8947d6a): `backend/src/retry.ts` `isRetryable` per D-08 + A-01; `test/retryable.test.ts` 42 `it.each` rows, all pass.
- Task 3 (b90935b): `handlePurge` deletes every `world_attempts.provider_request_id` (404 tolerated) and `world_attempts` rows in the hard-delete tx. purge-cascade.pg.test.ts 9/9 green (2 new).

## Verification
- `npx tsc --noEmit` clean
- `npx vitest run test/retryable.test.ts`: 42 passed
- `npm run test:pg -- test/integration/budget.pg.test.ts`: 8 passed
- `npm run test:pg -- test/integration/purge-cascade.pg.test.ts`: 9 passed

## Deviations from Plan
- Task 2 is marked tdd, but the test and implementation went into one commit, not separate RED and GREEN commits. The truth table is the spec, and it passes.
- No other deviations. The migration file name matches the plan.

## Known Stubs
None.

## Self-Check: PASSED
Files exist; commits 7134183, 8947d6a, b90935b present in git log.
