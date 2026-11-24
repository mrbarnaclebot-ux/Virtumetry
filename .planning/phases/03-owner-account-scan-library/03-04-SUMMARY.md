---
phase: 03-owner-account-scan-library
plan: 04
subsystem: backend-deletion-seed
tags: [purge, deletion-cascade, provider, seed, privacy]
requires: [03-03 owner-only library contract]
provides:
  - "ReconProvider.deleteWorld(requestId) (FREE; ProviderError 404 = already gone); mock records calls.deleteWorld and 404s on repeat"
  - "handlePurge hard-deletes soft-deleted worlds: provider delete, storage prefixes, then share_slugs/jobs/captures/world in one tx; credit_events kept with world_id NULL"
  - "npm run seed:library (reset + 5 seed worlds) / -- --reset, dev DB + virtumetry-dev only"
affects: [backend/src/worker.ts, backend/src/pipeline.ts, backend/src/provider/*]
tech-stack:
  added: []
  patterns: [ordered FK hard delete in one tx guarded by deleted_at IS NOT NULL, 404-tolerant idempotent provider delete, seed rows tagged client_request_id 'seed:%']
key-files:
  created:
    - backend/test/integration/purge-cascade.pg.test.ts
    - backend/scripts/seed-library.ts
    - backend/test/integration/seed-library.pg.test.ts
  modified:
    - backend/src/provider/types.ts
    - backend/src/provider/mock.ts
    - backend/src/worker.ts
    - backend/src/pipeline.ts
    - backend/test/account-deleted.test.ts
    - backend/package.json
decisions:
  - "03-04: the running purge job's own row is deleted in the hard-delete tx (jobs.world_id NOT NULL FK without ON DELETE); D-17's 'other than the running purge' cannot hold literally"
  - "03-04: after hard delete a replayed client_request_id can no longer 409 (RESEARCH Pitfall 5, accepted; Phase 4 reshapes create)"
  - "03-04: seed:library also refuses STORAGE_DRIVER != s3 so the ready row's thumbnail lands on virtumetry-dev"
metrics:
  duration: ~35 min
  completed: 2026-11-24
  tasks: 2
  files: 9
---

# Phase 3 Plan 04: Delete cascade and seed:library Summary

Deleting a scan now really deletes it: one provider `deleteWorld` (mock), every storage prefix, and the DB rows, idempotently on retry, while the credit ledger survives with `world_id` NULL. `seed:library` fills the owner's dev library with one scan per state.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | Delete cascade: provider deleteWorld + ordered hard delete | 4d8d43f (RED), d412098 (GREEN) |
| 2 | seed:library | 23a8b46 (RED), e04d5ac (GREEN) |

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run`: 35 files passed, 316 tests passed (75 skipped = pg suites without TEST_DATABASE_URL)
- `npm run test:pg -- test/integration/purge-cascade.pg.test.ts`: 5/5
- `npm run test:pg -- test/integration/seed-library.pg.test.ts`: 7/7 (3 logic + 4 guard spawns)
- Full `npm run test:pg` (throwaway schemas): 11 files passed, 82 tests passed, 1 skipped (r2-range)
- seed:library was NOT run against the real dev DB (owner's step, 03-09)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pipeline handlers treated a hard-deleted world as live**
- **Found during:** Task 1
- **Issue:** handlePack and the import finaliser re-check `(await getWorld())?.deletedAt` to clean up objects written after a purge. Once purge hard-deletes, the row is gone and that check is falsy, so a late bundle/import output would be orphaned in storage.
- **Fix:** a missing row counts as deleted (`!after || after.deletedAt`).
- **Files modified:** backend/src/pipeline.ts
- **Commit:** d412098

**2. [Rule 3 - Blocking] Unit fakes for purge returned no world row**
- **Found during:** Task 1
- **Issue:** test/account-deleted.test.ts fake DB returned `[]` for the worlds select, so the new "missing world = complete" path skipped the purge it asserts.
- **Fix:** the fake returns a non-deleted world row; `hardDelete` uses `Boolean(world.deletedAt)` so worker.test.ts fakes (no deletedAt field) stay on the keep-row path.
- **Files modified:** backend/test/account-deleted.test.ts, backend/src/worker.ts
- **Commit:** d412098

## Notes

- The running purge job's row is removed with the world (NOT NULL FK, no ON DELETE); no completeJob after the hard delete.
- Client idempotency: after hard delete, re-POSTing the same client_request_id creates a new world instead of 409 (Pitfall 5, accepted).
- The seeded `uploading` row (no capture) will be failed by the stale-upload reaper after 24 h; re-run seed:library to restore it.
- Seed titles are plain room names; output prints counts and world ids only.

## Known Stubs

None. Seed rows are intentional dev data tagged `seed:%`.

## Self-Check: PASSED

All 3 created files exist; commits 4d8d43f, d412098, 23a8b46, e04d5ac found.
