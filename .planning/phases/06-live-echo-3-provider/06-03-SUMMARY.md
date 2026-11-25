---
phase: 06-live-echo-3-provider
plan: 03
subsystem: app
tags: [retry, approval, quote, idempotency, expo-router]
requires: []
provides:
  - "components/approval.tsx (Layout, Primary, Neutral, StatRow, QuoteCard, overBudget, useAnnounce, styles)"
  - "retryWorld client + BudgetAlert type"
  - "failureGuidance / chargeLine pure functions"
  - "world/[id]/retry modal sheet"
affects: [06-07 (backend retry route), Library row wiring (opens the sheet)]
tech-stack:
  added: []
  patterns: ["shared approval UI module", "one Idempotency-Key per sheet open via uuid.v4 from expo"]
key-files:
  created:
    - virtumetry/src/components/approval.tsx
    - virtumetry/src/app/world/[id]/retry.tsx
    - virtumetry/src/__tests__/world-retry.test.tsx
  modified:
    - virtumetry/src/app/capture/[id].tsx
    - virtumetry/src/lib/api.ts
    - virtumetry/src/library/display-state.ts
    - virtumetry/src/__tests__/display-state.test.ts
    - virtumetry/src/app/world/_layout.tsx
decisions:
  - "The retry sheet's charge line uses chargeLine() ('Not charged for this run'). The Library row keeps its shorter 'Not charged' because the strings differ."
  - "capture/[id].tsx styles = { ...shared approval styles, ...screen-only styles }, so the styles are not forked and no style references changed"
  - "Scan again uses router.replace('/capture/prep')"
  - "A world missing from the cached list falls back to GET /v1/worlds/:id with retry false"
metrics:
  duration: ~25 min
  completed: 2026-11-25
---

# Phase 6 Plan 03: Retry sheet (app side) Summary

A failed scan now opens a modal sheet. If the server marks it `retryable`, the sheet shows a fresh quote and "Approve and retry", sending one Idempotency-Key per sheet open. Otherwise it shows plain guidance and "Scan again". The Phase 4 approval UI is now shared between capture and this sheet instead of being copied.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1. Extract approval components; retryWorld + types; failureGuidance | 0d250c8 | The capture-quote and capture-review tests pass without edits |
| 2. Retry / scan-failed sheet route | d0d7b33 | world-retry.test.tsx has 11 tests covering every behaviour bullet |

## Verification

- `npx expo lint`: clean
- `npx tsc --noEmit`: clean
- `npx jest --ci`: 30 suites, 326 tests passed

## Deviations from Plan

- QuoteCard takes `{ quote, noun }` and computes the over-budget line itself. The capture screen and the sheet both also need that line for the Primary button's accessibility hint, so `overBudget(data, noun)` is exported from approval.tsx.
- `failureText` is now exported from display-state.ts because the sheet uses it for the reason heading. Its behaviour is unchanged.

## Known Stubs

None. Nothing opens the sheet yet: the Library row/menu wiring (UI-SPEC §A) is not in this plan's files. The backend route lands in 06-07, so the tests mock fetch.

## Threat Flags

None. The register's mitigations are all in place: T-06-11 (same Idempotency-Key reused, busy state), T-06-12 (quote gcTime/staleTime 0, refetched on approval_below_quote), T-06-13 (only the server `retryable` is used, and missing means not retryable), T-06-14 (failure_message is never rendered, and a test asserts this).

## Self-Check: PASSED
