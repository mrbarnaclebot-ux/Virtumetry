---
phase: 04-0-capture-to-world-loop
plan: 01
subsystem: backend/validation
tags: [validation, capture-config, precheck, tdd]
requires: []
provides:
  - "capture-config.ts: captureConfig(cfg), DEFAULT_CAPTURE_CONFIG, PRICING, ReadinessConfig, PrecheckRules"
  - "validate.ts: rules-driven validateSession + yawSectorCount, forwardMotionMedianDeg, frameYawDeg"
  - "pack.ts: exported readManifest + validateStored (shared by pack and plan 02 :complete)"
affects: [backend/src/pipeline.ts handlePack, test harness config]
tech-stack:
  added: []
  patterns: ["strict partial zod override merged per section over code defaults", "required rules arg so tsc flags every validator caller"]
key-files:
  created:
    - backend/src/capture-config.ts
    - backend/test/capture-config.test.ts
  modified:
    - backend/src/config.ts
    - backend/src/bundle/validate.ts
    - backend/src/bundle/pack.ts
    - backend/src/pipeline.ts
    - backend/test/bundle/validate.test.ts
    - backend/test/bundle/pack.test.ts
    - backend/test/helpers/pipeline.ts
    - backend/test/provider/mock.test.ts
    - backend/test/integration/r2-range.s3.test.ts
decisions:
  - "TRACKING_NOT_NORMAL (per frame) replaced by one share-based TRACKING_GAP; default share 0.0 keeps today's strictness"
  - "INTRINSICS_PRINCIPAL_POINT keeps its code but tightens to the +/-25% centre band; INTRINSICS_ASPECT added for |fx/fy-1| > 0.10"
  - "CAPTURE_CONFIG_JSON errors are a fixed string 'CAPTURE_CONFIG_JSON is invalid' (never echo the value)"
metrics:
  duration: ~25min
  completed: 2026-11-24
  tasks: 3
  files: 11
---

# Phase 4 Plan 01: Server capture gate Summary

Env-tunable capture thresholds (`CAPTURE_CONFIG_JSON`, strict zod partial over production defaults) drive a rules-based backend validator that refuses too few frames, tracking gaps, blur, low yaw coverage, pose jumps, walking backwards and broken intrinsics before any credit is spent; pack and the coming `:complete` share one `validateStored` entry point.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | capture-config.ts + CAPTURE_CONFIG_JSON env | 68aff5f (RED), 580fa20 (GREEN) |
| 2 | Rules-driven validator with D-16 semantic checks | 6b2099f (RED), 625ea61 (GREEN) |
| 3 | validateStored + pack/pipeline/harness threading | 371e4c6 |

## Verification

- `npx tsc --noEmit` clean; tests and src typecheck together too (only pre-existing `scripts/*` dev-guard.mjs declaration errors, out of scope).
- `npx vitest run`: 345 passed, 80 skipped (pg/r2 gated).
- `npm run test:pg -- pipeline/scenarios/webhooks`: 3 files, 24 tests passed under the dev fixture config.
- Broken fixtures each produce exactly their code: reversed poses → `FORWARD_MOTION_MISMATCH`, +0.6 m from frame 15 → `CAMERA_JUMP`, frames 10-17 limited → one `TRACKING_GAP`, 9/30 blurry → `BLUR_SHARE`, minCoverageSectors 2 → `COVERAGE_LOW`, cx 0.8w → `INTRINSICS_PRINCIPAL_POINT`, fy 1.2fx → `INTRINSICS_ASPECT`, 8 frames vs 20 → `FRAME_COUNT_OUT_OF_RANGE`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing single-rule tests cascaded into the new intrinsics band**
- **Found during:** Task 2
- **Issue:** IMAGE_LONG_EDGE / IMAGE_SHORT_EDGE tests resize the session without moving cx/cy, and INTRINSICS_FOCAL_RANGE tests change only fx or fy, so they now also raised `INTRINSICS_PRINCIPAL_POINT` / `INTRINSICS_ASPECT`.
- **Fix:** mutations keep the principal point centred and fx = fy so each test still fails exactly one rule.
- **Files modified:** backend/test/bundle/validate.test.ts
- **Commit:** 625ea61

**2. [Rule 3 - Blocking] Two more packCapture callers needed `rules`**
- **Found during:** Task 3
- **Fix:** test/provider/mock.test.ts and test/integration/r2-range.s3.test.ts pass the dev precheck rules.
- **Commit:** 371e4c6

Also added: `validateStored` FRAME_COUNT_MISMATCH test and a pack test proving the precheck rules apply (COVERAGE_LOW, no bundle written).

## TDD Gate Compliance

RED (`test(04-01)`) commits 68aff5f and 6b2099f precede GREEN (`feat(04-01)`) commits 580fa20 and 625ea61. Task 3 is `type="auto"` (no TDD gate).

## Requirements

PROC-01 and CAP-05 are not marked complete: their app halves (device precheck, readiness meter) come in later Phase 4 plans (02-04, 06, 08, 09 also list them).

## Known Stubs

None.

## Self-Check: PASSED
