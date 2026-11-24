---
phase: 04-0-capture-to-world-loop
fixed_at: 2026-11-24T00:00:00Z
review_path: .planning/phases/04-0-capture-to-world-loop/04-REVIEW.md
iteration: 2
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 4: Code Review Fix Report

**Fixed at:** 2026-11-24
**Source review:** .planning/phases/04-0-capture-to-world-loop/04-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 3 (1 Critical, 2 Warning; Info excluded by scope)
- Fixed: 3
- Skipped: 0

Verification: in `virtumetry`, `expo lint`, `tsc --noEmit` and `jest --ci` pass (211 tests). The backend was not touched. Each new regression test was confirmed to fail with the fix stashed.

## Fixed Issues

### CR-01: Cancelling (or leaving) a scan while it is starting deletes the previous saved scan's photos

**Files modified:** `virtumetry/src/capture/fixture-source.ts`, `virtumetry/src/__tests__/capture-fixture-source.test.ts`
**Commit:** 69a5cea
**Applied fix:**
- `stop()` now clears `this.dir` after building its result, and `start()` clears it before awaiting assets.
- `cancel()` can therefore only delete a directory that the current start created.
- Regression test, ported from the reviewer's repro: start, stop, start (pending), cancel. The first session directory still exists afterwards.

**Status:** fixed: requires human verification

### WR-01: Any 404 marks an uploading scan permanently failed, including a proxy or tunnel 404

**Files modified:** `virtumetry/src/lib/api.ts`, `virtumetry/src/upload/reconcile.ts`, `virtumetry/src/__tests__/upload-reconcile.test.ts`, `virtumetry/src/__tests__/library.test.tsx`
**Commit:** ec50caf
**Applied fix:**
- `ApiError` now has a `code` field, filled from the response body's `error` (one JSON parse per non-ok response, shared with the `account_deleted` check).
- `reconcile` treats a scan as gone only on `world_not_found`, `capture_not_found` or `idempotency_key_world_deleted`. Any other 404 or 409 is rethrown, so the backoff retries it.
- The same problem existed in `useDeleteWorld`, which treated any 404 as "already deleted". It now requires `world_not_found` too.
- Tests:
  - A bare 404, and a 409 `not_uploading` on create, both rethrow.
  - `apiFetch` sets `code` from a JSON body, and leaves it undefined for a non-JSON proxy body.

**Status:** fixed: requires human verification

### WR-02: An `approved` scan whose create is definitively refused retries forever with no escape in the UI

**Files modified:** `virtumetry/src/upload/reconcile.ts`, `virtumetry/src/app/capture/[id].tsx`, `virtumetry/src/app/(tabs)/index.tsx`, `virtumetry/src/library/display-state.ts`, `virtumetry/src/__tests__/upload-reconcile.test.ts`, `virtumetry/src/__tests__/capture-quote.test.tsx`, `virtumetry/src/__tests__/library-actions.test.tsx`
**Commit:** 2d0e822
**Applied fix:**
- **Background refusal is now terminal.** When the manager's `createScan` is definitively refused (a 400 carrying a server code, or a 429 `scan_quota_exceeded`), the scan becomes `failed` with `failureCode` set to the server code in upper case. That is a terminal state: the Library shows it as Failed / Not charged and offers Discard. A 429 `rate_limited` still retries.
- **Clearer failure text.** `APPROVAL_BELOW_QUOTE` and `SCAN_QUOTA_EXCEEDED` were added to `LIMIT_CODES`, so these rows read "Stopped by your spending limit".
- **The inline approve no longer reverts past a server id.** On a 4xx it goes back to `saved` only if `getLocalScan(id)?.serverWorldId` is still empty. This closes the race where the manager wins the create.
- **Delete instead of Discard whenever a server world exists.** A local row with a `serverWorldId` now always offers Delete rather than Discard, so a local-only Discard can never orphan a charged world. For WORLD_DELETED rows, Delete gets 404 `world_not_found`, which counts as success and drops the local copy.
  - One behaviour change: a `blocked` row with a server id now offers Delete, which also removes its failed server row.
- **Tests:**
  - Three refusal codes lead to `failed`, while `rate_limited` rethrows.
  - The inline 429 no longer reverts once the manager has stored a world.
  - The menu shows Delete for `failed` with a server id and Discard for `failed` without one.

**Status:** fixed: requires human verification (logic change in a money-adjacent path)

## Iteration 1 (summary)

All 11 in-scope findings were fixed. The full report is in `04-REVIEW-FIX.iter1.md`.
- CR-01 transactional create plus refund on any error (3a0d00e, 3974188)
- CR-02 atomic index write (0863028)
- CR-03 terminal 404/409 handling and state-gated Discard/Delete (0182ee7)
- CR-04 scenario synced to the source on mount (6970bac)
- WR-01 no duplicate rows (c85c17b)
- WR-02 durable approval (fb42451)
- WR-03 foreground backoff and stall guard (422e46c)
- WR-04 per-put progress (dfe2118)
- WR-05 cancel-while-starting and unmount cleanup (744dd08)
- WR-06 bounded create integers (97966a0)
- WR-07 done-entry prune (7ab4775)

---

_Fixed: 2026-11-24_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_

## Iteration 3 (orchestrator)

The final re-review (04-REVIEW.md, iteration 3) found 0 critical and 1 warning (WR-01: a refused background create forced Discard). The auto loop's 3-iteration cap was reached, so the orchestrator fixed it inline:

- **WR-01** (fix(04): iter-3 WR-01 …): a definite refusal (`approval_below_quote`, `scan_quota_exceeded`, other 400) now sets the scan back to `saved` with its failure code, so the owner can re-quote and re-approve with the same idempotency key. If an inline approve stored a server world meanwhile, the refusal writes nothing. Regression test in `upload-reconcile.test.ts`. App gate: lint, tsc, jest 211/211 green.

Remaining: info items only (empty session folder after Stop with 0 frames; generic message for unexpected 400 codes; corrupt-index backup overwrite; refund error masking; 100-row prune cap).
