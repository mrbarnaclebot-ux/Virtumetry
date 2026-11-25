---
phase: 06-live-echo-3-provider
fixed_at: 2026-11-25T08:40:00Z
review_path: .planning/phases/06-live-echo-3-provider/06-REVIEW.md
iteration: 1
findings_in_scope: 12
fixed: 12
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-11-25T08:40:00Z
**Source review:** .planning/phases/06-live-echo-3-provider/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 12 (CR-01, WR-01..WR-11; Info findings out of scope)
- Fixed: 12
- Skipped: 0

HARD MONEY RULE held: no request to `*.spaitial.ai`. All client tests use injected `fetch` with `api.example.com` or `127.0.0.1` hosts, or the local fake. Nothing sets `ALLOW_PAID_PROVIDER` or `PROVIDER_MODE=live` in any env, script or CI. The only such values are cast `Config` literals inside `test/provider/mock.test.ts`, which point at `https://127.0.0.1:1` and exist to prove the WR-09 guard. No schema change. Work ran in the main tree, not an isolated worktree, because the pg suites need `backend/.env` and `node_modules`. Each commit staged only its own files.

## Fixed Issues

### CR-01: A retry can run alongside a stale submit job from the previous attempt

**Files modified:** `backend/src/pipeline.ts`, `backend/src/retry.ts`, `backend/test/integration/retry.pg.test.ts`, `backend/test/integration/echo3-contract.pg.test.ts`
**Commit:** ea52a4d
**Applied fix:**
- `applyRetry` marks every queued or running `pack`/`submit`/`track` job of the world `done` inside the retry transaction.
- `refuse()` runs `failWorld` and `completeJob` in one transaction.
- Submit jobs now carry `payload.submitAttempt`, set by `handlePack` and `applyRetry`. `handleSubmit` stops at entry, and again right after the pre-send re-read, if the world's `submit_attempt` differs. The `sending`/`uncertain` marker keeps `submitAttempt`.
- Regression test: a crashed attempt-1 submit job is retired by the retry, and a stale attempt-1 job sends nothing. The V2 payload expectation was updated.
**Status:** fixed: requires human verification (logic)

### WR-01: Processing FAILED/CANCELLED non-atomic with releaseCredits

**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 52678d8
**Applied fix:** The release and the failed/cancelled flip now run in one transaction, with the release first. Regression test: a trigger makes the release insert fail. The world must stay `processing` with the reserve held, then finish both once the trigger is dropped. This test fails on the old code.

### WR-02: SSRF via download redirects and thumbnail redirects

**Files modified:** `backend/src/provider/echo3.ts`, `backend/test/echo3.client.test.ts`
**Commit:** e2c151c
**Applied fix:**
- New `downloadAllowed()` check: the URL must be https, must not be an IP literal (IPv4 forms are normalized by WHATWG), and must not use an internal suffix (`localhost`, `.local`, `.internal`, `home.arpa`).
- Loopback is allowed only when the API base is itself loopback (the test fake).
- `bareGet` enforces the check before fetching and uses `redirect: 'manual'`, so no hop goes unchecked.
- Tests cover metadata IP, private IP, decimal IP, `[::1]`, http, `.internal`, `file:`, and a positive public-host case (no auth, manual redirect). The `ponytail:` note covers DNS rebinding.

### WR-03: Provider response shapes not validated

**Files modified:** `backend/src/provider/echo3.ts`, `backend/test/echo3.client.test.ts`
**Commit:** 6a61ee2
**Applied fix:**
- `quote()` requires `required_credits` to be a positive integer and `available_credits` to be a number.
- `limits()` requires positive integers with min ≤ max. A bad shape is never cached.
- Both throw a status-less `ProviderError`. Tests cover each bad shape.

### WR-04: Download timeout longer than the job lease

**Files modified:** `backend/src/pipeline.ts`, `backend/src/provider/echo3.ts` (comment), `backend/test/echo3.client.test.ts`
**Commit:** 3e47512
**Applied fix:**
- New `withHeartbeat(src, beat, everyMs=60s)` Transform: it beats the lease mid-stream, and a lost lease errors the stream so the upload aborts.
- It is used in `handleTrack` around `provider.open(a)`.
- Unit tests: beats during the stream, a lost lease errors the stream, and a source error propagates.

### WR-05: Quote can be overwritten after the body is persisted

**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 23a4e8b
**Applied fix:**
- The quote update is conditional on `submit_body IS NULL`. `QUOTE_ABOVE_APPROVAL` is refused only when that write landed.
- Regression test: run B quotes from a stale read while run A persists the body, reserves and sends. The quote, `credits_spent` and the ledger stay at A's amount. Confirmed failing on the old code (4000 vs 930).

**Status:** fixed: requires human verification (logic)

### WR-06: applyRetry's conditional update did not re-check retryability; ledger check outside tx

**Files modified:** `backend/src/retry.ts`, `backend/test/integration/retry.pg.test.ts`
**Commit:** 90b2f30
**Applied fix:**
- The WHERE clause now also requires `failure_stage`, `failure_code`, `failure_message` and `submission_key` to be unchanged (`IS NOT DISTINCT FROM`), plus `NOT EXISTS (heldReserveSql(worlds.submission_key))`.
- Regression test: a stale world snapshot loses, with no attempt, no job and no new key, when a reserve appeared or the failure code changed.

**Status:** fixed: requires human verification (logic)

### WR-07: Budget-alert push awaited inline before the paid send

**Files modified:** `backend/src/pipeline.ts`, `backend/test/integration/scenarios.pg.test.ts`
**Commit:** ba9fe88
**Applied fix:**
- `onAlert` now logs and fires `deps.push` with `void Promise.resolve().then(push).catch(log)`. It is called after the reserve commit and never awaited, so the send never waits on it.
- Regression test: a push that never settles still lets the world reach `ready` with one submit.

### WR-08: Copy contradicts the Retry button for retryable processing failures

**Files modified:** `virtumetry/src/library/display-state.ts`, `virtumetry/src/app/world/[id]/retry.tsx`, `virtumetry/src/__tests__/display-state.test.ts`
**Commit:** 53c4322
**Applied fix:**
- `failureText` and `failureGuidance` take the server's `retryable` flag. When it is true, the headline is "Stopped by your spending limit" for limit codes or "Something went wrong while processing" otherwise, and the guidance is `G_LIMIT` or `G_PROVIDER` to match.
- The retry sheet and the Library row both pass the flag.
- Non-retryable `WORLD_GENERATION_FAILED` keeps its "rejected" text.
- Tests cover `INTERNAL_ERROR`, `WORLD_GENERATION_FAILED`, `RATE_LIMITED`, `HTTP_402`, `BUDGET_EXCEEDED`, and the row.

### WR-09: createProvider builds the paid client without its own guard

**Files modified:** `backend/src/provider/index.ts`, `backend/test/provider/mock.test.ts`
**Commit:** 7b277ce
**Applied fix:**
- Live mode throws `createProvider: live refused (D-04 guard)` unless all of these hold: `ALLOW_PAID_PROVIDER === '1'`, the API key is set, the webhook secret is set, and the base URL is `https://`.
- Tests: a cast live Config is refused for each missing condition. A complete one pointing at `https://127.0.0.1:1` builds the client and makes no request.

### WR-10: V5 "kill mid-submit" did not simulate a kill

**Files modified:** `backend/test/integration/scenarios.pg.test.ts`
**Commit:** 367f2b2
**Applied fix:** V5 was rewritten on the V2 pattern:
1. The submit returns a never-settling promise after the real accept.
2. The job is claimed manually.
3. The test asserts `phase='running'`, `locked_by`, and payload `{ submitAttempt: 1, uncertain: false, sending: true }`.
4. The lease is aged and the queue drained.
5. Assertions: two submits with the same key and body, the same request id, and one reserve.

### WR-11: Retry route quote failure → 500; replay ignores ledger guard

**Files modified:** `backend/src/routes/worlds.ts`, `backend/test/integration/retry.pg.test.ts`
**Commit:** 6d8e26b
**Applied fix:**
- A `ProviderError` from `quote()` now maps to `503 { error: 'quote_unavailable', retry_after }` for 429, 503 and timeouts, and to `502 { error: 'quote_failed' }` for anything else. Nothing is written.
- `replay()` computes `ledgerHeld` the way GET detail does. The success response passes `ledgerHeld: false` because the new key holds no reserve yet.
- Tests use a `vi.mock` wrapper on `createProvider` to cover the 503 (with and without `retry_after`) and 502 cases, and a replay after a re-failure with a held reserve, which returns `retryable=false` and agrees with GET.
- The app needed no change: its generic "Couldn't start the retry… try again" copy fits a 502/503.

## Verification

- backend: `npx tsc --noEmit` clean. `npx vitest run`: 508 passed, 160 skipped (pg).
- backend pg: retry, echo3-contract, scenarios and budget-alert suites run per fix. Full `npm run test:pg`: 18 files passed, 1 skipped; 174 tests passed, 1 skipped.
- virtumetry: `npx expo lint` clean, `npx tsc --noEmit` clean, `npx jest --ci`: 341/341.

---

_Fixed: 2026-11-25T08:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
