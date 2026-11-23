---
phase: 02-bundle-pipeline-mock-provider
plan: 04
subsystem: backend-money-path
tags: [budget, advisory-lock, credit-ledger, provider, mock, webhook, hmac]

requires:
  - phase: 02-bundle-pipeline-mock-provider
    provides: "02-01 zipread + tiny-session fixture + mock-outputs; 02-02 credit_events submission_key/kind/provider_mode + MOCK_* config + pg-schema helper; 02-03 packCapture"
provides:
  - "reserveCredits(db, {key, amount, mode, worldId, daily, monthly}) -> 'reserved' | 'already'"
  - "releaseCredits(db, key): idempotent, dated at its reservation"
  - "BudgetExceededError(window, requested, spent, budget)"
  - "ReconProvider contract + ProviderError{status, code, retryAfterS} + signWebhook/verifyWebhookSignature"
  - "createMockProvider(opts) with every MOCK_SCENARIO + calls.submit log"
affects: [02-05 submit/track jobs, 02-06 webhook route, 02-07 end-to-end pipeline test]

tech-stack:
  added: []
  patterns:
    - "One reservation per submission_key: advisory xact lock + unique (submission_key, kind) + ON CONFLICT DO NOTHING"
    - "Compensating release copies the reservation's created_at, so it nets out of the window that was charged"
    - "Mock mirrors Echo-3 async validation: a bad bundle still returns a request id, then reports FAILED with issues"

key-files:
  created:
    - backend/test/integration/budget.pg.test.ts
    - backend/test/provider/mock.test.ts
  modified:
    - backend/src/budget.ts
    - backend/test/budget.test.ts
    - backend/src/provider/types.ts
    - backend/src/provider/mock.ts
    - backend/src/provider/index.ts
  deleted:
    - backend/test/mock-provider.test.ts

key-decisions:
  - "reserveCredits checks the daily window before the monthly one, so an error names 'daily' when both would be exceeded"
  - "Mock 429/503 fire once per provider instance (the first submit), then behave like happy"
  - "Mock bundle-check failures surface as FAILED + issues (error code VALIDATION_FAILED), never as a thrown submit"
  - "A webhook's event comes from the terminal outcome when it fires, independent of the injected now()"

requirements-completed: []

duration: 6min
completed: 2026-11-23
---

# Phase 2 Plan 04: Budget Reservation and ReconProvider Mock Summary

**Credit reservation per submission_key that holds under concurrent workers, with daily and monthly caps proven on real Postgres, plus the `ReconProvider` contract and a scripted mock (900+n quote, real idempotency, every PROC-10 scenario, signed webhooks) that replaces the World Labs provider.**

## Performance

- **Duration:** about 6 min
- **Completed:** 2026-11-23
- **Tasks:** 2 (TDD, RED then GREEN commits each)
- **Files:** 8 touched (2 created, 5 modified, 1 deleted)

## Accomplishments

- `budget.ts` rewritten. A single transaction holds `pg_advisory_xact_lock`. It returns `'already'` when the key already has a reservation, sums the UTC day and UTC month for the given provider mode in one query (the double `AT TIME ZONE 'UTC'` comment is kept), throws `BudgetExceededError` naming the window, and inserts with `ON CONFLICT DO NOTHING`. `releaseCredits(db, key)` is a single `INSERT … SELECT … created_at … ON CONFLICT DO NOTHING`. Its doc comment lists when releasing is allowed (Pitfall 7).
- Real-Postgres test with 8 cases: the daily race and the monthly race each end with exactly one winner, and the loser's error names the window; the same key reserves only once, whether called sequentially or concurrently; a resumed key is not re-checked against a window that is now full; release is idempotent and keeps the reservation's timestamp; releasing yesterday's reservation leaves today's sum unchanged (Pitfall 6); live and mock are kept apart; an unknown key is a no-op.
- `provider/types.ts` follows the contract in the plan exactly. `verifyWebhookSignature` uses `secretEquals` and returns false when the secret or header is missing.
- `provider/mock.ts`: real idempotency (same key and same body gives the same `req_…`; a different body gives 409). It runs the scripted 402/409/429/503/failed scenarios and a Range-read bundle check (206 preflight, PK magic, contiguous `Image_%06d.jpg`, intrinsics `frame_count`, every entry stored, `Exif\0\0` in the first 64 KiB). It has a `mesh-simplified` pending-then-ready export and streams fixture outputs from an allowlist. Webhook deliveries are signed, with duplicate and dropped variants.
- The happy-path bundle check runs in the unit tests against a real bundle packed from `tiny-session`, served through a file-backed Range `fetch` stub.

## Task Commits

1. **Task 1: Atomic daily + monthly reservation**
   - RED `6b95fe4` test(02-04): add failing budget reservation tests (unit + real-Postgres race)
   - GREEN `f879515` feat(02-04): atomic daily + monthly reservation keyed on submission_key
2. **Task 2: ReconProvider contract + scripted mock**
   - RED `30084e9` test(02-04): add failing ReconProvider mock tests; drop World Labs mock test
   - GREEN `e3fae09` feat(02-04): ReconProvider contract and scripted mock provider

## Verification

- `npx tsc --noEmit`: clean
- `npx vitest run`: 31 files passed, 4 skipped (gated); 287 tests passed, 23 skipped
- `node --env-file=.env scripts/test-pg.mjs` (Neon dev, throwaway schemas): 3 files passed, 1 skipped (the R2 test, which is gated); 22 tests passed, including all 8 in `budget.pg.test.ts`
- Acceptance greps: no `budgetFits`/`creditsForModel` in budget.ts. `pg_advisory_xact_lock`, `ON CONFLICT DO NOTHING` and `AT TIME ZONE 'UTC'` (3) are present. No World Labs symbols left in src. `test/mock-provider.test.ts` is deleted. `Phase 6` is in index.ts. No `SPAITIAL_API_KEY` in provider/. `secretEquals` is used in types.ts.

## Deviations from Plan

None. The plan was executed as written. One small addition to the tests: they also cover the bundle check's happy path, packing `tiny-session` locally, alongside the 404 preflight case. The plan left the happy path to 02-05.

## Notes for downstream plans

- Neither PROC-08 nor PROC-10 is marked complete. PROC-10: the mock is the default provider and is unit-tested here; wiring it into the pipeline and the webhook route is 02-05/02-06/02-07. The reservation half is proven here; refusing over-budget scans before spend lands in 02-05/02-07.
- `reserveCredits` now requires `worldId` (string). Every pipeline submit has one.
- The pg connect hook logs a pg deprecation warning ("client.query() when the client is already executing a query"). This was already there (helper pattern) and is harmless.

## Threat Flags

None. Every surface is covered by T-02-16..T-02-21: the advisory lock + unique index, the dated release, the release rules doc, the fail-closed HMAC check, no live path, and the open() allowlist.

## Self-Check: PASSED

- Files: budget.ts, budget.pg.test.ts, provider/{types,mock,index}.ts and test/provider/mock.test.ts exist. test/mock-provider.test.ts is absent.
- Commits 6b95fe4, f879515, 30084e9 and e3fae09 are in `git log`.
