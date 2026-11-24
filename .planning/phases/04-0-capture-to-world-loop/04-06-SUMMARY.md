---
phase: 04-0-capture-to-world-loop
plan: 06
subsystem: app/capture-ui
tags: [capture, prep, camera-permission, hud, svg, expo-router]
requires:
  - "04-04: readiness, costFor/formatUsd/formatCredits, coverage/fitToBox/sectorScreenDeg, precheck, useCaptureConfig"
  - "04-05: getCaptureSource/isFixtureSource, FixtureCaptureSource.setScenario, addLocalScan, LocalScan"
provides:
  - "src/app/capture/_layout.tsx: capture Stack (headerless), presented fullScreenModal from the root guard"
  - "src/app/capture/prep.tsx: first-run / compact / denied prep with camera priming"
  - "src/app/capture/scan.tsx: always-dark scan screen with live HUD; Stop saves on phone"
  - "src/capture/prep-flags.ts: getPrepFlags, markPrepSeen, setSkipPrep, markPermissionAsked"
  - "src/components/readiness-pill.tsx, src/components/coverage-map.tsx"
affects: [capture/[id] review step (plan 08 re-points Stop), Library]
tech-stack:
  added: ["expo-camera ~58.0.14 (useCameraPermissions only)", "react-native-svg 15.16.0", "expo-keep-awake ~58.0.4"]
  patterns: ["HUD derives everything from CaptureSource keyframe events", "router.back() closes the capture modal (the capture stack only ever holds one screen)"]
key-files:
  created:
    - virtumetry/src/app/capture/_layout.tsx
    - virtumetry/src/app/capture/prep.tsx
    - virtumetry/src/app/capture/scan.tsx
    - virtumetry/src/capture/prep-flags.ts
    - virtumetry/src/components/readiness-pill.tsx
    - virtumetry/src/components/coverage-map.tsx
    - virtumetry/src/__tests__/capture-prep.test.tsx
    - virtumetry/src/__tests__/capture-scan.test.tsx
  modified:
    - virtumetry/package.json
    - virtumetry/package-lock.json
    - virtumetry/src/app/_layout.tsx
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/__tests__/library.test.tsx
decisions:
  - "Prep flags use the sync expo-secure-store API (getItem/setItem), wrapped in try/catch so web reads them as unset"
  - "Closing the capture modal is router.back(): prep -> scan uses replace and Library may push scan directly, so the capture stack always holds a single screen"
  - "Mini-map ring draws sector k at sectorScreenDeg(k) (clockwise from up), so it is not mirrored"
  - "Scan imageW/imageH are read back from the session.json the source wrote (fallback 640x480)"
metrics:
  duration: ~30min
  completed: 2026-11-24
  tasks: 3
  files: 13
---

# Phase 4 Plan 06: Prep, scan screen and live HUD Summary

From the Library, "New scan" opens a full-screen capture modal: a prep checklist with camera priming (first-run, compact with "Don't show again", or denied with Open Settings / Use test capture / Not now), then an always-dark scan screen. On that screen the fixture replay drives a readiness pill, a "$9.30 · 930 credits" cost meter, a frame count and an SVG coverage mini-map. Stop saves the scan on the phone and returns to the Library.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Capture stack, prep screen with permission priming, Library "New scan" entry | 2eadd1a |
| 2 | Readiness pill and SVG coverage mini-map | 990b7d7 |
| 3 | Scan screen: fixture scenarios, live HUD, Stop saves on phone | 4e13c2b |

## Verification

- `npx jest --ci`: 15 suites, 151 tests passed (prep 5, scan 4).
- `npx tsc --noEmit` clean. `npx expo lint` clean.
- Package gate: expo-camera, react-native-svg and expo-keep-awake in package.json equal `node_modules/expo/bundledNativeModules.json`. `npx expo install` did not touch app.json, so no config plugins were added.
- Acceptance greps match: `presentation: 'fullScreenModal'` in the guarded block, `useCameraPermissions` and `Linking.openSettings` in prep, `capture/prep` in the Library, and `addListener('keyframe'`, `addLocalScan(` and `Cancel scan?` in scan. scan.tsx imports only the `FixtureScenario` type from fixture-source.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] expo-router could not load in jest**
- **Found during:** Task 1. The Library now imports `router`, and expo-router's `standard-navigation` dependency ships ESM only.
- **Fix:** added `standard-navigation` to the jest `transformIgnorePatterns` allowlist in package.json. The screen tests still mock expo-router to assert navigation.
- **Commit:** 2eadd1a

**2. [Rule 1 - Copy] Library empty-state body**
- Changed the body to the UI-SPEC copy ("Walk slowly around a room with your phone, and it comes back here in 3D.") and updated the library.test assertion to match.

**3. [Rule 3 - Blocking] Typed route for /capture/scan before it existed**
- In Task 1, `'/capture/scan'` was cast `as Href` because the route file arrived in Task 3. The owner's Metro regenerated the typed routes once scan.tsx existed, and the casts were removed in 4e13c2b.

**4. [Rule 2 - Correctness] Start failure resets the HUD**
- If `src.start()` throws, the screen goes back to idle instead of leaving the shutter stuck on a spinner. Cancel during recording with 0 frames also calls `src.cancel()`, so no empty session dir is left behind.

### Notes / skipped

- The optional throttled `'pose'` listener is skipped. The mini-map's current dot follows keyframes, which arrive at about 4 Hz with the fixture. Add the pose listener with the native source (Phase 8) if the dot looks laggy.
- Jest prints "A worker process has failed to exit gracefully" when suites that import expo-router run together. All tests pass. This is likely an open handle inside expo-router and is not investigated here.

## Known Stubs

- Stop closes back to the Library instead of opening `capture/[id]` review. This is intentional per the plan: plan 08 creates that route and re-points Stop to it.

## Requirements

CAP-01, CAP-05, CAP-06, CAP-07, CAP-09 and CAP-10 are partly delivered on the app side. Review, upload and server validation land in plans 07-09, so none of them are marked complete here.

## Self-Check: PASSED

All created files exist. Commits 2eadd1a, 990b7d7 and 4e13c2b are in git log.
