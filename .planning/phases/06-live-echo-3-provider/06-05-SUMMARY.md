---
phase: 06-live-echo-3-provider
plan: 05
subsystem: app-library
tags: [library, retry, budget, rntl]
requires: ["06-03: LibraryItem.retryable, WorldsPage.budgetAlert, /world/[id]/retry route"]
provides: ["Library entry points to the retry sheet", "in-app budget-alert banner (D-13)"]
affects: ["virtumetry/src/app/(tabs)/index.tsx", "virtumetry/src/components/library-row.tsx"]
tech-stack:
  added: []
  patterns: ["module-level Set for per-JS-session UI dismissal", "test-only __reset export (matches __setLocalScansForTest)"]
key-files:
  created: []
  modified:
    - virtumetry/src/components/library-row.tsx
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/__tests__/library-actions.test.tsx
    - virtumetry/src/__tests__/library.test.tsx
decisions:
  - "Banner state reset in tests through an exported __resetBudgetBannerForTest instead of jest.isolateModules (plan-checker flagged isolateModules as brittle)"
  - "Banner hidden whenever the list has no rows (items.length === 0), so the empty, error and loading states never show it"
metrics:
  duration: ~15 min
  completed: 2026-11-25
---

# Phase 6 Plan 05: Library Retry Entry Points and Budget Banner Summary

Failed server rows now open `/world/[id]/retry` (the hint depends on `retryable`). The row menu shows "Retry…" first only when `status === 'failed' && retryable === true`. The Library header shows one dismissible budget-alert card when `GET /v1/worlds` returns `budgetAlert`.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Failed row opens retry sheet; Retry… only when retryable | 410f0e6 |
| 2 | Library budget-alert banner | c0eddc1 |

## What changed

- `library-row.tsx`: new `onOpenFailed` prop. Failed server rows get `accessibilityRole="button"` with the hint "Shows the cost to try again" when retryable and "Shows what happened" otherwise. The menu button hint is "Retry, rename or delete" only when retryable. Local rows and the row visuals are unchanged.
- `(tabs)/index.tsx`: `openRetry` calls router.push to `/world/[id]/retry`. Retry… is gated on the server flag (T-06-21). `BudgetBanner` follows UI-SPEC §D: percent is `min(100, floor(spent/budget*100))` with the "all of" copy at 100%. Dismissed and announced windows are tracked in module-level Sets, and `AccessibilityInfo.announceForAccessibility` reads line 1 once per window per session.
- Tests: retryable true/false/missing, ready row, menu order and routing; banner daily/monthly/100%/null, dismissal that survives a refetch while monthly still shows, and empty state with no banner.

## Verification

- `npx jest --ci`: 30 suites, 335 tests pass
- `npx tsc --noEmit`: clean
- `npx expo lint`: clean

## Deviations from Plan

- Used the test-only `__resetBudgetBannerForTest` export instead of `jest.isolateModules`. The orchestrator allowed this, and it follows the existing `__setLocalScansForTest` convention.
- TDD RED commits were not split out. Tests and implementation for each task landed in one feature commit.

## Known Stubs

None.

## Self-Check: PASSED

- Commits 410f0e6 and c0eddc1 exist; all four modified files exist.
