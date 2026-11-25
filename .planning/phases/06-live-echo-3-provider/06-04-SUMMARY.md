---
phase: 06-live-echo-3-provider
plan: 04
subsystem: backend/worker (money path)
tags: [budget, alerts, submit, idempotency, import]
requires: [06-01 BUDGET_ALERT_SHARE config, 06-02 budget_alerts table]
provides: [reserveCredits share/onAlert, budgetAlertFor, PROVIDER_AUTH refusal, bounded thumbnail import]
affects: [backend/src/budget.ts, backend/src/pipeline.ts]
tech-stack:
  added: []
  patterns: [alert row inside advisory-locked tx + side effects after commit, ON CONFLICT DO NOTHING RETURNING for once-per-window]
key-files:
  created: [backend/test/integration/budget-alert.pg.test.ts]
  modified: [backend/src/budget.ts, backend/src/pipeline.ts, backend/test/budget.test.ts, backend/test/integration/scenarios.pg.test.ts]
decisions:
  - "Both windows can alert from one reservation (one budget_alerts row each); budgetAlertFor (monthly-first, single result) is the pure helper and is not used by the reserve path"
  - "Refusal after an uncertain attempt is re-coded SUBMIT_UNCERTAIN (non-retryable in retry.ts), provider status+code kept in failure_message"
  - "Thumbnail skip keyed on the existing track consecutive-error counter (errs >= 2 → third pass skips)"
metrics:
  duration: ~25 min
  completed: 2026-11-25
---

# Phase 6 Plan 04: Budget alerts and submit and import hardening Summary

When a reservation pushes spend past `BUDGET_ALERT_SHARE` of a window's budget, one `budget_alerts` row is written per (mode, window, window_start), inside the advisory-locked reserve transaction. The owner gets a `[budget-alert]` warn and a push only after commit, and a failure there can never fail the submit. In `handleSubmit`, every definitive 4xx (except 408, 409 and 429) is now a refusal. A 401 becomes `PROVIDER_AUTH` and the reservation is released. A refusal that follows an uncertain attempt becomes `SUBMIT_UNCERTAIN` and the reservation is kept. A thumbnail that keeps failing is skipped after 3 track passes.

## Tasks

| Task | Commit | What |
|------|--------|------|
| 1 RED | 9ef4fd2 | budgetAlertFor unit tests + budget-alert.pg.test.ts |
| 1 GREEN | 15e417d | budget.ts: alert insert in reserve tx, onAlert after commit (errors swallowed), budgetAlertFor |
| 2 | cac583f | pipeline.ts: refusal classification, PROVIDER_AUTH, SUBMIT_UNCERTAIN re-code, thumbnail bound, onAlert wiring; scenarios tests |

## Verification

- `npx tsc --noEmit`: clean
- `npx vitest run`: 473 passed, 132 skipped (pg-gated)
- `npm run test:pg`: budget-alert (5) + budget (8, file unchanged) passed; scenarios (20) passed; pipeline (7) passed
- Zero SpAItial calls: everything ran against the mock provider, and PROVIDER_MODE and ALLOW_PAID_PROVIDER were never touched.

## Money-path invariants preserved

- Persist-before-spend, the one-time key mint, and "always send what the DB holds" are unchanged.
- A reservation is released only on a refusal with no earlier uncertain attempt. It is still never released on 409, 5xx, timeout or uncertain outcomes.
- The alert insert happens after the reserve insert, under the same `pg_advisory_xact_lock`. The return type stays `'reserved' | 'already'`. A resumed key returns `'already'` before any alert logic runs.
- Alert logs carry only mode, window, numbers and worldId. No key, body or URL.

## Deviations from Plan

None in behaviour. Process note: Task 2's scenario tests were written after the pipeline edit (no separate RED commit for Task 2). The new tests do target the new behaviour: they assert PROVIDER_AUTH, the SUBMIT_UNCERTAIN re-code and the thumbnail skip, which the old code did not produce.

## TDD Gate Compliance

Task 1: test commit 9ef4fd2 comes before feat commit 15e417d. Task 2: a single feat commit (see the note above).

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: backend/test/integration/budget-alert.pg.test.ts
- FOUND commits: 9ef4fd2, 15e417d, cac583f
