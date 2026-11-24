---
phase: 04-0-capture-to-world-loop
plan: 03
subsystem: backend/quote-config
tags: [quote, budget, capture-config, pricing, cleanup]
requires:
  - "04-01: captureConfig, PRICING"
  - "04-02: scansRoutes, RouteDeps.provider"
provides:
  - "GET /v1/quote?frames=N -> { credits, usd, budgetRemaining, budgetWindow, withinBudget }"
  - "GET /v1/capture/config -> { readiness, precheck, pricing, limits }"
  - "budget.ts spentCredits(db, mode) shared by reserveCredits and /v1/quote"
affects: [app quote/approval screen and readiness/cost meters (later Phase 4 plans)]
tech-stack:
  added: []
  patterns: ["read-only budget preview reuses the exact reservation window SQL"]
key-files:
  created:
    - backend/test/scans.quote.test.ts
  modified:
    - backend/src/budget.ts
    - backend/src/routes/scans.ts
    - backend/src/routes/worlds.ts
    - backend/test/worlds.idempotency.test.ts
    - backend/test/quota.charge.test.ts
    - backend/test/upload-size.test.ts
    - backend/test/zod-contract.test.ts
  deleted:
    - backend/test/frames-done.test.ts
    - backend/test/worlds.uploads-refresh.test.ts
decisions:
  - "budgetWindow is 'monthly' only when the monthly remainder is strictly smaller; ties report 'daily'"
  - "quote frames are validated against provider.limits().maxFrames (1..5000 on mock); anything else is 400 invalid_query"
metrics:
  duration: ~10min
  completed: 2026-11-24
  tasks: 2
  files: 10
---

# Phase 4 Plan 03: Server quote and capture tuning Summary

The app can now ask the server what a scan of N frames costs and whether today's and this month's mock budget can cover it (computed only server-side, no reservation), and fetch the env-tuned readiness/precheck thresholds plus display pricing and frame limits; the old `.heic` create / uploads:refresh / frames:done routes are gone, so `/v1/scans` is the only upload path.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 (RED) | Failing quote + capture config tests | 20d9f7f |
| 1 (GREEN) | GET /v1/quote, GET /v1/capture/config, spentCredits | 02b8cec |
| 2 | Remove old upload routes, migrate tests | f451d2d |

## Verification

- RED: 13/13 quote tests failed (404) before the routes existed.
- `npx tsc --noEmit` clean; `npx vitest run` 35 files, 339 passed, 92 skipped (pg/r2 gated).
- `npm run test:pg`: budget.pg 8/8; ownership, scans, scans-e2e, quota 26/26.
- Quote: frames=30 empty ledger -> `{930, 9.3, 10000, 'daily', true}`; day 9500 -> 500/daily/false; month 99500 -> 500/monthly/false; floored at 0; frames 0/abc/5001/1.5/missing -> 400 invalid_query; no auth -> 401. Exactly one `execute` per quote (no ledger write).
- Config: dev JSON -> minFramesGreen 25, precheck.minFrames 20, limits {20, 5000}, pricing {900,1,0.01}; defaults -> minFrames 50.

## Deviations from Plan

**1. [Plan adjustment] Two idempotency cases changed with the contract**
- "without the header behaves as before" became "400 missing_idempotency_key, no charge" (POST /v1/scans requires the key).
- "409 idempotency_key_incomplete_world" dropped: scan replay returns only the world (presigning is a separate call), so the case no longer exists. Added "approval below quote -> 400 before any charge" instead.

**2. [Cleanup] Unused imports and `config` destructure removed from worlds.ts** after the route deletion. Storage-level cases in upload-size.test.ts switched from `.heic` keys to `frames/NNNNNN.jpg`.

Stale `frames:done` mentions remain in comments in worker.ts, queue.ts, schema.ts, storage/index.ts (out of scope, no behaviour).

## TDD Gate Compliance

`test(04-03)` 20d9f7f precedes `feat(04-03)` 02b8cec.

## Requirements

PROC-02, CAP-05, CAP-06 not marked complete: their app halves (quote/approval screen, remote tuning consumption, cost meter) land in later Phase 4 plans.

## Known Stubs

None.

## Self-Check: PASSED
