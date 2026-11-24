---
phase: 03-owner-account-scan-library
plan: 07
subsystem: app-library
tags: [expo, react-query, optimistic-update, modal, library]
requires:
  - 03-03 PATCH /v1/worlds/:id
  - 03-04 DELETE /v1/worlds/:id cascade
  - 03-06 apiFetch, useWorlds, useLocalScans, LibraryRow onMore
provides:
  - virtumetry/src/lib/api.ts (renameWorld, useRenameWorld, deleteWorld, useDeleteWorld)
  - virtumetry/src/components/rename-modal.tsx (RenameModal)
affects:
  - virtumetry/src/app/(tabs)/index.tsx (row menu Rename / Delete / Cancel, delete confirmation)
tech-stack:
  added: []
  patterns:
    - React Query optimistic mutation (onMutate snapshot, onError restore, onSettled invalidate)
    - modal mounted with key={id}; unmount = close, so state resets per scan
key-files:
  created:
    - virtumetry/src/components/rename-modal.tsx
    - virtumetry/src/__tests__/library-actions.test.tsx
  modified:
    - virtumetry/src/lib/api.ts
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/__tests__/library.test.tsx
decisions:
  - "Rename prefill and the unchanged check use the row's displayTitle; the trimmed value is sent"
  - "RenameModal is mounted only while renaming (key=id) instead of toggling visible; no reset logic needed"
  - "The Couldn't delete alert lives in useDeleteWorld.onError, so every caller gets the rollback copy"
  - "Local saved_on_phone rows get Delete + Cancel only (no server id to rename)"
metrics:
  duration: 30min
  completed: 2026-11-24
  tasks: 2
  files: 5
---

# Phase 3 Plan 07: Rename and delete scans Summary

The row menu now has Rename, which opens a cross-platform RN Modal and sends PATCH. The row shows the title the server returns, so rename is not optimistic. Delete asks for a confirmation that names the scan and states it can't be undone. The row then disappears at once, and on any error it comes back at its original index with the "Couldn't delete" alert. A saved-on-phone scan is deleted from the local store only.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | Rename from the row menu (TDD) | 573e24b (RED), ff032c7 (GREEN) |
| 2 | Optimistic delete with honest rollback (TDD) | 4ac2b28 (RED), e390307 (GREEN) |

## Verification

- `npx jest --ci`: 7 suites, 92 tests pass (library-actions: 13; 7 rename, 6 delete)
- `npx expo lint`: exit 0; `npx tsc --noEmit`: exit 0
- Acceptance greps: Alert.prompt 0, maxLength={80} 1, method: 'PATCH' 1, method: 'DELETE' 1, onMutate 1, server delete copy 1

## Deviations from Plan

**1. [Rule 1 - Bug] Stale 03-06 menu assertion**
- `library.test.tsx` asserted the Cancel-only stub menu. Updated it to Rename / Delete / Cancel. Commit e390307.

No other deviations.

## Known Stubs

None. Local saved_on_phone rename is intentionally absent (plan).

## Threat Flags

None. T-03-33..35 mitigated as planned: maxLength 80 + trim, explicit destructive confirmation, rollback + alert + invalidate.

## TDD Gate Compliance

test → feat commits present for both tasks.

## Self-Check: PASSED
