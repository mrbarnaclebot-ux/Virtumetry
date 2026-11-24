---
phase: 04-0-capture-to-world-loop
plan: 04
subsystem: app/capture-logic
tags: [capture, readiness, cost, coverage, precheck, tdd]
requires:
  - "04-01: backend capture-config.ts defaults, validate.ts rules (BLUR_PX_THRESHOLD, YAW_SECTORS, MIN_HORIZONTAL_FORWARD)"
provides:
  - "src/capture/types.ts: CaptureSource, KeyframeEvent/PoseEvent/TrackingEvent/ThermalEvent, Session, FrameLine"
  - "src/capture/capture-config.ts: CaptureConfig types, DEFAULT_CAPTURE_CONFIG, getCaptureConfig, useCaptureConfig"
  - "src/capture/cost.ts: costFor, formatUsd, formatCredits, formatCost"
  - "src/capture/readiness.ts: readiness(frames, sectorsSeen, cfg)"
  - "src/capture/coverage.ts: yawDeg, sectorOf, sectorScreenDeg, coverage, fitToBox"
  - "src/capture/precheck.ts: precheck, checkReason, serverReason"
affects: [scan screen, review step, quote step, upload step (plans 05-09)]
tech-stack:
  added: []
  patterns: ["pure capture modules mirrored from backend, pinned by a test that reads backend source text"]
key-files:
  created:
    - virtumetry/src/capture/types.ts
    - virtumetry/src/capture/rules.ts
    - virtumetry/src/capture/capture-config.ts
    - virtumetry/src/capture/cost.ts
    - virtumetry/src/capture/readiness.ts
    - virtumetry/src/capture/coverage.ts
    - virtumetry/src/capture/precheck.ts
    - virtumetry/src/__tests__/capture-cost.test.ts
    - virtumetry/src/__tests__/capture-readiness.test.ts
    - virtumetry/src/__tests__/capture-coverage.test.ts
    - virtumetry/src/__tests__/capture-precheck.test.ts
  modified: []
decisions:
  - "Readiness frames reason counts toward minFramesGreen (amber still says 'Keep going — n more frames')"
  - "serverReason maps FRAME_COUNT_OUT_OF_RANGE and COVERAGE_LOW (no numbers from the server) to the fallback copy; the device precheck shows the numbered copy at review"
  - "sectorScreenDeg(k) = (360 - 30k) % 360: yaw grows counter-clockwise in the top-down view, so the mini-map ring must draw sector k at that clockwise-from-up angle"
metrics:
  duration: ~15min
  completed: 2026-11-24
  tasks: 2
  files: 11
---

# Phase 4 Plan 04: Capture HUD logic Summary

Pure, config-driven capture logic: a CaptureSource contract, readiness (worst of tracking/blur/frames/coverage with one UI-SPEC reason), "$9.30 · 930 credits" cost, a top-down coverage mini-map model using the backend's exact yaw/sector formula, and a device precheck whose constants and defaults are pinned to the backend source by a test.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Capture types, config defaults, cost and readiness | f6b1489 (RED), 89f14e6 (GREEN) |
| 2 | Coverage math, device precheck, backend rule pinning | 12be3de (RED), 2e6a33c (GREEN) |

## Verification

- RED: both test pairs failed on missing modules before implementation.
- `npx jest --ci` (all app suites): 11 suites, 127 tests passed; the four plan files: 26 passed.
- Fixture: `coverage()` gives seenCount 1, raw span >= 2 m, first heading (0, -1); precheck on the fixture with dev rules is `[]`.
- Pin test: `BLUR_PX_THRESHOLD = 64`, `YAW_SECTORS = 12`, `MIN_HORIZONTAL_FORWARD = 0.3` and every readiness/precheck/pricing default found in the backend files with equal values.
- `npx expo lint` clean. `npx tsc --noEmit`: only a pre-existing typed-routes error in `src/components/app-tabs.web.tsx` (logged in deferred-items.md).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Node types for the fs-reading tests**
- **Found during:** Task 2
- **Issue:** tsconfig `types: ["jest"]` excludes Node, so `fs`, `path` and `__dirname` failed tsc.
- **Fix:** `/// <reference types="node" />` in the two test files (`@types/node` is already in node_modules; no new package).
- **Commit:** 2e6a33c

**2. [Rule 2 - Correctness] `sectorScreenDeg` helper + test**
- Yaw increases counter-clockwise in the top-down view; without the helper the UI plan would likely draw the ring mirrored. One-line export, tested.

## TDD Gate Compliance

`test(04-04)` f6b1489 precedes `feat(04-04)` 89f14e6; `test(04-04)` 12be3de precedes `feat(04-04)` 2e6a33c.

## Requirements

CAP-05, CAP-06, CAP-07, PROC-01, CAP-10 not marked complete: the screens and fixture source that use this logic land in later Phase 4 plans.

## Known Stubs

None.

## Self-Check: PASSED
