---
phase: 06-live-echo-3-provider
verified: 2026-11-25T00:00:00Z
status: human_needed
score: 4/4 roadmap criteria verified for everything automatable; live halves of SC2 and SC4 and the Expo Go check of SC3 are human-only
overrides_applied: 0
human_verification:
  - test: "First paid Echo-3 run (06-HUMAN-UAT.md paid-run runbook)"
    expected: "One request id, world reaches ready, viewer opens, outputs re-hosted, recorded set replaces the synthetic fixture"
    why_human: "Costs real money (900 + frames credits); owner decision; no agent may set PROVIDER_MODE=live"
  - test: "Expo Go retry flow R1-R6 on iPhone 17 Pro (mock failed / 409 scenarios on Railway dev)"
    expected: "Retryable failed row opens Retry sheet with fresh quote, Approve and retry reaches Ready; 409 shows non-retryable Scan again sheet"
    why_human: "Device UI"
  - test: "Budget banner and [budget-alert] log line on dev (B1-B3)"
    expected: "Banner at 84%, one [budget-alert] + one [push:stub] log line, dismiss per session"
    why_human: "Deployed env and device UI; live alert during a paid run is also manual"
---

# Phase 6: Live Echo-3 Provider Verification Report

**Phase Goal:** With the full mock loop proven, the backend can process an approved scan on real Echo-3 exactly once, inside the budget. The owner can retry a retryable failure only after re-confirming the cost.
**Status:** human_needed (all automatable evidence passes; no gaps found)
**Re-verification:** No, initial verification

## Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | Submission key + exact body persisted before the Echo-3 call; crash mid-submit or concurrent submits never produce a second paid world | VERIFIED | `pipeline.ts` mints `submissionKey` once (isNull guard), persists `submitBody` before send, re-reads the DB body, heartbeats (lease check) before `reserveCredits` and again before `provider.submit`, writes `sending:true` before the send. `echo3-contract.pg.test.ts` (V2 kill mid-submit, V3 concurrent, V4 drop/timeout/429/503/409/401) and `scenarios.pg.test.ts` (V5, mock) pass against fake Echo-3 + real Neon: billed 1, same key and byte-identical body, one reserve row. |
| SC2 | First paid run converts, re-hosts, opens in viewer, recorded as fixtures | PARTIAL: automated half VERIFIED, live half HUMAN | Replay test (V6) passes: recorded set to submit, track, exports, import, ready with splat/collider/floorplan/meta/cameras re-hosted. Manifest is `synthetic: true` (hand-written from docs) and `scripts/record-echo3-run.ts` exists for the owner. Live paid run NOT performed, correctly. |
| SC3 | Failed scan shows Retry only when retryable; retry needs fresh explicit cost approval | VERIFIED for code (RNTL + backend); Expo Go manual pending | `isRetryable` truth table (V7); `POST /v1/worlds/:id/retry` requires approved_max_credits, re-quotes, 400 `approval_below_quote`, 409 `not_retryable`, new key + attempt row, idempotent replay, concurrent one-wins (V8, 20 pg tests). App: `world/[id]/retry.tsx` fetches fresh quote, calls `retryWorld(world.id, credits, key)`, gated on server `retryable`; `library-row.tsx` shows Retry only when `status==='failed' && retryable===true`. |
| SC4 | Owner alerted when spend crosses configured share of daily/monthly budget | VERIFIED for mechanism; live check manual | `budgetAlertFor` pure threshold; `budget_alerts` once-per-window insert inside the advisory-locked reserve tx; post-commit `console.warn('[budget-alert]')` plus non-awaited `deps.push` (push failure non-fatal); `budgetAlert` in `GET /v1/worlds` and `/v1/quote`; Library banner in `(tabs)/index.tsx`. V9 (5 pg tests) pass. Push is the Phase 7 stub (`[push:stub]`). |

## Money-safety checks

- `config.ts`: live boot refused without `ALLOW_PAID_PROVIDER=1`, `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET`, https base URL, `BUNDLE_URL_TTL_SECONDS >= 9000` (lines 207-220). `PROVIDER_MODE` defaults to `mock`.
- `vitest.config.ts` registers `test/setup-no-spaitial.ts` so any test fetch to `*.spaitial.ai` throws.
- No TBD/FIXME/XXX markers in the phase's source files.
- No live mode set anywhere in this verification; no call to `*.spaitial.ai`.
- Review: iteration 3 clean (0 critical, 0 warning, 6 info). Informational items IN-14 (orphaned reserve on an archived key in a rare double-stall; errs safe) and IN-15 (RECONCILE branch is log-only, unreachable by trace) are accepted notes, not blockers.

## Test and tool results (run by this verifier)

| Check | Result |
|-------|--------|
| `backend: npx tsc --noEmit` | exit 0, clean |
| `backend: npx vitest run` | 45 files passed, 15 skipped (pg suites without env); 511 tests passed, 164 skipped, 0 failed |
| `backend: test-pg.mjs echo3-contract + retry + budget-alert` (Neon dev) | 3 files, 38/38 passed (13 + 20 + 5) |
| `virtumetry: npx jest --ci` | 30 suites, 341/341 passed |
| Dev `/healthz` (Railway) | `{"status":"ok"}` |

VALIDATION V1-V14 coverage: V1 `echo3.client.test.ts` (41 `it` blocks, 62 per review incl. each-rows); V2-V4/V6 `echo3-contract.pg.test.ts`; V5 `scenarios.pg.test.ts` (29); V7 `retryable.test.ts` (`it.each` table); V8 `retry.pg.test.ts`; V9 `budget-alert.pg.test.ts`; V10 `library-actions.test.tsx` (15); V11 `world-retry.test.tsx` (9); V12 `library.test.tsx` (18); V13 `config.test.ts` + setup file; V14 `purge-cascade.pg.test.ts` (11). All files exist and the ones run here are green. Not re-run here: scenarios, purge-cascade pg suites (pass per review-fix log; outside the requested run set). `06-VALIDATION.md` frontmatter still says `status: draft` / `nyquist_compliant: false` (bookkeeping only; update on sign-off).

## Requirements Coverage and recommendation

| Requirement | Status | Recommendation |
|-------------|--------|----------------|
| PROC-05 (at most one Echo-3 submit per approved scan; key + exact body saved first; retry needs new approval) | Code and contract tests complete; never exercised against real Echo-3 (the fake server encodes the documented contract, and the replay manifest is synthetic) | Keep **Pending** until the first paid run confirms the contract live (idempotency retention window is also an open question for SpAItial) |
| LIB-02 (retry only when retryable, after re-confirming cost) | Fully delivered in code: server `isRetryable` plus ledger guard, retry route with fresh approval, app sheet and row entry, backend and RNTL tests green | Can be marked Complete once the manual Expo Go check R1-R6 passes (no money required); reasonable to flip after that alone |
| OPS-06 (owner alerted at set share of budget) | Alert mechanism delivered (once per window, log line, banner, `budgetAlert` API). Push is only the Phase 7 stub, so there is no real push alert yet | Keep **Pending** (or Partial) until the Phase 7 push plus the manual live-alert check B1; do not claim a real push delivery |

No orphaned requirements: ROADMAP maps exactly PROC-05, LIB-02, OPS-06 to Phase 6, and all are claimed by plans.

## Human Verification Required

1. **First paid run** (owner decision; runbook in 06-HUMAN-UAT.md). Expect one request id, ready, viewer opens, recorded set written to replace the synthetic manifest.
2. **Expo Go retry flow R1-R6** with `MOCK_SCENARIO=failed` then `happy`, and `409`.
3. **Budget banner B1-B3** and the `[budget-alert]` / `[push:stub]` log lines on Railway dev, and (later) the alert during the live run.

## Gaps Summary

No code gaps or blockers found. Remaining risk is that the live client has only been tested against a fake server built from docs, which is exactly what the human paid run will confirm.

---

_Verified: 2026-11-25_
_Verifier: Claude (gsd-verifier)_
