---
phase: 04-0-capture-to-world-loop
verified: 2026-11-24T21:30:00Z
status: passed
score: 5/5 roadmap success criteria verified in code and automated tests (on-device checks pending)
overrides_applied: 0
human_verification:
  - test: "04-HUMAN-UAT.md steps 1-11 in Expo Go on iPhone 17 Pro against Railway dev (prep, live HUD, review, blocked scans, quote/approve, ready, force-quit resume, discard)"
    expected: "Each step's Expected column in 04-HUMAN-UAT.md"
    why_human: "On-device UI and a live Railway dev backend cannot be exercised here"
  - test: "Run the backend pg suites (scans-e2e, pipeline, scenarios, budget) against a local Postgres"
    expected: "Green. They were skipped in this run: 12 vitest files / 93 tests skipped, no DB available"
    why_human: "The automated end-to-end 'approve -> ready via mock' test (SC4) lives in the pg suites, which need a database"
  - test: "Upload continuation while the phone is locked, suspended or terminated by iOS (PROC-03 first half)"
    expected: "Upload continues in the background"
    why_human: "Observational only in Expo Go (research Pitfall 6). Real verification is in Phase 8 with the dev build"
---

# Phase 4: $0 Capture-to-World Loop Verification Report

**Phase Goal:** In Expo Go, the owner can run the full capture loop with a fixture capture source at zero cost, from prep to ready. The same interface will later be fed by the native module.
**Status:** human_needed
**Re-verification:** No, initial verification

## Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Prep checklist and priming, fixture replay, readiness meter, cost meter and mini-map | VERIFIED (code and tests) | `virtumetry/src/app/capture/{prep,scan}.tsx` and `virtumetry/src/capture/{readiness,cost,coverage,fixture-source,source,capture-config}.ts`. Jest suites: capture-readiness, -cost, -coverage, -fixture-source, -prep, -scan. Thresholds come from the backend `CAPTURE_CONFIG_JSON` via `GET /v1/capture/config`, so they can be tuned without an app build. |
| 2 | Scan saved on the phone first, review shows frames, duration, cost and readiness, then upload or discard | VERIFIED | `virtumetry/src/capture/store.ts` (persisted index), `virtumetry/src/app/capture/[id].tsx`. Jest: capture-store, capture-review. |
| 3 | Failing scans are blocked before any credit is spent, with the reason shown | VERIFIED | App side: `precheck.ts` and `rules.ts`. A test pins the app rules against the backend source. Backend side: `validateStored` in `backend/src/bundle/pack.ts`, called from `backend/src/routes/scans.ts` (`:complete`). Backend rejection (CAMERA_JUMP, forward/motion, intrinsics) is covered by the bundle tests. Fail at stage `validate` with `charged=false`. |
| 4 | Processing starts only after explicit quote approval, then reaches ready via the mock | VERIFIED in code; the e2e test was not run here | `[id].tsx` enables Approve only when `data?.withinBudget === true` (server-computed). `POST /v1/scans` rejects `approved_max_credits` below the quote (400 `approval_below_quote`). `scans-e2e.pg.test.ts` and `pipeline.pg.test.ts` cover the mock run, but pg suites were skipped here (no DB). See human item 2. |
| 5 | After a force-quit, ask the server what is missing, re-send only those, manifest last | VERIFIED | `virtumetry/src/upload/reconcile.ts` calls `getMissing`, uploads the missing frames, then `frames.jsonl` and `session.json` last, then `completeScan`. `manager.ts` is started from `_layout.tsx` (`startUploadManager`). Jest: upload-reconcile and upload-manager. |

**Score:** 5/5. SC4 relies on pg suites that were not run in this environment.

## Behavioral Spot-Checks

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| App jest | `cd virtumetry && npx jest --ci` | 19 suites, 195 tests passed | PASS |
| App typecheck | `npx tsc --noEmit` | clean | PASS |
| Backend typecheck | `cd backend && npx tsc --noEmit` | clean | PASS |
| Backend vitest | `npx vitest run` | 37 files, 343 tests passed; 12 files and 93 tests skipped (pg, no DB) | PASS (partial) |

## Requirements Coverage

All 9 IDs appear in PLAN frontmatter and in REQUIREMENTS.md. No orphans.

| Req | Plans | Status | Evidence |
|-----|-------|--------|----------|
| CAP-01 | 06, 09 | SATISFIED | `prep.tsx`, `prep-flags.ts`, capture-prep test |
| CAP-05 | 01, 03, 04, 06, 09 | SATISFIED | `readiness.ts`, remote config route |
| CAP-06 | 03, 04, 06, 08 | SATISFIED | `cost.ts`, shows "$9.30 · 930 credits" |
| CAP-07 | 04, 06 | SATISFIED | `coverage.ts` and the SVG mini-map in `scan.tsx` |
| CAP-09 | 05, 06, 08 | SATISFIED | `store.ts` and the review screen |
| CAP-10 | 04, 05, 06 | SATISFIED | `fixture-source.ts`, `source.ts`, `getCaptureSource()` |
| PROC-01 | 01, 02, 04, 08 | SATISFIED | `precheck.ts` and backend `validateStored` |
| PROC-02 | 02, 03, 07, 08 | SATISFIED | `GET /v1/quote`, `approved_max_credits`, approve gating |
| PROC-03 | 02, 07, 08, 09 | PARTIAL, correctly left Pending in REQUIREMENTS.md | The force-quit resume half is implemented and unit tested. The "continues while locked, suspended or terminated" half needs a device (Phase 8). Not a Phase 4 gap. |

## Anti-Patterns

No TBD, FIXME or XXX markers in `virtumetry/src` or `backend/src`. No stubs found in the files checked (these are substantive and wired). The upload manager is started from the root layout.

## Human Verification Required

1. **04-HUMAN-UAT.md steps 1-11.** Expo Go on iPhone against Railway dev. The orchestrator must first apply the Railway env vars listed in 04-HUMAN-UAT.md (`CAPTURE_CONFIG_JSON` and the budget variables).
2. **Run the pg suites locally** (`scans-e2e`, `pipeline`, `scenarios`, `budget`). They were skipped in this run.
3. **Background upload continuation.** Observational in Expo Go, verified properly in Phase 8.

## Gaps Summary

No blocking gaps. Every roadmap success criterion has implementation and automated coverage. The remaining items need a device or a database. PROC-03 stays Pending by design until the Phase 8 device verification.

---

_Verified: 2026-11-24_
_Verifier: Claude (gsd-verifier)_
