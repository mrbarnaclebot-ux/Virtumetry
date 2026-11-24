---
phase: 05-viewer-floor-plan-measure-share
plan: 06
subsystem: app-share
tags: [share, react-query, expo-router, modal, rntl]
requires: ["05-04 owner share API", "05-05 viewer screen"]
provides: ["useShares/useCreateShare/useRevokeShare/openCountLabel", "world/[id]/share modal", "viewer Share button"]
affects: [virtumetry/src/app/world]
tech-stack:
  added: []
  patterns: ["optimistic remove + rollback (as useDeleteWorld)", "mutation gcTime 0 + reset() to keep secrets out of the cache"]
key-files:
  created:
    - virtumetry/src/lib/shares.ts
    - virtumetry/src/app/world/[id]/share.tsx
    - virtumetry/src/__tests__/share-sheet.test.tsx
  modified:
    - virtumetry/src/app/world/_layout.tsx
    - virtumetry/src/app/world/[id]/index.tsx
    - virtumetry/src/__tests__/world-screen.test.tsx
decisions:
  - "Create-share mutation uses gcTime 0 and reset() after success so the password variable leaves the react-query cache at once (T-05-26)"
  - "Revoke treats 404 share_not_found as already revoked (mirrors useDeleteWorld); errors show inline, not as an Alert"
  - "Revoke text button is visually 'Revoke' with accessibilityLabel 'Revoke link' (UI-SPEC accessibility table)"
metrics:
  duration: ~25 min
  completed: 2026-11-24
  tasks: 2
  files: 6
---

# Phase 5 Plan 06: Owner share sheet Summary

The viewer's top bar now has a Share button for ready rooms. It opens a page-sheet modal where the owner can create links (with an optional 4-64 character password), send them through `Share.share`, see open counts, and revoke links. Revoke is optimistic and rolls back on failure.

## What was built

- `src/lib/shares.ts`: `Share` type plus `listShares`, `createShare` and `revokeShare`, all through `apiFetch` (no `/v1/public`). Also:
  - `useShares`: refetches on every mount, never polls, and filters out revoked links.
  - `useCreateShare`: puts the new link at the top of the cache, then invalidates.
  - `useRevokeShare`: optimistic filter, snapshot rollback, invalidate on settle.
  - `openCountLabel`.
- `src/app/world/[id]/share.tsx`: follows UI-SPEC §D/§E for title, Done, password card, helper and error lines, the Create link button with its pending state, the Links list (lock icon, middle ellipsis, Share link button, Revoke), pull-to-refresh, and the loading, empty and error states. `Share.share` only ever gets `{ url, message: url }`.
- `world/_layout.tsx`: `[id]/share` registered with `presentation: 'modal'`.
- `world/[id]/index.tsx`: a 44x44 `square.and.arrow.up` "Share this room" button, shown only when `status === 'ready'`. It pushes `{ pathname: '/world/[id]/share', params: { id } }`. When Share is hidden, the title keeps its 44 px right pad so it stays balanced against Back.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | af2932b | test(05-06): add failing share-sheet tests |
| 1 GREEN | 2e0a2ab | feat(05-06): share sheet with create, password, counts and optimistic revoke |
| 2 RED | 2e4a0c5 | test(05-06): add failing Share button tests for the viewer top bar |
| 2 GREEN | 4610baa | feat(05-06): Share button in the viewer top bar for ready rooms |

## Verification

- `npx expo lint`: clean. `npx tsc --noEmit`: clean.
- `npx jest --ci`: 29 suites and 284 tests pass. That includes 12 share-sheet tests and 5 new world-screen cases: ready → push, and no Share while loading, on 404, on error or when not ready.

## TDD Gate Compliance

Both tasks have a `test(...)` commit followed by a `feat(...)` commit. In Task 2's RED run, the 4 "hidden" cases passed because the button did not exist yet. Only the ready → push case failed, which is expected for an absence assertion.

## Deviations from Plan

**1. [Rule 2 - Security] Password kept out of the react-query cache.** `useCreateShare` sets `gcTime: 0`, and the screen calls `create.reset()` after success, so the mutation and its `password` variable are dropped straight away (T-05-26). Files: `src/lib/shares.ts`, `share.tsx`. Commit 2e0a2ab.

**2. [Rule 1 - Bug] Revoke on an already-revoked link.** A 404 `share_not_found` counts as success, so a stale row doesn't come back with a misleading "It still works" error. Commit 2e0a2ab.

No other deviations.

## Known Stubs

None.

## Self-Check: PASSED

- Files exist: shares.ts, share.tsx, share-sheet.test.tsx, the modified _layout.tsx, index.tsx and world-screen.test.tsx.
- Commits af2932b, 2e0a2ab, 2e4a0c5 and 4610baa are in `git log`.
