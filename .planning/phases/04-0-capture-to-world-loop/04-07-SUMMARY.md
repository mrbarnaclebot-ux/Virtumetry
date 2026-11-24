---
phase: 04-0-capture-to-world-loop
plan: 07
subsystem: app/upload
tags: [upload, reconcile, expo-file-system, appstate, tdd]
requires:
  - "04-02/04-03: POST /v1/scans (Idempotency-Key), /uploads, /uploads:missing, :complete, /v1/quote"
  - "04-05: capture store (getLocalScans, getLocalScan, updateLocalScan), LocalScan"
  - "04-06: scan screen saves LocalScan with dir/frameCount/imageW/imageH"
provides:
  - "src/lib/api.ts: createScan, presignUploads, getMissing, completeScan (409 -> { incomplete: true }), getQuote + ScanWorld/MissingReport/PresignedPut/Quote types"
  - "src/upload/reconcile.ts: pure reconcile(scan, { api, uploader, local, batchSize }, onProgress)"
  - "src/upload/uploader.ts: File.upload PUT adapter returning HTTP status, session path allowlist"
  - "src/upload/manager.ts: startUploadManager / stopUploadManager / kickUploadManager / useUploadProgress"
affects: [plan 08 approval flow (sets uploadState 'approved' + approvedMaxCredits, may kick the manager), Library rows]
tech-stack:
  added: []
  patterns: ["server missing report is the only upload truth", "whole presign batch handed to the native session via Promise.allSettled", "in-flight guard + single follow-up pass"]
key-files:
  created:
    - virtumetry/src/upload/reconcile.ts
    - virtumetry/src/upload/uploader.ts
    - virtumetry/src/upload/manager.ts
    - virtumetry/src/__tests__/upload-reconcile.test.ts
    - virtumetry/src/__tests__/upload-manager.test.ts
  modified:
    - virtumetry/src/lib/api.ts
    - virtumetry/src/app/_layout.tsx
decisions:
  - "Advanced status: delete local files BEFORE marking 'done', so a failed delete is retried on the next pass instead of leaking files"
  - "A failing presign batch ends the pass (incomplete, or paused when every failure was a thrown network error); the next pass re-presigns from the missing report"
  - "Server 'cancelled' maps to local 'failed' (files kept)"
  - "uploader.size throws for a missing session file rather than presigning 0 bytes"
  - "Progress throttle drops intermediate events inside 500 ms but always emits completion (no trailing timer)"
metrics:
  duration: "~25 min"
  completed: 2026-11-24
  tasks: 2
  files: 7
---

# Phase 4 Plan 07: Server-reconciled resumable upload Summary

Approved scans upload from an app-scoped manager that, on launch, foreground and kick, asks `uploads:missing`, presigns only the missing frames in batches of up to 200, hands each batch to expo-file-system background `File.upload` PUTs at once, counts only 2xx, sends `frames.jsonl` then `session.json` last and calls `:complete` exactly once.

## Tasks

| Task | Name | Commits |
| ---- | ---- | ------- |
| 1 | Scan API calls + pure reconciler with force-quit simulation | 9da17cf (RED), 8e65c65 (GREEN) |
| 2 | expo-file-system uploader + app-scoped manager from the root layout | e3a17c9 (RED), 6fb3713 (GREEN) |

## Verification

- `npx jest --ci`: 17 suites, 171 tests pass (14 reconcile, 6 manager).
- `npx tsc --noEmit` and `npx expo lint`: clean.
- Force-quit case: 15 of 30 frames on the server, fresh run presigns exactly frames 16-30, manifest after all frames (session.json last), complete once; a second run after `packing` uploads nothing and does not complete again.
- No real Echo-3/R2 calls; nothing here spends.

## Deviations from Plan

None in behaviour. Minor: `sessionType` left at its default (background); not yet exercised on device in Expo Go (Pitfall 6 fallback to `'foreground'` is a one-line change in `uploader.ts` if needed).

## Known Stubs

None. Nothing sets `uploadState: 'approved'` yet; the review/approval screen (plan 08) does that, after which the manager picks the scan up on its next pass (or via `kickUploadManager()`).

## TDD Gate Compliance

RED commits 9da17cf / e3a17c9 precede GREEN commits 8e65c65 / 6fb3713. No refactor commit needed.

## Requirements

PROC-02 and PROC-03 left Pending in REQUIREMENTS.md: approval UI lands in plan 08, and background continuation while locked/suspended still needs an on-device check.

## Self-Check: PASSED

- Files exist: reconcile.ts, uploader.ts, manager.ts, both tests, api.ts and _layout.tsx changes.
- Commits 9da17cf, 8e65c65, e3a17c9, 6fb3713 present in git log.
