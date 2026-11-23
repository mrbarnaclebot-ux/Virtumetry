---
phase: 02-bundle-pipeline-mock-provider
reviewed: 2026-11-23T00:00:00Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - backend/drizzle/0001_phase2_add.sql
  - backend/drizzle/0002_phase2_drop.sql
  - backend/package.json
  - backend/scripts/dev-guard.mjs
  - backend/scripts/fixture-e2e.ts
  - backend/scripts/make-tiny-session.ts
  - backend/scripts/migrate-dev.mjs
  - backend/scripts/test-pg.mjs
  - backend/scripts/test-r2.mjs
  - backend/src/budget.ts
  - backend/src/bundle/convert.ts
  - backend/src/bundle/exif.ts
  - backend/src/bundle/manifest.ts
  - backend/src/bundle/pack.ts
  - backend/src/bundle/validate.ts
  - backend/src/bundle/zipread.ts
  - backend/src/config.ts
  - backend/src/db/schema.ts
  - backend/src/pipeline.ts
  - backend/src/provider/index.ts
  - backend/src/provider/mock.ts
  - backend/src/provider/types.ts
  - backend/src/queue.ts
  - backend/src/routes/index.ts
  - backend/src/routes/webhooks.ts
  - backend/src/routes/worlds.ts
  - backend/src/storage/index.ts
  - backend/src/storage/local.ts
  - backend/src/storage/s3.ts
  - backend/src/worker.ts
findings:
  critical: 3
  warning: 6
  info: 10
  total: 19
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-11-23
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

I reviewed the Phase 2 backend: the bundle format (convert/EXIF/validate/pack/zipread), the money path (submit state machine, budget reservation and release), the webhook route, the queue and worker changes, storage drivers, migrations and the dev scripts.

What holds up:
- The pose math is correct. `arkitToOpenCV` computes `D · [Rᵀ | -Rᵀt]` with the right column-major indexing.
- The EXIF APP1 layout checks out at 106 bytes, with correct offsets and ascending tags.
- HMAC verification is constant-time and fails closed.
- The submission key is minted once with a conditional `IS NULL` update, the body is persisted before the first send, and every send re-reads the DB copy. No code path mints a second key.
- Reservation is serialized with an advisory lock and keyed on `submission_key`.

What is wrong:
1. Transient errors in the `track` job add up over the job's whole life and can fail an already-paid world.
2. Some release paths ignore an earlier uncertain submit attempt, so the budget ledger can under-count real spend.
3. The pipeline ignores soft-delete, so a deleted private scan can have its outputs re-hosted after the purge has run.

Secret scan: no keys, connection strings, presigned URLs or personal emails are in the tracked backend files. `.env` is gitignored, and `.env.example` and the tests use only placeholders. The dev Neon endpoint id is committed (IN-01).

## Critical Issues

### CR-01: Transient errors during `track` accumulate across the whole job and fail a paid world

**File:** `backend/src/pipeline.ts:245-330`, `backend/src/queue.ts:203-244`, `backend/src/worker.ts:26-34`
**Issue:** `claimNextJob` adds 1 to `attempts` and `snoozeJob` takes 1 off, so a normal poll nets to zero. Any thrown error (a provider `status()` 429/5xx/timeout, a `provider.open()` or `putStream` failure, a DB blip) goes through `failJob`, which does not take the attempt back, so it nets +1.

These +1s never reset. Over a 30 min to 2 h Echo-3 run polled every 60 s, the fifth transient error *anywhere in the job's life* (they do not have to be consecutive) sets `attempts >= MAX_ATTEMPTS`. The job is then parked `dead`, and `failWorldForDeadJob` fails the world as `processing/JOB_EXHAUSTED` or `import/JOB_EXHAUSTED`.

By that point the provider has already charged (~$15-18). Only `track` may write state, nothing re-enqueues `track` for a failed world, and the result is abandoned. `charged` also stays `false`, so the row misreports the spend. The design says this state machine is built now "so Phase 6 only adds echo3.ts", so this ships straight into the live money path.
**Fix:** Track a consecutive-error count for `track` instead of using the lifetime attempts count, and make status-poll errors snooze rather than fail. For example:
```ts
// handleTrack: wrap provider/storage calls
try { s = await provider.status(rid); }
catch (err) {
  const n = ((job.payload as { errs?: number })?.errs ?? 0) + 1;
  if (n < TRACK_MAX_CONSECUTIVE_ERRORS) {
    await db.update(jobs).set({ payload: { errs: n } }).where(eq(jobs.id, job.id));
    return snoozeJob(db, job.id, Math.min(config.TRACK_POLL_SECONDS * 2 ** n, 900));
  }
  throw err;
}
// reset payload.errs to 0 on every successful poll
```
Also, never move a world that has a `providerRequestId` to terminal `failed` for an exhausted `track` job. Park it in a recoverable state instead, such as `failure_code=TRACK_STALLED`, and keep a re-enqueue path, because the output may still be downloadable.

### CR-02: Credits are released after 429/503/400/402/403 even when an earlier attempt's outcome was uncertain

**File:** `backend/src/pipeline.ts:195-213`
**Issue:** Releasing on 429/503 exhaustion ("never accepted", line 211) and on 400/402/403 (line 197) assumes no attempt with this key ever reached the provider. Attempts are not independent, though.

Take this sequence: attempt 1 times out or gets a 5xx. The request may exist and be billed, and the code correctly keeps the reservation and retries (lines 214-216). Attempts 2-4 then get 503 (the provider is still degraded) or 429. On attempt 4 the code calls `releaseCredits`, which writes a `-amount` row for a submission that may well be processing and billed.

The ledger then under-counts real spend, so the daily and monthly caps (the server-side money guard in CLAUDE.md) can be exceeded. This contradicts the "NEVER on … 5xx or timeout" rule in `budget.ts:125-129`, because the uncertainty from attempt 1 carries forward through the later attempts.
**Fix:** Persist an "uncertain" marker the first time an outcome is unknown, and never release once it is set:
```ts
// on the uncertain branch, before throwing RetryLaterError:
await db.update(worlds).set({ submitUncertain: true }).where(eq(worlds.id, worldId));
// on the release branches:
const cur = await getWorld(db, worldId);
if (!cur?.submitUncertain) await releaseCredits(db, key);
```
A cheaper alternative is to put the job's `last_error`/attempt history in the payload and skip the release when any prior attempt hit the uncertain branch. Add a scenario test: `503` (thrown as a network error) → `503` → `503` → `503` must leave the reservation in place.

### CR-03: Pipeline jobs ignore soft-delete, so a deleted scan's outputs are re-hosted after the purge

**File:** `backend/src/pipeline.ts:72-77, 117-120, 245-250, 306-328`; `backend/src/routes/worlds.ts:437-454`; `backend/src/worker.ts:116-144`
**Issue:** `DELETE /v1/worlds/:id` sets `deleted_at` and enqueues `purge`, but it leaves `status` unchanged and does not cancel the provider request. None of `handlePack`, `handleSubmit` or `handleTrack` checks `deletedAt`. Possible outcomes:
- If `track` is in `processing`, it keeps polling, then streams every artifact into `worlds/{id}/v1/*` *after* `purge` has already emptied that prefix. It then sets `status=ready`. A splat, mesh, floor plan and camera poses of a private home stay in R2 with no purge job left to remove them.
- If `pack` races `purge`, a full-resolution `bundles/{cid}/capture_bundle.zip` can land after the purge listed that prefix, which orphans every frame of the home.

This breaks the privacy and retention constraint in CLAUDE.md.
**Fix:** Do it in the shared path. Have every handler bail out on a deleted world, and flip the status in the same transaction as the soft-delete:
```ts
// pipeline.ts getWorld: treat deleted as absent
.where(and(eq(worlds.id, id), isNull(worlds.deletedAt)))
// routes/worlds.ts DELETE, same tx as deletedAt:
.set({ deletedAt: new Date(), status: sql`CASE WHEN status IN ('ready','failed','cancelled') THEN status ELSE 'cancelled' END`, ... })
```
In `handleTrack`, when a world is deleted or cancelled and has a `providerRequestId`, call `provider.cancel(rid)` (best effort) and complete the job without importing. Purge should also run after any in-flight `pack`/`track` for the world has finished, or re-check after them.

## Warnings

### WR-01: Quote and approval are re-checked on resumed submits, which can fail a world whose request is already live

**File:** `backend/src/pipeline.ts:131-135`
**Issue:** Every submit attempt calls `provider.quote()` again, overwrites `quoted_credits`, and refuses if the new quote is above `approved_max_credits`. On a retry after an uncertain attempt (the request may already exist and be billed), a changed quote fails the world with `QUOTE_ABOVE_APPROVAL` and completes the job. The paid request is orphaned and the reservation stays.

Separately, the reservation amount is fixed at the first quote (`reserveCredits` returns `'already'`), while `quoted_credits`, and from it `credits_spent` at line 324, can drift to a different number.
**Fix:** Do the quote and approval check only while `submissionKey`/`submitBody` are still unset. Once the body is persisted, skip straight to reserve/submit, and never rewrite `quotedCredits`:
```ts
if (w.submitBody == null) { /* quote, approval check, set quotedCredits, preflight, persist body */ }
```

### WR-02: Paid requests can be orphaned with no reconciliation path

**File:** `backend/src/pipeline.ts:200-205, 214-219, 222-230`; `backend/src/routes/webhooks.ts:57-60`
**Issue:** The `409` and `SUBMIT_UNCERTAIN` paths fail the world and park the job dead. The provider request may exist (which is why the reservation is kept), but `provider_request_id` is never learned. The provider's webhook for that request then matches no world (line 60) and is dropped after dedupe.

Also, the success transaction at lines 223-229 writes `providerRequestId` unconditionally but enqueues `track` only if the status flip succeeds. If the world left `submitting` in the meantime (for example the reaper failed it after a lease expiry), a confirmed paid request is silently never tracked. That world is `failed` with `charged=false`.
**Fix:** If the flip affects 0 rows after a successful submit, log loudly and still enqueue `track`, or set a `needs_reconcile` flag. Have the webhook route record unmatched `request_id`s (they are already stored in `webhook_deliveries`) and surface them, so a human can attach the request to the world. Phase 6 should add a lookup by idempotency key if Echo-3 supports one.

### WR-03: A missing manifest is retried as transient, and the shipped routes always hit that case

**File:** `backend/src/bundle/pack.ts:21-31`; `backend/src/pipeline.ts:84-91`; `backend/src/routes/worlds.ts:315-379, 463-467`
**Issue:** `readManifest` only wraps the parse in `BundleInvalidError`. A missing `session.json`/`frames.jsonl` (S3 `NoSuchKey`, local `ENOENT`) escapes as a generic error, so it is retried with backoff 5 times and then ends as `pack/JOB_EXHAUSTED` instead of a clean `validate/MANIFEST_MISSING` with 0 credits.

That is exactly what happens to every world created through the current app-facing routes. They still presign `captures/{cid}/frame_{i}.heic` (max 64 frames), and `frames:done` enqueues `pack`. On top of that, no route sets `approved_max_credits`, so even a packed world would be refused `NOT_APPROVED`. The public API now leads into a dead end. That is acceptable only if it is documented as deferred to Phase 3.
**Fix:**
```ts
const [sessionBuf, framesBuf] = await Promise.all([...]).catch((e) => {
  throw new BundleInvalidError([{ code: 'MANIFEST_MISSING', message: 'session.json or frames.jsonl not uploaded' }]);
});
```
Then either gate `frames:done` from enqueuing `pack` until Phase 3, or note the dead end in the README.

### WR-04: The import marks a world `ready` even when required artifacts are missing

**File:** `backend/src/pipeline.ts:306-328`
**Issue:** `keys` is filled from whatever `provider.artifacts()` returns. If the list has no `splat` (provider change, partial output, empty list), the world is still set to `status=ready, charged=true` with `splat_key = NULL`. The app then gets a "ready" world with nothing to view.
**Fix:** Before the final UPDATE, assert `keys.splatKey` (and `colliderKey`, if walk mode needs it). Otherwise fail with `import/ARTIFACT_MISSING`, keeping the reservation.

### WR-05: Snooze and complete are not ownership-checked, and pack cleanup can delete another worker's bundle

**File:** `backend/src/queue.ts:189-195, 233-244`; `backend/src/pipeline.ts:252-280`; `backend/src/bundle/pack.ts:90-95`
**Issue:** `snoozeJob` and `completeJob` update by `id` only. A worker whose lease expired (a slow provider call or a long artifact stream, with no heartbeat in the `processing` branch) can still snooze or complete the job and wipe the new owner's `locked_at`/`locked_by`. That lets a third worker claim the job while the second is still running it.

Also, when `pack` loses its lease mid-zip (the heartbeat throws `LeaseLostError` inside the lazy entry), the catch block runs `storage.deleteObject(bundleKey)`. That can delete the bundle the new lease holder has just finished uploading, and the later preflight then refuses with `BUNDLE_NOT_RANGEABLE`.
**Fix:** Add `AND locked_by = ${workerId}` to `snoozeJob`/`completeJob` (and `failJob`), following the same pattern as `heartbeatJob`. In `pack.ts`, skip the `deleteObject` when `zipErr instanceof LeaseLostError`.

### WR-06: Manifest objects are read into memory with no size limit

**File:** `backend/src/bundle/pack.ts:22-25`
**Issue:** `session.json` and `frames.jsonl` are fetched in full with `getObject` and parsed without checking their size. Frames are size-checked (`FRAME_TOO_LARGE`), but these are not. Once Phase 3 lets the app upload them through presigned PUTs, a malformed or malicious client could upload a multi-GB `frames.jsonl` and crash the worker with an OOM, and the crash-retry loop repeats that up to 5 times.
**Fix:** `objectSize()` both keys first, and refuse with `MANIFEST_TOO_LARGE` above a constant such as 8 MiB (5000 frames × ~400 B ≈ 2 MB).

## Info

### IN-01: The dev Neon endpoint id is committed in a public repo, and the host check uses a substring match

**File:** `backend/scripts/dev-guard.mjs:5,17`, `backend/scripts/fixture-e2e.ts:33`
**Issue:** `ep-mute-fog-arwonnkz` is an infrastructure identifier, not a credential, but it is now public. The guard uses `host.includes(...)`, so a host such as `ep-mute-fog-arwonnkz.evil.example` would pass. `fixture-e2e.ts` also duplicates the constant instead of importing `assertDevDb`.
**Fix:** Match `host.startsWith(DEV_ENDPOINT + '.') && host.endsWith('.neon.tech')`, and reuse `dev-guard.mjs` from `fixture-e2e.ts`. Decide whether the endpoint id should come from env instead.

### IN-02: `fixture:e2e` runs any job on the shared dev DB

**File:** `backend/scripts/fixture-e2e.ts:87,112`
**Issue:** `runOneJob` claims the next job of any kind, including leftover jobs from integration tests or other worlds (purges included), and runs them against real dev R2. A deployed dev worker can also steal the fixture's jobs.
**Fix:** Claim only jobs where `world_id = worldId`, for example with a `claimJobForWorld` helper used only by the script.

### IN-03: EXIF edge cases

**File:** `backend/src/bundle/exif.ts:15,37`
**Issue:** (a) `DateTimeOriginal` is assumed to be exactly 20 bytes. A `wallMs` outside years 1000-9999 silently produces a malformed tag, because `wallMs` has no range check in `manifest.ts:28`. (b) APP1 is inserted before an existing JFIF APP0, which breaks JFIF's "APP0 first" rule. Pillow writes APP0 then APP1. Most decoders tolerate this, but it is not byte-compatible with the sample.
**Fix:** Bound `wallMs` in `FrameLineV1` (e.g. 2000-01-01 to 2100-01-01). Insert after an APP0 JFIF segment if one is present (a 64 KiB window is still easily met).

### IN-04: Mock state is in memory, and the outputs come from the test tree

**File:** `backend/src/provider/mock.ts:27-29, 71-80`
**Issue:** A worker restart loses `byId`. The next `status()` call then throws 404, which ends in `JOB_EXHAUSTED` (see CR-01). A redeployed image without `test/fixtures` fails every import. This is acknowledged for dev use, but a Railway dev worker running `PROVIDER_MODE=mock` will hit it.
**Fix:** Document it in the README, or have `status()` return `COMPLETED` for unknown ids in mock mode.

### IN-05: Config accepts dangerous zero or out-of-range values

**File:** `backend/src/config.ts:72-76`
**Issue:** `TRACK_POLL_SECONDS=0` makes the worker poll the provider in a hot loop. `BUNDLE_URL_TTL_SECONDS=0` or `>604800` makes the presign fail or return an instantly expired URL.
**Fix:** `.pipe(z.number().int().min(1))` for the poll interval, and `.min(3600).max(604800)` for the TTL.

### IN-06: Migration 0001 does not remap legacy status values or job kinds

**File:** `backend/drizzle/0001_phase2_add.sql:8`
**Issue:** Only the default changes (`capturing` → `uploading`). Existing rows in Phase 1 statuses, and jobs of removed kinds, are left as they were. An old non-terminal world then never moves. The impact is low on a fresh DB.
**Fix:** Add `UPDATE worlds SET status='failed', failure_code='LEGACY' WHERE status NOT IN (...)` and park legacy jobs.

### IN-07: Webhook dedupe insert and nudge are not atomic

**File:** `backend/src/routes/webhooks.ts:49-60`
**Issue:** If the `UPDATE jobs` fails after the delivery row is inserted, the request returns 500. The provider's retry is then deduplicated, so the nudge is lost. Polling covers it, so the impact is small.
**Fix:** Wrap the insert and the update in `db.transaction`.

### IN-08: The webhook URL is sent even when no secret is configured

**File:** `backend/src/pipeline.ts:159-161`
**Issue:** With `PUBLIC_BASE_URL` on https and `SPAITIAL_WEBHOOK_SECRET` unset, every delivery gets a 401 and the provider retries it 5 times.
**Fix:** Include `webhook` only when `config.SPAITIAL_WEBHOOK_SECRET` is set.

### IN-09: Failure details and the charged flag are not exposed or are inaccurate

**File:** `backend/src/routes/worlds.ts:109-130`; `backend/src/pipeline.ts:293-296`
**Issue:** `serializeWorld` omits `failure_stage`, `failure_code` and `charged`, so a client cannot tell `BUDGET_EXCEEDED` from a validation failure. `EXPORT_FAILED` and the dead-`track` paths leave `charged=false` even though credits were spent.
**Fix:** Serialize the failure fields, and set `charged=true` on post-COMPLETED failures.

### IN-10: AWS SDK version pins can drift apart, and zipread breaks on empty entries

**File:** `backend/package.json:26-28`; `backend/src/bundle/zipread.ts:14,32`
**Issue:** `@aws-sdk/lib-storage` is pinned exactly while `client-s3` uses a caret, which breaks the "bump both together" rule in CLAUDE.md and risks duplicate `@smithy` types. Separately, `readEntry`/`readCentralDirectory` request `bytes=a-(a-1)` for a zero-size entry or central directory, which is an invalid range (mock only).
**Fix:** Use the same specifier for both packages. Return `Buffer.alloc(0)` when the size is 0.

---

_Reviewed: 2026-11-23_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
