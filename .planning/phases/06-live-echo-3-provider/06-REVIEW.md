---
phase: 06-live-echo-3-provider
reviewed: 2026-11-25T02:18:27Z
depth: deep
files_reviewed: 34
files_reviewed_list:
  - backend/src/provider/echo3.ts
  - backend/src/provider/index.ts
  - backend/src/config.ts
  - backend/src/pipeline.ts
  - backend/src/budget.ts
  - backend/src/retry.ts
  - backend/src/routes/worlds.ts
  - backend/src/routes/scans.ts
  - backend/src/worker.ts
  - backend/src/db/schema.ts
  - backend/drizzle/0005_phase6_retry_alerts.sql
  - backend/scripts/record-echo3-run.ts
  - backend/.env.example
  - backend/package.json
  - backend/vitest.config.ts
  - backend/test/setup-no-spaitial.ts
  - backend/test/helpers/fake-echo3.ts
  - backend/test/helpers/pipeline.ts
  - backend/test/echo3.client.test.ts
  - backend/test/integration/echo3-contract.pg.test.ts
  - backend/test/integration/retry.pg.test.ts
  - backend/test/integration/budget-alert.pg.test.ts
  - backend/test/integration/scenarios.pg.test.ts
  - backend/test/integration/purge-cascade.pg.test.ts
  - backend/test/retryable.test.ts
  - backend/test/fixtures/echo3-recorded/manifest.json
  - virtumetry/src/app/world/[id]/retry.tsx
  - virtumetry/src/components/approval.tsx
  - virtumetry/src/components/library-row.tsx
  - virtumetry/src/app/(tabs)/index.tsx
  - virtumetry/src/app/capture/[id].tsx
  - virtumetry/src/app/world/_layout.tsx
  - virtumetry/src/lib/api.ts
  - virtumetry/src/library/display-state.ts
findings:
  critical: 1
  warning: 11
  info: 10
  total: 22
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-11-25T02:18:27Z
**Depth:** deep (pipeline, provider, budget, retry route, worker/purge and app client traced together)
**Files Reviewed:** 34
**Status:** issues_found

## Summary

The main exactly-once path holds up. The key is minted once with a conditional update. The body is persisted conditionally and always re-read from the DB before sending, so the first send and every resume send the same bytes. The reservation is made before the send, and the sticky `sending` marker means a real crash mid-send resumes with the same key and body (contract test V2 proves this against the HTTP fake). The A-02 ledger guard blocks a retry whenever the old key still holds a reservation. 409, 5xx and timeouts never release, and the client never retries internally. The API key travels only in the `Authorization` header on API-host calls and is dropped on redirect.

The weak spot is how a retry interacts with jobs that are still alive. `applyRetry` never retires the world's other non-terminal pipeline jobs. `refuse()` fails the world and completes the job in two separate statements. The "uncertain" marker is scoped to the job, not the key. Together these mean that after one crash window, two submit jobs can run against the new key with different views of whether it is uncertain (CR-01). Other findings: the processing FAILED/CANCELLED path is non-atomic and can leave a reservation held forever. The redirect and thumbnail SSRF guards are incomplete. Provider response shapes are not validated. The download timeout is longer than the job lease. The budget-alert push is awaited inline in front of the paid send. `createProvider` has no guard of its own. And the "V5 kill mid-submit" scenario test does not test a kill.

HARD MONEY RULE check: no test, script default or config default enables live mode. `.env.example` keeps `PROVIDER_MODE=mock`, and `ALLOW_PAID_PROVIDER` is commented out. `record-echo3-run.ts` refuses unless the owner sets both variables. The vitest setup file blocks `*.spaitial.ai` at `fetch`. Every echo3 test points at a `127.0.0.1` fake. Remaining defence-in-depth gaps are WR-09 and IN-07.

## Critical Issues

### CR-01: A retry can run alongside a stale submit job from the previous attempt: two submit jobs on the new key, uncertainty tracked per job

**File:** `backend/src/retry.ts:63-108`, `backend/src/pipeline.ts:138-141`, `backend/src/pipeline.ts:229-235`
**Issue:** `refuse()` calls `failWorld(...)` and then `completeJob(...)` as two separate statements. If the process dies between them (crash, OOM, SIGKILL after `SHUTDOWN_GRACE_MS`), the world is `failed` with a retryable code (`RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `HTTP_402`/`INSUFFICIENT_CREDITS`, `QUOTE_ABOVE_APPROVAL`, `BUDGET_EXCEEDED`). Meanwhile the submit job J1 stays `running`/locked. It becomes claimable again when its 600 s lease expires, because `attempts < MAX_ATTEMPTS`. The ledger is clear: either the refusal released it, or nothing was ever reserved. So `POST /v1/worlds/:id/retry` succeeds. `applyRetry` mints K2, flips the world to `submitting` and enqueues J2, but leaves J1 alone. When J1 is re-claimed, `handleSubmit` sees `status='submitting'` and runs against K2 too, so two submit jobs share one key:
- The ponytail comment at `pipeline.ts:229-230` ("the marker is effectively per key") becomes false. Suppose J1's send of K2 times out (`uncertain` marked on J1's payload only), and J2 then gets a definitive 4xx. J2 releases K2's reservation as "known not charged", even though J1's request may exist and be billed. This is exactly what Pitfall 7 forbids.
- Echo-3's behaviour when the same key arrives while the first request is still in flight is undocumented. If it answers 409, J2 parks the world as `IDEMPOTENCY_KEY_REUSED`. J1's later resume then exits at the `status !== 'submitting'` check (`pipeline.ts:136`) without recording its request id, and a paid request is orphaned.

D-09 says "a new submission_key is minted only here — the pipeline still never mints a second key on its own". The intent is one live submit per key, and nothing enforces it.
**Fix:** Retire every other non-terminal pipeline job for the world inside the retry transaction, and make the refusal atomic:
```ts
// retry.ts, inside applyRetry's tx, before enqueue():
await tx.update(jobs)
  .set({ phase: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
  .where(and(eq(jobs.worldId, w.id), inArray(jobs.kind, ['pack', 'submit', 'track']),
             inArray(jobs.phase, ['queued', 'running'])));
// (or refuse the retry with 409 when such a job exists and is still leased)

// pipeline.ts refuse(): one tx for failWorld + completeJob
```
Also add a submit-time guard: at the top of `handleSubmit`, and again right before `provider.submit`, re-read the world and stop if `submitAttempt` changed since the job was enqueued. Store `submitAttempt` in the job payload when enqueuing.

## Warnings

### WR-01: Processing FAILED/CANCELLED: failWorld/status flip and releaseCredits are separate statements, so a crash leaves a reservation held forever and the world never retryable

**File:** `backend/src/pipeline.ts:364-377`
**Issue:** `failWorld(...)` commits first and `releaseCredits(...)` runs afterwards. A crash between the two leaves the world `failed`. The re-claimed track job then exits at `trackOnce`'s status check (`pipeline.ts:348`), so the release never happens. The 0-credit run keeps counting against that day's and month's budget. Because `ledgerHeld` is true, `retryable` stays false for good, even though the provider proved nothing was charged. The CANCELLED branch has the same problem.
**Fix:** Run both in one transaction (`releaseCredits` already accepts `Pick<Db,'execute'>`), or release first. Release is idempotent through the unique index, and the FAILED status is sticky at the provider, so a re-poll after a crash will finish the job:
```ts
await db.transaction(async (tx) => {
  await releaseCredits(tx, w.submissionKey!);
  await failWorld(tx as unknown as Db, w.id, ['processing'], 'processing', code, msg);
});
```

### WR-02: SSRF: download redirects are followed to any scheme or host, and thumbnail fetches follow redirects past the allowlist

**File:** `backend/src/provider/echo3.ts:108-121`, `backend/src/provider/echo3.ts:256-263`, `backend/src/provider/echo3.ts:33-37`
**Issue:** `open()` takes the `Location` of the API's 3xx and fetches `new URL(loc, base)` without checking the protocol or host. A `http://169.254.169.254/...` or `http://10.x` target would be fetched by the worker, streamed into R2 as `splat.spz`, and served to the user through a presigned URL. `bareGet` also uses `fetch`'s default `redirect: 'follow'`. So a thumbnail URL that passes the `*.spaitial.ai` allowlist (for example a CDN or an open redirect) can bounce to any internal address. The key is correctly stripped, but the response body is still exfiltrated. The prompt and T-06-04 both ask for an allowlist in `open()`.
**Fix:** In `bareGet`, require `url.protocol === 'https:'` and reject IP-literal, loopback and private hosts. Pass `redirect: 'manual'` (or `'error'`) so no further hop goes unchecked, and apply the same check to the redirect target in `open()`. Optionally allowlist the documented storage host suffixes.

### WR-03: Provider response shapes are not validated: a missing or renamed `required_credits` slips past the QUOTE_ABOVE_APPROVAL and approval_below_quote checks

**File:** `backend/src/provider/echo3.ts:136-149`, `backend/src/pipeline.ts:151-155`, `backend/src/routes/worlds.ts:255-258`
**Issue:** `quote()` returns `b.required_credits` cast blindly. If the field is missing (schema drift), `quote.credits` is `undefined`. Then `undefined > approvedMaxCredits` is `false`, so the pipeline's ceiling check passes, and the retry route's `approved < undefined` is also `false`, so `applyRetry` runs. The only thing stopping a send today is the NOT NULL on `credit_events.amount` (drizzle skips the `undefined` in `.set`). That is accidental safety. `limits()` has the same problem: a missing `min_frames`/`max_frames` gives `NaN`. `Math.max(x, NaN)` disables the pack min-frames check, and `z.number().max(NaN)` makes every `/v1/quote` return 400 for the next hour (cached).
**Fix:** Validate at the client boundary and throw a `ProviderError` with no status on mismatch:
```ts
if (!Number.isInteger(b.required_credits) || b.required_credits <= 0) throw new ProviderError('quote: bad shape', { endpoint: 'quote' });
```
Do the same for `min_frames`/`max_frames` (positive integers, min ≤ max).

### WR-04: Download timeout (15 min) is longer than the job lease (10 min), so slow imports run twice at once

**File:** `backend/src/provider/echo3.ts:20`, `backend/src/pipeline.ts:411-428`
**Issue:** `T_DOWNLOAD_MS = 900_000`, but `LEASE_SECONDS = 600`, and the track job only heartbeats after each artifact finishes (`await beat()` after `putStream(...).done`). A splat transfer that takes more than 10 minutes lets a second worker claim the track job and import the same artifacts at the same time. The first worker then hits `LeaseLostError`. The `T_SUBMIT_MS` comment already states the rule ("must stay well under LEASE_SECONDS/2"), and the download path breaks it.
**Fix:** Heartbeat while streaming, for example by wrapping the Readable with a `Transform` that calls `beat()` every N MB or seconds. Otherwise cap `T_DOWNLOAD_MS` below `LEASE_SECONDS*1000/2`. Add a unit test next to the existing `T_SUBMIT_MS < LEASE` test.

### WR-05: The quote can be overwritten after the body is persisted (missing `isNull(submitBody)` guard)

**File:** `backend/src/pipeline.ts:150-156`
**Issue:** The WR-01 comment says that once the body is persisted, "the quote that the reservation was made for is never rewritten". But the update at line 155 is unconditional. Suppose two runs of the same job race (contract test V3 exercises exactly this) and run B read the world before run A persisted the body. B re-quotes and overwrites `quoted_credits` after A has already reserved the old amount. `credits_spent` (copied from `quoted_credits` at ready) can then disagree with the ledger. Also, if B's quote exceeds the approval, B fails a world that A is actively submitting. The WR-02 revival rescues the world only if A gets a 2xx response.
**Fix:** `.where(and(eq(worlds.id, worldId), isNull(worlds.submitBody)))` on the quote update. After a 0-row update, skip the approval refusal and re-read.

### WR-06: applyRetry's conditional update does not re-check what made the world retryable (D-09 deviation), and the ledger check is outside the transaction

**File:** `backend/src/retry.ts:96-103`, `backend/src/routes/worlds.ts:250-252`
**Issue:** D-09 specifies `WHERE status='failed' AND failure_* unchanged`. The implementation keys only on `submit_attempt`, which does not change when a world is revived (WR-02 path) and then failed again with a different code. `isRetryable` and `ledgerClear` run on the pre-transaction read, so the world can become non-retryable (for example `SUBMIT_UNCERTAIN`) or gain a held reserve between the check and the update, and the retry still wins.
**Fix:** Add `eq(worlds.failureStage, w.failureStage)`, `eq(worlds.failureCode, w.failureCode)`, `eq(worlds.submissionKey, w.submissionKey)` (null-safe) to the WHERE clause. Repeat the held-reserve check inside the transaction (`NOT EXISTS (heldReserveSql(...))` in the WHERE clause, or `SELECT ... FOR UPDATE` on the world row first).

### WR-07: The budget-alert push is awaited inline, before the paid send

**File:** `backend/src/pipeline.ts:206-217`, `backend/src/budget.ts:185-191`
**Issue:** `reserveCredits` awaits `onAlert` after commit, and `onAlert` awaits `deps.push(...)`. Today `push` is a stub. D-12 states that Phase 7 makes it real APNs "with zero change". A slow or hung APNs call (no timeout here) then stalls the submit, with the reservation held and no heartbeat. Past the 600 s lease, a second worker claims the job and sends while the first is still waiting to send. Idempotency makes that recoverable, but it is a needless concurrent-send window, and alert latency ends up gating spend.
**Fix:** Fire and forget with a bounded timeout, for example `void Promise.race([deps.push(...), timeout(5000)]).catch(log)`. Or move the alert side effects after `provider.submit` returns.

### WR-08: Copy contradicts the Retry button for retryable processing failures

**File:** `virtumetry/src/library/display-state.ts:90`, `virtumetry/src/library/display-state.ts:121-134`, `virtumetry/src/app/world/[id]/retry.tsx:80-82`
**Issue:** The server marks any non-validation processing code as retryable (A-01), but `failureGuidance` gives the "provider problem" text only for the three codes in `GUIDE_PROVIDER`. A retryable world failed with, say, `INTERNAL_ERROR` falls through to `G_OTHER` ("This scan can't be retried. Scan the room again…"), and the same sheet shows an "Approve and retry" button. Also, `WORLD_GENERATION_FAILED`, which is the mock `failed` scenario and the one the owner will test in Expo Go, is in `REJECTED_CODES`. The headline then reads "The scan couldn't be turned into a room" while the guidance says "Trying again often works". The owner is making a money decision on contradictory text.
**Fix:** Pass `retryable` into `failureGuidance`/`failureText`. When it is true, always use `G_PROVIDER`/`G_LIMIT`, and take `WORLD_GENERATION_FAILED` out of `REJECTED_CODES` (or check it after the retryable check).

### WR-09: `createProvider` builds the paid client without its own guard

**File:** `backend/src/provider/index.ts:13-27`
**Issue:** The only barrier to the live client is `config.ts` `refine()`. Any `Config` built by hand or cast, as in `test/provider/mock.test.ts:282-289` (`{ PROVIDER_MODE: 'live', ... } as Config`), gets a real Echo-3 client with no `ALLOW_PAID_PROVIDER` check. It also gets a non-null-asserted `apiKey`, and `SPAITIAL_BASE_URL` falls back to production if omitted. Under the HARD MONEY RULE, the factory that creates the spending object should refuse on its own.
**Fix:**
```ts
if (config.ALLOW_PAID_PROVIDER !== '1' || !config.SPAITIAL_API_KEY || !config.SPAITIAL_WEBHOOK_SECRET || !config.SPAITIAL_BASE_URL?.startsWith('https://'))
  throw new Error('createProvider: live refused (D-04 guard)');
```
Update the mock test to pass `ALLOW_PAID_PROVIDER: '1'` and an `https://127.0.0.1` base, or to assert the refusal.

### WR-10: The scenarios V5 "kill mid-submit" test does not simulate a kill

**File:** `backend/test/integration/scenarios.pg.test.ts:231-258`
**Issue:** Throwing `LeaseLostError` from inside `provider.submit` is caught by `handleSubmit`'s `catch` around the send. It is not a `ProviderError`, so it becomes an ordinary uncertain retry (`RetryLaterError`, job unlocked and requeued). The 06-06 SUMMARY and the comment in `echo3-contract.pg.test.ts:106-110` both say so. The `UPDATE jobs SET locked_at = now() - 1h` that follows does nothing because the job is already unlocked. The test passes, but it proves only the 5xx/network retry path, and its name claims crash-resume coverage. The real crash case is covered only by contract test V2.
**Fix:** Delete V5, or rewrite it like V2: return a never-settling promise after the real submit, claim the job manually, assert `phase='running'` and `payload.sending=true`, age the lease, then drain. At minimum, rename it to "uncertain non-ProviderError after accept".

### WR-11: The retry route's quote failure surfaces as a 500, and the retry payload ignores the ledger guard

**File:** `backend/src/routes/worlds.ts:236-246`, `backend/src/routes/worlds.ts:255`, `backend/src/routes/worlds.ts:277`
**Issue:** (a) `provider.quote()` errors (Echo-3 429/5xx/timeout in live mode) are not caught, so the app gets a generic 500 and shows "Couldn't start the retry", with no backoff hint for a 429. (b) Both the replay response (`serializeWorld(current, { frameCount })`) and the success response leave out `ledgerHeld`. If the replayed world has failed again in the meantime, `retryable` can come back `true` while a reserve is held, which disagrees with GET `/v1/worlds/:id`.
**Fix:** Map a `ProviderError` from quote to `503 { error: 'quote_unavailable', retry_after }`. Compute `ledgerHeld` in `replay()` the same way the GET detail route does.

## Info

### IN-01: Exact-bytes guarantee depends on re-serializing jsonb, not on a stored string
**File:** `backend/src/pipeline.ts:184-190`, `backend/src/pipeline.ts:239`
**Issue:** D-02 says "client sends `body` as given, never re-serializes". The pipeline stores jsonb and sends `JSON.stringify(readback)`. This is stable, because jsonb key order is deterministic and the first send also uses the readback, but it rests on an implicit invariant.
**Fix:** Store `submit_body` as `text` (the exact string), or add a comment and a test asserting that the readback stringify is byte-identical across two reads.

### IN-02: Retry sheet spins forever when `frame_count` is null
**File:** `virtumetry/src/app/world/[id]/retry.tsx:125-131`
**Issue:** `enabled: !!world.frame_count` with a null count leaves the query `pending` for good. `QuoteCard` then shows "Getting quote…" indefinitely, with Approve disabled and no explanation.
**Fix:** When `frame_count` is null, render the NotRetryable guidance or an error state.

### IN-03: Budget alert slot is spent even when the submit is later refused, and a refused reservation never alerts
**File:** `backend/src/budget.ts:141-146`, `backend/src/budget.ts:159-181`
**Issue:** The alert is recorded at reservation time. If the submit is then refused and released, that window's once-only alert has already fired. A reservation refused with `BudgetExceededError` (spend at 75%, request pushes over 100%) never alerts at all.
**Fix:** Acceptable for v1. Document it in the runbook, or alert on `BudgetExceededError` as well.

### IN-04: Budget banner dismissal is keyed by window name, not window start
**File:** `virtumetry/src/app/(tabs)/index.tsx:20-37`
**Issue:** If the "daily" alert is dismissed and the next UTC day crosses the share again in the same JS session, the new alert stays hidden.
**Fix:** Key on `${window}:${budget}:${dayOrMonth}`, or have the server return `window_start`.

### IN-05: Thumbnail allowlist assumes thumbnails live on `*.spaitial.ai`
**File:** `backend/src/provider/echo3.ts:33-37`
**Issue:** If Echo-3 serves `thumbnail_url` from a storage or CDN host (likely for presigned media), every real thumbnail is silently dropped. The replay manifest has `thumbnail_url: null`, so no test covers this.
**Fix:** Confirm on the first paid run (add it to the runbook checklist), and extend the allowlist together with WR-02's protocol and IP checks.

### IN-06: Validation-code list misses obvious capture-quality codes
**File:** `backend/src/retry.ts:19-20`
**Issue:** Codes such as `TOO_FEW_FRAMES`, `INSUFFICIENT_FRAMES`, `FRAME_COUNT_*` or `POSE_*` would count as retryable provider errors. Failed runs cost 0, so the cost is wasted owner time, not money.
**Fix:** Reconcile the list with the codes seen in the first paid run.

### IN-07: The test money guard can be bypassed with a trailing-dot FQDN and only covers `fetch`
**File:** `backend/test/setup-no-spaitial.ts:14`
**Issue:** `api.spaitial.ai.` (trailing dot) resolves in DNS but fails `endsWith('.spaitial.ai')`. `node:https` and undici's own `request` are not wrapped.
**Fix:** `host.replace(/\.$/, '')` before the check. Optionally use `undici.setGlobalDispatcher` with an interceptor that blocks the host for every client.

### IN-08: The recorder writes artifact paths that do not match the recorded run
**File:** `backend/scripts/record-echo3-run.ts:109-121`
**Issue:** `artifacts` is hard-coded to `mock-outputs/splat.ply` and the others, while the real run's splat is SPZ. `statusSequence` is fixed to `['COMPLETED']`, so a "recorded" replay exercises neither the real binary formats nor the real polling sequence, but the manifest is marked `synthetic: false`.
**Fix:** Mark the manifest `artifacts_synthetic: true`, or point it at the R2 copies.

### IN-09: `SPAITIAL_BASE_URL` accepts any https host
**File:** `backend/src/config.ts:86`, `backend/src/config.ts:215-217`
**Issue:** A typo or a malicious env value sends the bearer key to an arbitrary host. Operator-controlled, so low risk.
**Fix:** In live mode, require the hostname to be `api.spaitial.ai`, or put an explicit override flag behind it.

### IN-10: `deleteWorld` on 409 cancels and then rethrows the 409, so purge burns attempts until the cancel lands
**File:** `backend/src/provider/echo3.ts:269-279`
**Issue:** Purge retries with exponential backoff and can go DEAD (5 attempts), leaving the world soft-deleted for good, if the provider takes a while to move from cancelling to deletable.
**Fix:** After a cancel, throw a `RetryLaterError`-style signal with a short fixed delay, or have purge snooze instead of fail.

---

_Reviewed: 2026-11-25T02:18:27Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
