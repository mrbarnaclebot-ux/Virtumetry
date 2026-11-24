---
phase: 05-viewer-floor-plan-measure-share
plan: 02
subsystem: app-viewer
tags: [viewer, spark, three, dom-component, expo-router, react-query]
requires: []
provides:
  - "'use dom' WorldViewer (src/viewer/world-viewer.tsx) with the D-04 ViewerProps contract (src/viewer/types.ts)"
  - "createEngine (src/viewer/engine.ts): loadSplat/setStartPose/reset/setMode/dispose/onFirstFrame, bytes kept for 05-05"
  - "pure coords.ts (F, cameraToThree, matToPose, fallbackPose, needsFlip, splatFrameFor), progress.ts, tokens.ts"
  - "/world/[id] route + useWorld/getWorld/WorldDetail in lib/api.ts"
affects: [05-03, 05-04, 05-05, 05-06, 05-07]
tech-stack:
  added: ["three@0.187.0", "@sparkjsdev/spark@2.4.0", "three-mesh-bvh@0.9.18", "@types/three@0.187.0 (dev)"]
  patterns: ["DOM component reads props through a ref; engine keyed on splatUrl + retry attempt only", "never-refetch world query for presigned URLs"]
key-files:
  created:
    - virtumetry/src/viewer/tokens.ts
    - virtumetry/src/viewer/types.ts
    - virtumetry/src/viewer/coords.ts
    - virtumetry/src/viewer/progress.ts
    - virtumetry/src/viewer/engine.ts
    - virtumetry/src/viewer/world-viewer.tsx
    - virtumetry/src/app/world/_layout.tsx
    - virtumetry/src/app/world/[id]/index.tsx
    - virtumetry/src/__tests__/viewer-coords.test.ts
    - virtumetry/src/__tests__/viewer-progress.test.ts
    - virtumetry/src/__tests__/viewer-tokens.test.ts
    - virtumetry/src/__tests__/world-screen.test.tsx
  modified:
    - virtumetry/package.json
    - virtumetry/package-lock.json
    - virtumetry/src/app/_layout.tsx
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/components/library-row.tsx
    - virtumetry/src/lib/api.ts
    - virtumetry/src/__tests__/library.test.tsx
decisions:
  - "LOD_SPLAT_COUNT = 1,000,000 on iOS (Spark default 1.5M), Spark default elsewhere; SparkRenderer enableLod defaults to true in 2.4.0"
  - "useWorld retries only non-4xx errors, at most 2 times, so 404 shows 'This scan isn't available' at once"
  - "Library push uses pathname '/world/[id]' cast to Href: typed-routes generation lists the folder route only as '/world/[id]/index'"
  - "RN screen shows a native spinner over the viewer until the DOM reports its first onProgress/onReady/onError (Pitfall 12)"
metrics:
  duration: "~45 min"
  completed: 2026-11-24
  tasks: 3
  files: 19
---

# Phase 5 Plan 02: Open and orbit a ready room Summary

A Ready Library row now opens `/world/[id]`, a full-screen, always-dark screen. The screen hosts a `'use dom'` Spark 2.4 + three 0.187 viewer. The viewer downloads the splat with honest streamed progress, loads it with `lod: true` under an iOS splat budget, starts at the first cameras.json camera (or the scene-bounds/splat-bounds fallback), orbits, and resets.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | Pinned viewer deps plus pure tokens, coords and progress modules (TDD) | ba8173d (RED), a073d4f (GREEN) |
| 2 | Engine plus the `'use dom'` WorldViewer (loading, LoD, start pose, orbit, Reset, load error) | 00c722d |
| 3 | World route, screen states, `useWorld`, and the Library entry | 39f4194 |

## Verification

- `npx jest --ci`: 23 suites and 229 tests pass. This includes the 3 new viewer-* suites, world-screen (6 tests) and the extended library test.
- `npx tsc --noEmit` and `npx expo lint` are clean.
- I bundle-checked with `npx expo export --platform ios` into the scratchpad (no Metro server, no EAS). The DOM bundle builds at 4.1 MB, which matches Pitfall 12. Output was deleted afterwards.
- Pins are exact (`three` 0.187.0, `@sparkjsdev/spark` 2.4.0, `three-mesh-bvh` 0.9.18, `@types/three` 0.187.0 in devDependencies), and the lockfile is committed.
- The owner still needs to do the on-device check in Expo Go: open a Ready room, watch the percent, orbit, Reset. This is UAT in 05-08.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 404 would have waited for 3 react-query retries**
- **Found during:** Task 3
- **Fix:** `useWorld` has `retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2`. A 4xx is final; network errors retry twice before "Couldn't open this scan".
- **Files:** virtumetry/src/lib/api.ts (commit 39f4194)

**2. [Rule 3 - Blocking] Typed routes reject `pathname: '/world/[id]'`**
- **Found during:** Task 3 (tsc)
- **Issue:** Typegen emits the folder route as `/world/[id]/index` only.
- **Fix:** `router.push({ pathname: '/world/[id]', params: { id } } as unknown as Href)`. At runtime the URL `/world/<id>` matches `world/[id]/index`.
- **Files:** virtumetry/src/app/(tabs)/index.tsx (commit 39f4194)

**3. [Rule 3] `npx expo install` put `@types/three` in dependencies**
- **Fix:** Moved it to devDependencies and re-ran `npm install` so the lockfile matches.

### Notes
- `createEngine(canvas, { reducedMotion })` drops the planned `insets` option. The engine does not use insets because overlays live in the DOM component. Later plans can add options.
- The Task 3 tests were written alongside the implementation instead of as a separate RED commit. Task 1 follows the full RED→GREEN sequence.
- Viewer types live in `src/viewer/types.ts` (type-only). `coords.ts` only has `import type` from it.

## Known Stubs

- `virtumetry/src/viewer/world-viewer.tsx`: the Walk and Measure segments render `aria-disabled` at 0.4 opacity and do nothing. This is intentional: walk and measure ship in 05-03 (marked with a `ponytail:` comment).
- The Share button in the top bar is not rendered yet. It comes with the share plan.

## TDD Gate Compliance

Task 1: `test(05-02)` ba8173d, then `feat(05-02)` a073d4f. Task 3 has no separate RED commit (see Notes).

## Self-Check: PASSED

- All 12 created files exist on disk.
- Commits ba8173d, a073d4f, 00c722d and 39f4194 are present in `git log`.
