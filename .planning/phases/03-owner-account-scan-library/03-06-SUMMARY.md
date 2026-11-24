---
phase: 03-owner-account-scan-library
plan: 06
subsystem: app-library
tags: [expo, react-query, library, display-state, auth]
requires:
  - 03-03 GET /v1/worlds
  - 03-05 authClient, endSession, queryClient, theme tokens
provides:
  - virtumetry/src/library/display-state.ts (LibraryItem, LocalScan, DisplayState, toDisplayState, isTerminal, pollInterval, STALLED_MS)
  - virtumetry/src/lib/api.ts (ApiError, UnauthorizedError, apiFetch, listWorlds, useWorlds)
  - virtumetry/src/library/local-scans.ts (useLocalScans, __setLocalScansForTest)
  - virtumetry/src/components/library-row.tsx (LibraryRow, RowItem)
affects:
  - virtumetry/src/app/(tabs)/index.tsx (real list; openRowMenu is where 03-07 adds Rename/Delete)
  - virtumetry/src/app/_layout.tsx (focusManager wired to AppState)
tech-stack:
  added: []
  patterns:
    - pure display-state mapper as single source of row copy
    - React Query refetchInterval driven by item statuses
    - useSyncExternalStore module store for local scans
key-files:
  created:
    - virtumetry/src/library/display-state.ts
    - virtumetry/src/lib/api.ts
    - virtumetry/src/library/local-scans.ts
    - virtumetry/src/components/library-row.tsx
    - virtumetry/src/__tests__/display-state.test.ts
    - virtumetry/src/__tests__/library.test.tsx
  modified:
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/app/_layout.tsx
decisions:
  - "Library row takes the raw item and calls toDisplayState itself (fresh `now` each poll render); onMore(item, state) hands the menu the display title"
  - "Row accessibility label = [title, status line, secondary line] joined with ', '; the … button sits outside the accessible group so VoiceOver can reach it"
  - "charged is optional in LibraryItem: missing/null → 'Charge unknown'"
  - "Estimate uses eta_seconds (plan) rather than progress-derived minutes (UI-SPEC wording); stall uses heartbeat_at"
metrics:
  duration: 25min
  completed: 2026-11-24
  tasks: 2
  files: 8
---

# Phase 3 Plan 06: Library on real data Summary

Signed-in owner sees their scans from GET /v1/worlds through a tested pure mapper (status line, eta/stalled hint, failure-code family, charge note), with React Query polling every 5 s only while something is in flight and paused in background; 401 ends the session with the notice.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | Pure display-state mapper (TDD) | f403908 (RED), 4be139f (GREEN) |
| 2 | API client, polling, row, library screen (TDD) | 6450712 (RED), b3e9e3d (GREEN) |

## Verification

- `npx jest --ci`: 6 suites, 79 tests pass (display-state 43, library 8)
- `npx expo lint`: exit 0; `npx tsc --noEmit`: exit 0
- Acceptance greps all satisfied; `failure_message` appears only in the type declaration (T-03-28)

## Deviations from Plan

**1. [Rule 3 - Blocking] RNTL 14 has no UNSAFE_* queries**
- Spinner, progress bar use `testID`s (`library-loading`, `row-progress`); the refresh-failed test triggers the refetch via `client.refetchQueries` because the jest host `RCTRefreshControl` exposes no props to fire on. The progress bar is inside the row's accessible group, so `getByRole('progressbar')` cannot see it (correct behaviour; the percent is in the row label).

No other deviations.

## Known Stubs

- `useLocalScans` is empty in practice in Phase 3 by design (D-19); Phase 4 capture adds entries.
- Row action menu has only Cancel; 03-07 adds Rename and Delete to `openRowMenu`.
- `listWorlds` fetches the first 100 only (`ponytail:` comment); paging via `next_offset` when needed.

## TDD Gate Compliance

test → feat commits present for both tasks.

## Self-Check: PASSED
