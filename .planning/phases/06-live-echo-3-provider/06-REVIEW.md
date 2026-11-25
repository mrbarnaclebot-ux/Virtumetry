---
phase: 06-live-echo-3-provider
iteration: 2
reviewed: 2026-11-25T03:01:05Z
depth: deep
diff_base: 46dd18d
files_reviewed: 14
files_reviewed_list:
  - backend/src/pipeline.ts
  - backend/src/retry.ts
  - backend/src/provider/echo3.ts
  - backend/src/provider/index.ts
  - backend/src/routes/worlds.ts
  - backend/src/queue.ts
  - backend/src/budget.ts
  - backend/src/worker.ts
  - backend/src/storage/s3.ts
  - backend/src/storage/local.ts
  - backend/test/integration/retry.pg.test.ts
  - backend/test/echo3.client.test.ts
  - virtumetry/src/library/display-state.ts
  - virtumetry/src/app/world/[id]/retry.tsx
findings:
  critical: 0
  warning: 4
  info: 13
  total: 17
status: issues_found
---

# Phase 6: Code Review Report (iteration 2)

**Reviewed:** 2026-11-25T03:01:05Z
**Depth:** deep. The fix commits `46dd18d..501e384` were traced through queue.ts (claim, lease, ownership guards), budget.ts (reserve/alert), worker.ts (dead-job and lease-lost handling) and both storage drivers' `putStream`.
**Files Reviewed:** 14
**Status:** issues_found

## Summary

### Verification of iteration-1 findings

| ID | Verdict | Notes |
|----|---------|-------|
| CR-01 | **Fixed, with a residual gap (WR-01, WR-02 below)** | `refuse()` is now one tx. `applyRetry` retires queued and running pack/submit/track jobs inside the retry tx. Submit jobs carry `submitAttempt`, and `handleSubmit` checks it at entry and after the pre-send re-read. **A retry cannot drop a legitimate job:** a retry needs `status='failed'`, a retryable code and a clear ledger for the old key. Every run that might have sent the old key reserved it first and only releases on a definitive, non-uncertain refusal. `JOB_EXHAUSTED`, `SUBMIT_UNCERTAIN` and `IDEMPOTENCY_KEY_REUSED` are not retryable. A track job only exists after a successful submit, so a retryable world never has a live track job tied to a paid, unfinished request. **The attempt check cannot skip a resume of a request that was really sent:** the attempt only changes through a retry, and the held reserve blocks that. **Remaining gap:** the attempt check is a read, not a guard. A run that passed it before a retry can still reserve and send its old key, record the request id onto the new attempt, fail the new attempt, or overwrite its quote. The regression test covers only a stale job that *enters* after the retry. |
| WR-01 | Fixed | Release runs first, then the flip, in one tx, for both FAILED and CANCELLED. |
| WR-02 | **Fixed, with a regression risk (WR-03)** | The host/IP/scheme guard is sound for the documented 302 → signed storage URL: typical GCS, S3 and R2 hosts are https DNS names and pass. But `redirect: 'manual'` with no hop-following turns any second redirect into a permanent error, and the paid import then retries forever. |
| WR-03 | Fixed | Validation for `quote` and `limits` is correct, and a bad shape is never cached. |
| WR-04 | Fixed | A `LeaseLostError` from `beat()` reaches `handleTrack` and is rethrown. Traced: `cb(err)` destroys `out`. The local driver's `pipeline()` rejects with that error object. lib-storage `Upload.done()` rethrows `concurrentUploaderFailures[0]`, which is the async-iterator error. One leak remains (IN-11). |
| WR-05 | Fixed | The conditional quote write is correct for two runs of the same job. It does not cover a cross-attempt stale run (WR-02). There is also a cosmetic gap after a 0-row write (IN-12). |
| WR-06 | Fixed | The in-tx `NOT EXISTS(heldReserve)` plus the `IS NOT DISTINCT FROM` checks on failure_* and key are correct. A lost race rolls back the `world_attempts` insert. |
| WR-07 | Fixed | `Promise.resolve().then(push).catch(log)` catches both sync throws and rejections, so there is no unhandled rejection. The push no longer gates the send. |
| WR-08 | Fixed | Copy now follows the server's `retryable` flag in both the sheet and the row. |
| WR-09 | Fixed | The factory guard runs before the client is built. |
| WR-10 | Fixed | V5 now really leaves the job `running` with `sending=true` and resumes after the lease ages. |
| WR-11 | Fixed | `ProviderTimeoutError` extends `ProviderError`, so the transient mapping is reached. The replay and GET ledger checks now agree. |

HARD MONEY RULE: no new path enables live mode. The only live `Config` literals are casts in `test/provider/mock.test.ts`, and they point at `https://127.0.0.1:1`. The WR-09 guard refuses any config without `ALLOW_PAID_PROVIDER=1`.

Four WARNINGs remain. None is a BLOCKER. Each one needs either a ≥10-minute stall of a live process, a crash in a specific window, or an unverified provider behaviour. Three of them touch the money path, and they should be closed before the first paid run.

## Warnings

### WR-01: A submit run that passed the attempt check before a retry can still reserve and send its old key, then write that request id onto the new attempt

**File:** `backend/src/pipeline.ts:225-276`, `backend/src/pipeline.ts:319-336`
**Issue:** The attempt check is a plain read at line 226. Reserving (231), marking (272) and sending (276) all happen later, and none of them is conditioned on the attempt or on still owning the lease. `handleSubmit` never heartbeats. Here is the sequence:

1. Run A of J1 (attempt 1, key K1) passes line 226, then stalls for more than `LEASE_SECONDS`, for example on a pool or connection hang.
2. Run B claims J1 and refuses with a retryable code before reserving K1. `BUDGET_EXCEEDED` is one example.
3. The owner retries. That mints K2 and retires J1 (`phase='done'`), and J2 is enqueued.
4. A wakes up, reserves K1 (its local `key`) and sends K1. Echo-3 creates a second, billed request.
5. The success tx at line 321 writes K1's request id onto the attempt-2 row without checking `submissionKey`, and flips it to `processing`.
6. J2 then sends K2 (billed) and overwrites `providerRequestId` again. One of the two paid requests is never tracked.

The K1 reserve then sits on an archived attempt. Purge's held-reserve check (`worker.ts`) only looks at the current key, so the world can be hard-deleted while K1 is billed. This is the same class as CR-01, narrowed from "crash window" to "stall window".

**Fix:** Stop on a lost lease right before spending, and never record a request id for a key the world no longer holds:
```ts
// before reserveCredits AND again right before provider.submit:
await heartbeat(deps, job)();   // retired job → phase 'done' → LeaseLostError, nothing sent
...
// success tx:
await tx.update(worlds).set({ providerRequestId: requestId })
  .where(and(eq(worlds.id, worldId), eq(worlds.submissionKey, key)));
// 0 rows → console.error with worldId/key/requestId for reconciliation; do not flip/enqueue.
```
Add a pg test: a run is paused after line 226, `applyRetry` runs, the run resumes, and the test asserts zero sends of K1.

### WR-02: A stale run's `refuse()` and quote write are not scoped to an attempt, so it can fail or re-quote the new attempt

**File:** `backend/src/pipeline.ts:166-170`, `backend/src/pipeline.ts:183-190`, `backend/src/pipeline.ts:199-223`
**Issue:** Take the same stale run A as in WR-01, but stalled before line 180. After the retry the world is `submitting` again with `submit_body = NULL` and `quoted_credits = NULL`.
- A's quote write (guarded only by `submit_body IS NULL`) lands on attempt 2. If A's quote exceeds the *old* `approvedMaxCredits` it holds in memory, `refuse('QUOTE_ABOVE_APPROVAL')` fails attempt 2. `failWorld` matches on `status IN ('submitting')` only.
- If A's write lands between J2's quote write and J2's body persist, J2 reserves A's amount. That amount was checked against the old approval, not the new one.
- A's `BUNDLE_NOT_RANGEABLE`, `NOT_APPROVED` and `BUNDLE_MISSING` refusals can fail attempt 2 the same way. A's body persist (line 219) can write A's zip URL into attempt 2.

The completeJob owner guard makes A's job update a no-op, but the world update still lands.

**Fix:** Scope every world write in `handleSubmit` to the attempt read at entry (`const attempt = w.submitAttempt`). Add `eq(worlds.submitAttempt, attempt)` to the quote update, the body persist, and `refuse()`'s `failWorld`. For example, give `failWorld` an optional extra `SQL` condition, or inline the update in `refuse`. The WR-01 heartbeat placed before the quote also closes most of this.

### WR-03: Download redirects are no longer followed at all, so a storage hop that redirects once more wedges a paid import forever

**File:** `backend/src/provider/echo3.ts:128-145`
**Issue:** `bareGet` now uses `redirect: 'manual'` and treats any non-2xx as `ProviderError(status 3xx)`. Some signed URLs redirect again: for example S3's global endpoint answers 307 for buckets outside us-east-1, and some CDNs put a 302 in front of the object. In that case every `trackOnce` pass throws. `handleTrack` snoozes, by design, "never gives up", and the splat of a paid, completed run is never imported. Before the fix those hops were followed. Nothing in the replay fixtures or tests exercises a second hop, and the real storage host is still unverified (IN-05).
**Fix:** Follow a bounded number of hops by hand and check each one:
```ts
for (let hop = 0; hop < 3; hop++) {
  if (!downloadAllowed(url, loopbackOk)) throw new ProviderError(`${endpoint}: refusing download host`, { endpoint });
  res = await f(url, { redirect: 'manual', signal });
  if (res.status < 300 || res.status >= 400) break;
  const loc = res.headers.get('location'); await res.body?.cancel();
  if (!loc) throw new ProviderError(...);
  url = new URL(loc, url);
}
```
Share one `AbortSignal.timeout(tDownload)` across all hops. Add a test where hop 1 is public and hop 2 is `169.254.169.254`, and assert it is refused.

### WR-04: Releasing on a refusal and failing the world are still two statements, so a crash between them leaves a released ledger on a key that will be re-sent

**File:** `backend/src/pipeline.ts:292-293`, `backend/src/pipeline.ts:306-308`
**Issue:** `releaseCredits(db, key)` commits, then `refuse(...)` runs in its own tx. A crash between the two leaves the world in `submitting`, the job in `running`, and K1 released. The line-284 `mark` already cleared `sending`. On resume, `reserveCredits` returns `'already'` because the reserve row still exists, and the run re-sends K1. If the provider now accepts (402 → credits topped up, 429 → window passed), the request is paid while the ledger shows reserve + release = 0. Budget caps under-count real spend, and purge's held-reserve check no longer protects the row. This is the same crash-window class as iteration-1 WR-01. Now that `refuse` is transactional, the fix is one line.
**Fix:** Move the release into `refuse`'s tx: `refuse(code, msg, { release: key })` → `await releaseCredits(tx, key)` before `failWorld`.

## Info

### IN-11: The thumbnail catch swallows `LeaseLostError`, so a worker that lost its lease keeps importing and can finalize `ready`
**File:** `backend/src/pipeline.ts:463-468`
**Issue:** When `trackErrs(job) >= 2`, any error on the thumbnail is swallowed, including a lease loss raised by `withHeartbeat`. The thumbnail is pushed last in `artifacts()`, so no further `beat()` follows. The losing worker then writes `ready` without `thumbnailKey`. The new owner's later `ready` update matches 0 rows, and its uploaded thumbnail is never recorded.
**Fix:** `if (err instanceof LeaseLostError || a.kind !== 'thumbnail' || trackErrs(job) < 2) throw err;`

### IN-12: After a 0-row quote write, the run keeps using its stale `w.submitBody == null`
**File:** `backend/src/pipeline.ts:188-199`
**Issue:** The losing run still runs the Range preflight. If the preflight fails, it fails a world the other run is actively sending, with `BUNDLE_NOT_RANGEABLE`. The revival path rescues the world only on a 2xx. A definitive refusal then shows the wrong (non-retryable) code.
**Fix:** `if (!quoted) w = (await getWorld(db, worldId))!;` before line 193.

### IN-13: `withHeartbeat` only beats when a chunk arrives
**File:** `backend/src/pipeline.ts:77-88`
**Issue:** A source that stalls with no bytes for more than 600 s, while still inside the 15-minute download timeout, loses the lease with no heartbeat. Rare, and recoverable through the normal re-claim.
**Fix:** Optionally add a `setInterval(beat, everyMs)` that is cleared on `close`.

### IN-01 … IN-10 (carried over from iteration 1, unchanged, out of fix scope)
- IN-01: The exact-bytes guarantee rests on re-stringifying jsonb (`pipeline.ts:276`).
- IN-02: The retry sheet spins forever when `frame_count` is null (`retry.tsx`).
- IN-03: The budget alert slot is spent even when the submit is later refused, and a reservation refused with `BudgetExceededError` never alerts (`budget.ts:159-181`).
- IN-04: The budget banner dismissal is keyed by window name, not window start (`(tabs)/index.tsx`).
- IN-05: The thumbnail allowlist assumes `*.spaitial.ai`. Verify on the first paid run (`echo3.ts:33-37`).
- IN-06: The validation-code list misses likely capture-quality codes (`retry.ts:19-20`).
- IN-07: The test money guard misses trailing-dot FQDNs and covers only `fetch` (`test/setup-no-spaitial.ts`).
- IN-08: The recorder writes synthetic artifact paths into a `synthetic: false` manifest (`scripts/record-echo3-run.ts`).
- IN-09: `SPAITIAL_BASE_URL` accepts any https host (`config.ts`).
- IN-10: `deleteWorld` on 409 cancels and then rethrows, so purge burns attempts (`echo3.ts:302-312`).

---

_Reviewed: 2026-11-25T03:01:05Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
_Iteration: 2_
