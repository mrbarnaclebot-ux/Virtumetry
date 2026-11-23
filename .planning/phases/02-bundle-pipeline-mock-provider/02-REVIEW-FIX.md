---
phase: 02-bundle-pipeline-mock-provider
fixed_at: 2026-11-24T00:00:00Z
review_path: .planning/phases/02-bundle-pipeline-mock-provider/02-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 2: Code Review Fix Report

**Fixed at:** 2026-11-24
**Source review:** .planning/phases/02-bundle-pipeline-mock-provider/02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 9 (CR-01..03, WR-01..06; Info findings out of scope)
- Fixed: 9 (WR-02 only partly, see below)
- Skipped: 0

**Verification (final tree):**
- `npx tsc --noEmit`: clean
- `npx vitest run`: 32 files passed / 7 skipped; 296 tests passed / 48 skipped (the extra skips are the new PG tests when `TEST_DATABASE_URL` is unset)
- `node --env-file=.env scripts/test-pg.mjs`: 6 files passed / 1 skipped; 47 tests passed / 1 skipped (the skip is the R2 Range test, S3 env absent)
- Flake note: in the first full PG run, two tests in `budget.pg.test.ts` failed at 5.3 s and 3.1 s under parallel Neon load. That file is unchanged. They passed alone and in a full rerun, so this looks like the 5 s default timeout against remote Neon, not a regression.

Logic and money-path fixes are marked **fixed: requires human verification**.

## Fixed Issues

### CR-01: Transient errors during `track` accumulate across the whole job and fail a paid world

**Status:** fixed: requires human verification
**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 80e0a8c
**Applied fix:** `handleTrack` now wraps the old body (`trackOnce`). Any error other than `LeaseLostError` writes `{ errs: n }` and `last_error` to the job payload and snoozes with `min(TRACK_POLL_SECONDS * 2^n, 900 s)`. Snoozing gives the attempt back, so transient errors never burn the attempt budget. A clean pass resets the payload.
**Deliberate choice:** the job never gives up and never fails a paid world. A permanently broken request is polled every 15 min and logged on every error (there is a `ponytail:` comment in the code). `failWorldForDeadJob` is unchanged. A track job can now only go dead if the process crashes 5 times in a row (lease expiry), and that path still fails the world as `JOB_EXHAUSTED`. A `TRACK_STALLED` re-enqueue path is left for Phase 6 if needed.
**Test:** 4 `status()` 503s plus 3 `open()` errors, 7 in total, which is more than `MAX_ATTEMPTS`. The world reaches `ready`, the track job ends with attempts ≤ 1 and a null payload.

### CR-02: Credits are released after 429/503/400/402/403 even when an earlier attempt's outcome was uncertain

**Status:** fixed: requires human verification
**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 316a791
**Applied fix:** the submit job payload holds a sticky marker. Before every send it is set to `{ uncertain, sending: true }`. After a send error it becomes `{ uncertain: uncertain || !definitive }`, where definitive means 400/402/403/429/503. A payload that still has `sending: true` means the previous attempt crashed mid-send, and that also counts as uncertain. Once the marker is set, 400/402/403 refuse without releasing, and 429/503 exhaustion falls through to the existing `SUBMIT_UNCERTAIN` path (failed and parked dead, reservation kept). No new key is ever minted.
**Note:** the marker is scoped to the job, not the world (there is a `ponytail:` comment). There is one submit job per world today. If submits are ever re-enqueued, move it to a `worlds` column.
**Tests:** a 500 followed by three 503s gives 4 submits with the same key, `SUBMIT_UNCERTAIN`, and the ledger still shows only `reserve`. A leftover `sending` marker followed by a 402 gives `INSUFFICIENT_CREDITS` with the reservation kept. The existing 402/409/429/503 scenarios still pass.

### CR-03: Pipeline jobs ignore soft-delete, so a deleted scan's outputs are re-hosted after the purge

**Status:** fixed: requires human verification
**Files modified:** `backend/src/pipeline.ts`, `backend/src/worker.ts` (exported `purgePrefix`), `backend/test/integration/pipeline.pg.test.ts`
**Commit:** c4c9a2a
**Applied fix:** this is handled in the handlers, so it covers both `DELETE /v1/worlds/:id` and `DELETE /v1/account`.
- `handlePack` and `handleSubmit` complete without doing work when `deletedAt` is set.
- `handlePack` re-reads the world after the bundle upload and deletes the bundle if the world was deleted. `deleted_at` commits in the same transaction as the purge enqueue, so either pack sees the delete or purge lists the bundle.
- `trackOnce` on a deleted world calls `provider.cancel(rid)` (best effort, only while `processing`) and completes without importing. The reservation is kept, because a late cancel may still be billed.
- The final `ready` UPDATE requires `deleted_at IS NULL`. If it updates 0 rows because the world was deleted, `worlds/{id}/` is purged again.

The route was not changed to flip status to `cancelled`, because the handler checks make that unnecessary.
**Tests (PG):** a delete during pack leaves no bundle and no submit job. A delete during processing leaves the mock request `CANCELLED` and `worlds/{id}/` empty. A delete mid-import leaves `worlds/{id}/` empty, the world never reaches `ready`, and `splat_key` stays NULL.

### WR-01: Quote and approval are re-checked on resumed submits, which can fail a world whose request is already live

**Status:** fixed: requires human verification
**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 9a87c5f
**Applied fix:** the quote, the approval check and the `quotedCredits` write now run only while `submitBody` is null. After the body is persisted, a resume goes straight to reserve and submit.
**Test:** in the 503 scenario the quote changes to 999,999 after the first call. The world still reaches `ready`, `quote()` is called once, and `quoted_credits` and `credits_spent` stay at the original quote.

### WR-02: Paid requests can be orphaned with no reconciliation path

**Status:** fixed (partial): requires human verification
**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** e3d13f8
**Applied fix:** after a successful submit, the status flip also accepts a world that is `failed` at stage `submit` (for example, the reaper failed it after a lease expiry). It clears the failure fields, moves the world to `processing`, enqueues `track`, and logs loudly. A confirmed request id is always tracked now.
**Not fixed (deferred to Phase 6):** the 409 and `SUBMIT_UNCERTAIN` cases, where the request id is never learned. Unmatched webhook `request_id`s are already stored in `webhook_deliveries`, so a human can match them by hand. A real reconciliation path needs Echo-3's lookup by idempotency key, which only the live client can confirm.
**Test:** the reaper fails the world during `submit()`, but the world still reaches `ready` with `failure_code` NULL and `charged=true`.

### WR-03: A missing manifest is retried as transient, and the shipped routes always hit that case

**Status:** fixed
**Files modified:** `backend/src/bundle/pack.ts`, `backend/test/bundle/pack.test.ts`, `backend/README.md`
**Commit:** 853decc
**Applied fix:** `packCapture` lists `captures/{cid}/` once and passes the listing to `readManifest`. A missing `session.json` or `frames.jsonl` throws `BundleInvalidError` with `MANIFEST_MISSING`, which ends as `validate` with 0 credits. Using the listing avoids sorting S3 `NoSuchKey` from local `ENOENT` from transient errors. The routes were not changed (Phase 3 reshapes them). The README API section now describes the `frames:done` dead end, replacing a stale line that said it "enqueues nothing yet".
**Test:** deleting `session.json` gives `MANIFEST_MISSING`.

### WR-04: The import marks a world `ready` even when required artifacts are missing

**Status:** fixed
**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** f2fe3ae
**Applied fix:** without a `splatKey` the world fails as `import/ARTIFACT_MISSING` and the reservation is kept. Only the splat is required. The collider is optional, because the viewer can show a splat without walk mode.
**Test:** artifacts with the splat removed give failed/import `ARTIFACT_MISSING`, `splat_key` NULL, and the ledger shows only `reserve`.

### WR-05: Snooze and complete are not ownership-checked, and pack cleanup can delete another worker's bundle

**Status:** fixed
**Files modified:** `backend/src/queue.ts`, `backend/src/pipeline.ts`, `backend/src/worker.ts`, `backend/src/bundle/pack.ts`, `backend/test/integration/queue.pg.test.ts`, `backend/test/bundle/pack.test.ts`
**Commit:** 8abb7be
**Applied fix:** `completeJob`, `snoozeJob`, `failJob` and `parkJobDead` take an optional `owner` and add `AND locked_by = owner`, the same pattern as `heartbeatJob`. Every pipeline, purge and `handleJobError` call passes `job.lockedBy`, the owner at claim time. `pack.ts` skips the bundle `deleteObject` when the zip error is a `LeaseLostError`. It checks the error name instead of using `instanceof` so `pack.ts` doesn't import `worker.ts` and create a cycle.
**Tests:** a stale `worker-A` cannot snooze, complete, fail or park a job now locked by `worker-B` (phase, owner and attempts are unchanged). A lost lease mid-zip deletes nothing, while any other mid-zip error still cleans up its partial bundle.

### WR-06: Manifest objects are read into memory with no size limit

**Status:** fixed
**Files modified:** `backend/src/bundle/pack.ts`, `backend/test/bundle/pack.test.ts`
**Commit:** ed4cc06
**Applied fix:** `MANIFEST_MAX_BYTES = 8 MiB`, checked against sizes from the listing WR-03 already makes. No extra HEAD calls are needed. An oversized manifest fails as `MANIFEST_TOO_LARGE` before `getObject` is called.
**Test:** a `frames.jsonl` of 8 MiB + 1 gives `MANIFEST_TOO_LARGE`.

---

_Fixed: 2026-11-24_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
