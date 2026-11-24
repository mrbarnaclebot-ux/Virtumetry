---
phase: 05-viewer-floor-plan-measure-share
plan: 03
subsystem: app-viewer
tags: [viewer, walk, collision, measure, three-mesh-bvh, dom-component]
requires: ["05-02"]
provides:
  - "src/viewer/walk.ts: CAPSULE_RADIUS, WALK_SPEED, MAX_DT, floorYAt(bvh, x, z, fromY?), resolveCapsule, stepWalk"
  - "src/viewer/measure.ts: distance, formatDistance, announceDistance, isTap"
  - "engine: loadCollider(buf, bounds?), hasCollider, setWalkInput, look, measureTap, projectToScreen, onFrame"
  - "WorldViewer: live Walk/Measure modes, D-10 disabled state"
affects: [05-05, 05-06, 05-08]
tech-stack:
  added: []
  patterns:
    - "Collider mesh kept out of the scene; BVH raycast/shapecast only"
    - "DOM overlays re-projected through engine.onFrame, written to refs (no per-frame React render)"
key-files:
  created:
    - virtumetry/src/viewer/walk.ts
    - virtumetry/src/viewer/measure.ts
    - virtumetry/src/__tests__/viewer-walk.test.ts
    - virtumetry/src/__tests__/viewer-measure.test.ts
  modified:
    - virtumetry/src/viewer/engine.ts
    - virtumetry/src/viewer/world-viewer.tsx
    - virtumetry/package.json
decisions:
  - "Walk floor height is computed once on entering Walk (downward ray from the camera if it is inside the collider box, else from lowest point + 1.6 m), so ceilings are not mistaken for the floor; no stairs/step-up"
  - "If the camera has orbited outside the room (no floor under it), Walk starts at the start pose's xz"
  - "OrbitControls.update is skipped in Walk mode (it would re-aim the camera); leaving Walk re-targets orbit 2 m ahead, no jump"
  - "Measure 'Tap a point to start' hint is shown every time Measure is entered (it is a step guide), Walk hint only the first time"
  - "Collider PLY without faces (no index) is treated as no collider"
metrics:
  duration: "~30 min"
  completed: 2026-11-24
  tasks: 2
  files: 7
---

# Phase 5 Plan 03: Walk and measure Summary

Walk mode moves a 0.25 m capsule at 1.6 m eye height through the room. A three-mesh-bvh shapecast pushes it out of walls horizontally only, so it slides along walls and the floor never pushes it. Measure mode raycasts two taps against the collider BVH and shows "≈ 2.41 m (approx.)". Worlds without a collider keep both modes disabled and show the D-10 hint.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | walk.ts + measure.ts with jest tests (TDD) | 58b903d (RED), da27bb5 (GREEN) |
| 2 | Collider loading, Walk and Measure modes in engine + WorldViewer | 90e7e24 |

## Verification

- `npx jest --ci`: 25 suites, 237 tests pass, including viewer-walk (5) and viewer-measure (3).
- `npx tsc --noEmit` and `npx expo lint` are clean.
- Acceptance greps pass: `shapecast` is in walk.ts, and walk.ts has no Spark or `three/addons` imports. engine.ts has `computeBoundsTree`, `acceleratedRaycast` and `firstHitOnly`, and does not call `scene.add(collider`. world-viewer.tsx has "doesn't have it" and "Tap a second point".
- Still to do on device (05-08 UAT): walk into a demo-room wall and the table, and measure the table edge (about 1.00 m).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] jest could not load three (ESM)**
- **Fix:** Added `|three|three-mesh-bvh` to the negative group in `transformIgnorePatterns`. The plan allowed this. Commit 58b903d.

**2. [Rule 1 - Bug] A downward ray from the scene top would hit the ceiling first**
- **Fix:** `floorYAt` takes an optional `fromY`. The engine casts from the camera when it is inside the collider box, and otherwise from the lowest point + 1.6 m. The plain "from top" default stays for tests and open meshes.

**3. [Rule 3] `computeBoundsTree()` is typed as GeometryBVH**
- **Fix:** Cast to `MeshBVH`. At runtime the default `options.type` is MeshBVH.

### Notes
- `engine.setMode` ignores walk/measure while there is no BVH. The UI guards this too.
- Touch and mouse use one look sensitivity, 0.005 rad/px (`ponytail:` comment). Tune it on device.

## Known Stubs

None. The 05-02 Walk/Measure placeholder shells are replaced.

## Threat Flags

None. T-05-08: collider parse/fetch sits in its own try/catch and falls back to orbit-only. T-05-09: WASD is ignored when the event target is an input, textarea, select or contentEditable.

## TDD Gate Compliance

Task 1: `test(05-03)` 58b903d, then `feat(05-03)` da27bb5.

## Self-Check: PASSED

- walk.ts, measure.ts and both test files exist. engine.ts and world-viewer.tsx are modified.
- Commits 58b903d, da27bb5 and 90e7e24 are in `git log`.
