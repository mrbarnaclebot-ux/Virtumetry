---
phase: 05-viewer-floor-plan-measure-share
plan: 05
subsystem: app-viewer
tags: [viewer, floor-plan, teleport, webgl-context-loss, crash-recovery, dom-component]
requires: ["05-01", "05-03"]
provides:
  - "src/viewer/floorplan.ts: applyAffine, pixelFromWorld, worldFromPixel, tapToPixel, headingAngle, hasFloorplan"
  - "src/viewer/recovery.ts: RECOVERY_CAP, RECOVERY_WINDOW_MS, initialRecovery, recoveryReducer (pose/crash/reload/ready), state.mountPose"
  - "engine: teleport(x, z, bounds?) -> Mode, getPose, getHeading, rebuild(), loadSplat(bytes, initialPose?)"
  - "WorldViewer: Plan rail toggle + floor-plan panel, WebGL context-loss overlay, throttled onPose"
  - "world/[id]: dom crash hooks, key remount at saved pose, capped 'The viewer stopped working' block"
affects: [05-06, 05-08]
tech-stack:
  added: []
  patterns:
    - "Remount key + pose frozen at remount (mountPose) instead of a live pose prop: no 2 Hz prop churn into the DOM tree"
    - "onPose emitted only after the first real frame, so a fresh mount never overwrites the saved pose with the default camera"
key-files:
  created:
    - virtumetry/src/viewer/floorplan.ts
    - virtumetry/src/viewer/recovery.ts
    - virtumetry/src/__tests__/viewer-floorplan.test.ts
    - virtumetry/src/__tests__/viewer-recovery.test.ts
  modified:
    - virtumetry/src/viewer/engine.ts
    - virtumetry/src/viewer/world-viewer.tsx
    - virtumetry/src/app/world/[id]/index.tsx
    - virtumetry/src/__tests__/viewer-coords.test.ts
    - virtumetry/src/__tests__/world-screen.test.tsx
decisions:
  - "The viewer's startPose prop is the pose frozen at the last remount (recovery.mountPose), not the live savedPose; savedPose still updates at <= 2 Hz in the reducer"
  - "rebuild() recreates WebGLRenderer + SparkRenderer + SplatMesh only; the collider BVH, camera and OrbitControls are plain JS and survive a context loss, so they are not rebuilt"
  - "Teleport floor = downward ray from collider-min + 1.6 m (same rule as entering Walk), fallback scene_bounds.min.y, then 0"
  - "While capped, the WorldViewer is unmounted (frees WebView memory); Reload remounts it"
  - "The screen clears 'Reconnecting viewer…' on the DOM's first onProgress or onReady (the B1 overlay takes over from there)"
  - "A floor-plan image that fails to load hides the Plan button (B9)"
metrics:
  duration: "~35 min"
  completed: 2026-11-24
  tasks: 3
  files: 9
---

# Phase 5 Plan 05: Floor plan and self-healing viewer Summary

Floor-plan panel with a live you-are-here dot and heading wedge plus tap-to-teleport, WebGL context-loss rebuild from cached splat bytes, and native WebView crash remount at the last pose with a 3-in-60-s cap. All of it rests on pure, jest-tested `floorplan.ts` and `recovery.ts`.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | floorplan.ts + recovery.ts with tests, demo-room start-pose cross-check | 40a52a0 (RED), 4460cac (GREEN) |
| 2 | Plan panel + teleport + WebGL context loss in the DOM viewer | 45dcf93 |
| 3 | Native WebView crash remount with saved pose + capped overlay | ca8cdfb (RED), 24bfa72 (GREEN) |

## What was built

- **floorplan.ts** (type-only import): row-major affine apply, pixel/world both ways, tap scaling without the +0.5, heading angle from the linear 2x2 part, and a `hasFloorplan` guard (T-05-24). The tests run against both the demo-room and mock-outputs `floorplan.json`: round-trip to 1e-9, demo (0,0) maps to the image centre, and a tap at world (0.5, 0) lands inside scene_bounds.
- **recovery.ts**: a crash bumps `mountKey` and sets `mountPose = savedPose`. The 4th crash inside 60 s caps the reducer, and crashes older than 60 s age out. `reload` uncaps and remounts. `ready` clears `reconnecting`.
- **Coords cross-check**: the first demo-room camera lands at about (0.7, 1.5, 0), inside the room, and faces the centre. This confirms the backend generator's convention.
- **Engine**: `teleport` uses capsule push-out (3 iterations). It switches to Walk when a collider exists. Without one it moves the orbit camera and stays in Orbit. `getPose` / `getHeading` were added. `rebuild()` makes no network call. A saved `initialPose` applies on load while Reset still goes to the computed start pose.
- **Viewer**: the Plan rail button sits under Reset (`aria-pressed`, grid glyph). The panel follows B6: dialog, 44x44 close, `role="button"` image, "Tap to jump there", Esc closes. The dot and wedge update every frame through refs. A tap teleports and shows "You're here now". On `webglcontextlost` the viewer calls preventDefault, shows "Reconnecting viewer…" and starts a 5 s timer that ends in `onError({ code: 'context_lost' })`. `onPose` is sent at most every 500 ms and only when the pose changed (T-05-23).
- **Screen**: `useReducer(recoveryReducer)`, with `key={rec.mountKey}` and `startPose={rec.mountPose}`. The `dom` object is memoised and carries `onContentProcessDidTerminate` and `onRenderProcessGone`. A `context_lost` error counts as a crash. While reconnecting, a black RN overlay with a spinner sits under the top bar, so Back still works. The capped block shows the UI-SPEC copy with "Reload viewer" and announces itself for accessibility.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Live savedPose as the startPose prop**
- **Found during:** Task 3
- **Issue:** The plan said `startPose={state.savedPose}`. That would change a DOM-component prop on every onPose (2 Hz) and re-render and re-serialise the whole DOM tree, which is a RESEARCH anti-pattern. The new screen test caught it, because startPose was non-null before any crash.
- **Fix:** Added `mountPose` to the reducer. It is frozen at crash and reload, and the screen passes `startPose={rec.mountPose}`.
- **Files modified:** recovery.ts, viewer-recovery.test.ts, world/[id]/index.tsx
- **Commit:** 24bfa72

**2. [Rule 1 - Bug] onPose before the real pose**
- **Found during:** Task 2
- **Issue:** Emitting onPose from frame one would send the default camera before the saved or start pose is applied. That would overwrite the saved crash pose on every remount.
- **Fix:** The onPose subscription starts in `onFirstFrame`.
- **Commit:** 45dcf93

### Scope notes
- The collider BVH is not rebuilt in `rebuild()`. It lives in CPU memory and is unaffected by a GL context loss. The plan text listed it, but rebuilding it would add work for no effect.
- The web share page's own capped block ("Reload page", UI-SPEC C) belongs to the share-page plan, not here.

## Verification

- `npx expo lint`: clean
- `npx tsc --noEmit`: clean
- `npx jest --ci`: 27 suites, 259 tests passing
- Acceptance greps: no runtime imports in floorplan.ts or recovery.ts. `fetch` appears in engine.ts only for cameras.json. No react-native-webview in package.json.
- Manual (05-08 UAT): Plan, then tap, then teleport on the device. Use `WEBGL_lose_context` in the Safari Web Inspector to confirm the viewer recovers.

## TDD Gate Compliance

Task 1: test commit 40a52a0, then feat commit 4460cac. Task 3: test commit ca8cdfb, then feat commit 24bfa72. The coords cross-check passed already at RED. That is expected, because it verifies an existing convention rather than new code.

## Known Stubs

None.

## Self-Check: PASSED
- Files exist: floorplan.ts, recovery.ts, viewer-floorplan.test.ts, viewer-recovery.test.ts
- Commits exist: 40a52a0, 4460cac, 45dcf93, ca8cdfb, 24bfa72
