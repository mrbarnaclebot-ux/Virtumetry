---
phase: 06-live-echo-3-provider
plan: 07
subsystem: backend-retry
tags: [retry, money-path, idempotency, budget-alert, api-contract]
requires: [06-02 isRetryable + world_attempts, 06-04 budgetAlertFor/spentCredits + SUBMIT_UNCERTAIN]
provides: [POST /v1/worlds/:id/retry, retryable/submit_attempt/frame_count payload fields, budgetAlert on list + quote]
affects: [app retry sheet (06-03), Library retry entry + budget banner (06-05)]
tech-stack:
  added: []
  patterns: [conditional UPDATE on submit_attempt as optimistic lock, sentinel throw to roll back a tx, correlated subqueries for per-row list facts]
key-files:
  created:
    - backend/test/integration/retry.pg.test.ts
  modified:
    - backend/src/retry.ts
    - backend/src/routes/worlds.ts
    - backend/src/routes/scans.ts
    - backend/test/scans.quote.test.ts
    - backend/test/worlds.list.test.ts
decisions:
  - "latestCapture moved to worlds.ts and exported; scans.ts imports it (no copy)"
  - "heldReserveSql(key) in retry.ts is the WR-01 held query; the list embeds it with raw `worlds.submission_key` so the column cannot bind to credit_events r"
  - "Replay is checked before isRetryable (after a retry the world is no longer failed, so a lost response must still replay 200)"
  - "Unique violation in applyRetry: own key now archived -> 200 replay, else 409 not_retryable (concurrent loser)"
metrics:
  duration: ~12 min
  completed: 2026-11-25
  tasks: 2
  files: 6
---

# Phase 6 Plan 07: Server retry + alert surfacing Summary

POST /v1/worlds/:id/retry takes a fresh approval and makes exactly one new attempt. It requires a UUID Idempotency-Key, uses the create rate-limit bucket, checks isRetryable plus the A-02 ledger guard, re-quotes on the server, and runs one conditional transaction that archives the old attempt, mints a new key and enqueues the job. The world payload now carries `retryable`, `submit_attempt` and `frame_count`, and `budgetAlert` is on GET /v1/worlds and GET /v1/quote.

## What was built

- **retry.ts**
  - `heldReserveSql`: the WR-01 query.
  - `ledgerClear(db, key)`: a null key counts as clear.
  - `applyRetry(db, w, {...})`: one `db.transaction`. It inserts the `world_attempts` row (attempt = N, old key, request id, failure codes, quoted credits, client_request_id). Then it updates the world only `WHERE status='failed' AND deleted_at IS NULL AND submit_attempt = N`. The update sets a new `randomUUID()` key, nulls submit_body, provider_request_id, quoted_credits, failure_* and progress, applies the new approval, sets `submit_attempt + 1` and moves status to `submitting` (bundle present) or `packing`. If the update hits 0 rows, a sentinel throw rolls back and the function returns null. Otherwise it enqueues `submit`, or `pack {captureId}`. It never touches credit_events or the scan quota (A-04).
- **worlds.ts**
  - Retry route steps, in order: auth, then strict zod body (int, positive, ≤ 2e9), then Idempotency-Key, then findOwnedWorld (404), then replay by (world_id, client_request_id), then not_retryable (status / isRetryable / ledger / no capture), then `provider.quote(frames)` and `approval_below_quote { quote_credits }`, then applyRetry.
  - It logs only `{ worldId }`.
  - `serializeWorld(w, extra)` adds `retryable = isRetryable && !ledgerHeld`, `submit_attempt` and `frame_count`.
  - The list fetches frame_count and ledgerHeld in one query using correlated subqueries. The detail route computes both too.
  - The list reply adds `budgetAlert`.
  - `worldsRoutes` now builds `provider = deps.provider ?? createProvider(config)`.
- **scans.ts:** `/v1/quote` adds `budgetAlert: budgetAlertFor(spent, ...)`.

The field names match the app: `{ world: LibraryItem }`, the `retryable` / `submit_attempt` / `frame_count` fields in display-state.ts, `BudgetAlert { window, share, spent, budget }`, and the `not_retryable` / `approval_below_quote` codes handled in retry.tsx.

## Verification

- `npx tsc --noEmit`: clean.
- `npx vitest run`: 475 passed, 152 skipped (pg suites skip without TEST_DATABASE_URL).
- `npm run test:pg -- test/integration/retry.pg.test.ts`: 12/12 passed. Covered: 404, 400 key/body, 409 not_retryable, ledger-held 409 (payload also shows retryable false), approval_below_quote, success reset + archive + quota untouched, idempotent replay, pack when the bundle is gone, concurrent 200/409 with one attempt row, payload fields, budgetAlert null then daily, and end to end FAILED -> retry -> ready with two keys (first released, second kept).
- `npm run test:pg -- test/integration/scans.pg.test.ts`: 12/12 passed.
- Zero SpAItial network calls. Mock provider only.

## Deviations from Plan

**1. [Rule 3 - Blocking] Existing quote shape test updated in Task 1.** Adding `budgetAlert` broke the exact-shape `toEqual` in `scans.quote.test.ts`. `budgetAlert: null` was added to that expectation in the Task 1 commit so the full suite stays green. The new budgetAlert cases landed in Task 2. Commit eb35dbc.

**2. TDD ordering.** The plan puts implementation in Task 1 and tests in Task 2, so the Task 2 tests passed on first run instead of going through a RED phase. This is the plan's ordering, not a skipped gate. Because they passed immediately, every case asserts concrete state (row counts, keys, job kinds) rather than just status codes.

## Known Stubs

None.

## Deferred / notes

- If a bundle object were deleted while `captures.bundle_key` stays set, retry would go to `submitting` with a dead ZIP URL. Today bundles are removed only by purge, which also deletes the world, so this can't happen yet. Revisit if a bundle retention sweep is added.

## Commits

- eb35dbc feat(06-07): retry route, applyRetry transaction, retryable payload and budgetAlert
- 0966450 test(06-07): retry contract, money guards and payload fields

## Self-Check: PASSED

- FOUND: backend/src/retry.ts, backend/src/routes/worlds.ts, backend/src/routes/scans.ts, backend/test/integration/retry.pg.test.ts
- FOUND: eb35dbc, 0966450
