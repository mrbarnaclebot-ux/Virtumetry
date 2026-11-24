---
phase: 04-0-capture-to-world-loop
plan: 08
subsystem: app/capture-ui
tags: [review, quote, approval, upload-ui, library, tdd]
requires:
  - "04-04: costFor/formatCost, checkReason/serverReason, PrecheckIssue"
  - "04-05: local scan store (useLocalScan, updateLocalScan, discardLocalScan)"
  - "04-06: scan screen, ReadinessPill"
  - "04-07: createScan, getQuote, kickUploadManager, useUploadProgress"
provides:
  - "src/app/capture/[id].tsx: one route, steps review -> quote -> upload"
  - "display-state: local saved/checks-failed/uploading/paused/blocked/failed/done lines; failure_stage validate -> Didn't pass checks"
  - "pollInterval(items, force) + useWorlds({ forcePoll })"
  - "LibraryRow onOpen for local rows; LocalScan.readinessReason; readiness LABEL export"
affects: [plan 09 end-to-end verification, Library]
tech-stack:
  added: []
  patterns: ["step components mount/unmount with the step so the quote is refetched on every visit", "missing-scan effect doubles as the post-discard close"]
key-files:
  created:
    - virtumetry/src/app/capture/[id].tsx
    - virtumetry/src/__tests__/capture-review.test.tsx
    - virtumetry/src/__tests__/capture-quote.test.tsx
  modified:
    - virtumetry/src/library/display-state.ts
    - virtumetry/src/components/library-row.tsx
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/lib/api.ts
    - virtumetry/src/app/capture/scan.tsx
    - virtumetry/src/capture/readiness.ts
    - virtumetry/src/__tests__/display-state.test.ts
    - virtumetry/src/__tests__/library.test.tsx
    - virtumetry/src/__tests__/capture-scan.test.tsx
decisions:
  - "Local row progress is a 0-100 percent (37.5 for 12/32), matching the row bar, not the 0.375 fraction the plan text mentions"
  - "Approve sets approvedMaxCredits locally before createScan; on create error the scan stays 'saved' and the error copy shows"
  - "Local 'done' row reads 'Uploaded · Processing started' until the server row takes over; local 'failed' uses the Phase 3 failed copy, 'Not charged'"
  - "Discard does not navigate itself: the scan disappearing from the store closes the screen"
metrics:
  duration: "~35 min"
  completed: 2026-11-24
  tasks: 3
  files: 12
---

# Phase 4 Plan 08: Review, quote, explicit approval and upload UI Summary

After Stop the owner lands on `capture/[id]` review (thumbnails, frames, m:ss duration, estimated cost, readiness, device checks), moves to a server quote where only `withinBudget === true` enables "Approve & process", and that single tap creates the server scan with `approved_max_credits`, marks the scan uploading and kicks the upload manager; the upload step then shows percent/files, paused, "Uploaded · Processing started" or "Didn't pass checks · Not charged", and Library rows mirror every local state.

## Tasks

| Task | Name | Commits |
| ---- | ---- | ------- |
| 1 | Library local states, validate-stage mapping, pressable local rows, polling | 7625f2b (RED), a486ca1 (GREEN) |
| 2 | capture/[id] review + quote with explicit approval; Stop opens review | 5171ba9 |
| 3 | Upload step: progress, paused, processing started, blocked not charged | 4480661 |

## Verification

- `npx jest --ci`: 19 suites, 195 tests pass.
- `npx tsc --noEmit` and `npx expo lint`: clean.
- `createScan(` appears once in `[id].tsx` (approve mutation); capture-quote test asserts no `/v1/scans` POST and no kick before the tap, and none when over budget.
- Typed routes: Metro had already regenerated `/capture/[id]`, so no `Href` cast was needed.
- No real Echo-3/R2 calls; all API traffic in tests is a fetch mock.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Duration m:ss rounding** — `mss` rounds seconds first so 59.6 s reads "1:00", not "0:60". Commit 5171ba9.

**2. [Rule 3 - Blocking] Jest did not exit** — React Query gc timers (queries and mutations, 5 min default) kept the worker alive; test clients set `gcTime: Infinity`. Commits 5171ba9, 4480661.

**3. [Rule 3 - Blocking] progressbar not found by role** — the bar View needed `accessible` to be exposed (also correct for VoiceOver). Commit 4480661.

**4. [Rule 2 - Correctness] Older index entries without uploadState** — `toDisplayState` treats a missing `uploadState` as `saved`.

Other: Task 2 committed without a separate RED commit (plan task was not `tdd="true"`); added a library test that local rows push `capture/[id]` with the right step and server rows are not buttons.

## Known Stubs

None.

## Requirements

CAP-06, CAP-09, PROC-01, PROC-02 marked complete (code + tests). PROC-03 stays Pending: background continuation while locked/suspended needs the on-device check.

## Self-Check: PASSED

- Files exist: `[id].tsx`, capture-review/quote tests; commits 7625f2b, a486ca1, 5171ba9, 4480661 in git log.
