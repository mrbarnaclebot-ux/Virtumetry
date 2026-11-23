---
phase: 02-bundle-pipeline-mock-provider
verified: 2026-11-24T00:40:00Z
status: passed
score: 5/5 roadmap criteria verified; CI-gate gap closed in re-verification
overrides_applied: 0
gaps:
  - truth: "The backend unit suite passes cleanly in CI (Phase 1 SC1 contract, relied on by every Phase 2 'automated tests' criterion)"
    status: failed
    reason: "`npx vitest run` reports 296 passed but exits 1 with 'Errors 1 error' (2 unhandled errors, LeaseLostError and 'boom') from test/bundle/pack.test.ts, the WR-05 test added in the review fix (commit 8abb7be). Reproduced twice (full run and the file alone). .github/workflows/backend.yml runs `npx vitest run`, so the first push will turn CI red."
    artifacts:
      - path: "backend/test/bundle/pack.test.ts"
        issue: "WR-05 test (lines ~134-146) leaks unhandled rejections/exceptions from the pack error path"
      - path: "backend/src/bundle/pack.ts"
        issue: "Possible source: lazy-entry callbacks or zip.outputStream error with no handler once a mid-zip error occurs (lines ~96-116). Needs root-cause check."
    missing:
      - "Find which emitter/promise leaks the error (zip/outputStream/other lazy callbacks) and handle it, or fix the test"
      - "Re-run `npx vitest run` and confirm exit code 0 with 'Errors' absent"
human_verification: []
---

# Phase 2: Bundle Pipeline & Mock Provider Verification Report

**Phase Goal:** The on-disk session format is fixed. A recorded session can be turned by the backend into a valid Echo-3 capture bundle and run end to end through the mock provider to a ready world with re-hosted outputs, without spending a credit.
**Status:** passed (gap closed, see Re-verification)
**Re-verification:** No, initial verification

## Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Fixture session packed into store-only ZIP on R2 with OpenCV poses, intrinsics, monotonic EXIF, Range 206 presigned URL | VERIFIED | `src/bundle/{convert,exif,manifest,validate,pack,zipread}.ts` exist and are substantive. The 30-frame TUM fixture is committed. `pack.test.ts` passes 7/7, including ZIP structure and EXIF checks. `npm run test:r2` Range test passed per the orchestrator, and fixture:e2e reached ready on virtumetry-dev. |
| 2 | pack → submit → track → ready on mock, all outputs copied to our R2 before ready | VERIFIED | `src/pipeline.ts` handlers. `pipeline.pg.test.ts` happy path passed in my own PG run (6 files, 47 passed, 1 skipped). Ready UPDATE is one conditional statement after artifact re-hosting, and also requires `deleted_at IS NULL` (CR-03). |
| 3 | Webhooks HMAC-verified, deduped on delivery_id, nudge only; polling still terminates | VERIFIED | `src/routes/webhooks.ts`: verify before DB, 401 on a bad signature, `ON CONFLICT` dedupe, only `UPDATE jobs SET run_after=now()`. `webhooks.test.ts` and `webhooks.pg.test.ts` pass (duplicate_webhooks, webhook_dropped). |
| 4 | Scripted FAILED/402/409/429/503/duplicate webhooks each end in the documented state with no extra submit | VERIFIED | `scenarios.pg.test.ts` passed in my PG run, including the review-fix cases (CR-01/02, WR-01/02/04). |
| 5 | Concurrent over-cap scans yield exactly one reservation, refused before any provider call | VERIFIED | `src/budget.ts` uses `pg_advisory_xact_lock` plus a unique (key, kind) conflict. The concurrency test is in `scenarios.pg.test.ts` and `budget.pg.test.ts`. Both passed. |

**Score:** 5/5 criteria verified in behavior. The gap below concerns the suite's exit status.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean | PASS |
| Unit suite | `npx vitest run` | 296 passed / 48 skipped, **but "Errors 1 error", exit code 1** (2 unhandled errors in pack.test.ts) | FAIL |
| PG integration (Neon dev) | `node --env-file=.env scripts/test-pg.mjs` | 47 passed / 1 skipped, exit 0 | PASS |
| R2 Range | not re-run; orchestrator reported 1/1 passed | n/a | accepted |

## Requirements Coverage

| Requirement | Plans | Status | Evidence |
|---|---|---|---|
| PROC-04 | 02-01, 02-03, 02-07 | SATISFIED | convert/exif/pack/validate, R2 Range test, fixture:e2e |
| PROC-06 | 02-02, 02-05, 02-06 | SATISFIED | webhook route and polling fallback tests |
| PROC-07 | 02-02, 02-05, 02-07 | SATISFIED | import handler, ready only after re-host |
| PROC-08 | 02-02, 02-04, 02-05, 02-07 | SATISFIED | atomic reservation, concurrency test |
| PROC-10 | 02-04, 02-06, 02-07 | SATISFIED | mock provider with all scenarios, default mode mock |

No orphaned requirements: REQUIREMENTS.md maps exactly PROC-04/06/07/08/10 to Phase 2, and all appear in plan frontmatter.

## Anti-Patterns

No TBD/FIXME/XXX in `backend/src` or `backend/scripts`. Known deferred item (not a gap): WR-02 partial, where the 409/SUBMIT_UNCERTAIN request id is never learned. This is documented as deferred to Phase 6, which owns the live client (Phase 6 covers safe retry).

## Gaps Summary

All five success criteria hold in the code and in the PG integration run. One blocker remains. The review-fix commit 8abb7be added a WR-05 test that leaks unhandled errors, so `npx vitest run` exits 1 although every test is marked passed. The backend CI workflow runs that exact command, so the first push will fail. The orchestrator's "296 passed" figure hides this. The fix is small. Locate the leaking error path (likely other lazy-entry callbacks or the output stream erroring after the first failure), handle it in `pack.ts` or the test, and confirm exit code 0. This is not a design gap.

---

_Verified: 2026-11-24_
_Verifier: Claude (gsd-verifier)_


## Re-verification

**Date:** 2026-11-24 | **Scope:** the single CI-gate gap (`npx vitest run` exit 1).

- **Fix (commit 5edcc30, `backend/src/storage/local.ts`):** `putStream` now does `body.on('error', () => undefined)` before the `mkdir().then(pipeline)` chain. Root cause: an abort before mkdir resolved destroyed the body while no 'error' listener existed, so Node raised an uncaught exception. The no-op listener only suppresses that uncaught emission.
- **Does not mask failures:** `done` is still `mkdir(...).then(() => pipeline(body, createWriteStream(file)))`. `pipeline` rejects on an already-destroyed/errored source, and `abort()` still calls `body.destroy(err)`. Callers still see the rejection via `done`. Behavior is unchanged except that no unhandled event is emitted.
- **Run:** `cd backend && npx tsc --noEmit && npx vitest run` gave tsc clean, 32 files passed / 7 skipped, 296 tests passed / 48 skipped, **exit=0**. A second run counted 0 occurrences of "unhandled" in the output.
- **Result:** gap closed. No remaining gaps; Phase 2 goal achieved.
