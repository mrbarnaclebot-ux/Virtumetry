---
phase: 04-0-capture-to-world-loop
plan: 05
subsystem: app/capture-source
tags: [capture, fixture, expo-file-system, local-store, library, tdd]
requires:
  - "04-04: src/capture/types.ts CaptureSource/FrameLine/Session, precheck PrecheckIssue, readiness Level"
provides:
  - "src/capture/fixture-assets.ts: FIXTURE_FRAME_MODULES (30 requires), FIXTURE_FRAMES, FIXTURE_IMAGE, resolveFixtureFrame"
  - "src/capture/fixture-source.ts: FixtureCaptureSource (injected resolveFrame/now/speed), FIXTURE_SCENARIOS, FixtureScenario"
  - "src/capture/source.ts: getCaptureSource(), isFixtureSource()"
  - "src/capture/store.ts: useLocalScans, useLocalScan, addLocalScan, updateLocalScan, discardLocalScan, getLocalScans, getLocalScan, __setLocalScansForTest, __reloadForTest"
  - "src/library/display-state.ts: full LocalScan + LocalUploadState"
affects: [scan screen, review/quote/upload (plans 06-08)]
tech-stack:
  added: ["expo-file-system ~58.0.14 (direct)", "expo-asset ~58.0.21 (direct)"]
  patterns: ["sync File API (writeSync/copySync/textSync) for ordered per-frame writes", "external store over index.json via useSyncExternalStore"]
key-files:
  created:
    - virtumetry/assets/fixtures/tiny-session/frames.json
    - virtumetry/assets/fixtures/tiny-session/README.md
    - virtumetry/assets/fixtures/tiny-session/frames/000001.jpg … 000030.jpg
    - virtumetry/src/capture/fixture-assets.ts
    - virtumetry/src/capture/fixture-source.ts
    - virtumetry/src/capture/source.ts
    - virtumetry/src/capture/store.ts
    - virtumetry/src/__tests__/capture-fixture-source.test.ts
    - virtumetry/src/__tests__/capture-store.test.ts
  modified:
    - virtumetry/package.json
    - virtumetry/package-lock.json
    - virtumetry/src/library/display-state.ts
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/__tests__/library.test.tsx
    - virtumetry/src/__tests__/library-actions.test.tsx
    - virtumetry/src/__tests__/display-state.test.ts
  deleted:
    - virtumetry/src/library/local-scans.ts
decisions:
  - "Fixture source uses the sync File API (writeSync with append, copySync) so frames.jsonl lines stay in order inside the timer callback"
  - "resolveFrame(k) is 0-based; frames are renumbered i = k+1, file frames/NNNNNN.jpg, wallMs = now0 + round((t_k - t_0) * 1000)"
  - "A 'tracking' event fires on the first frame and on every change (good run: one 'normal'; tracking-gap: normal, limited, normal)"
  - "expo-asset config plugin added by `npx expo install` was reverted (no app.json plugin changes in Phase 4)"
  - "Local row menu is Discard · Cancel (no Delete); server rows keep Rename · Delete · Cancel"
metrics:
  duration: ~25min
  completed: 2026-11-24
  tasks: 2
  files: 46
---

# Phase 4 Plan 05: Fixture capture source and saved-on-phone store Summary

The bundled TUM tiny session (30 CC BY 4.0 JPEGs + frames.json) replays through the CaptureSource contract at 2x speed, writes a real schema-1 session dir under `Paths.document/sessions/<uuid>/`, and finished scans persist in `sessions/index.json`, show in the Library as "Saved on phone" and can be discarded.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Bundle the fixture, FixtureCaptureSource + getCaptureSource | 4faa755 (RED), 0e6df39 (GREEN) |
| 2 | Persisted local scan store wired into the Library | 72b2b91 (RED), e993b97 (GREEN) |

## Verification

- `npx jest --ci`: 13 suites, 142 tests passed (fixture source 10, store 5).
- `npx tsc --noEmit` clean. `npx expo lint` clean.
- Package gate: `expo-file-system` and `expo-asset` in package.json equal `node_modules/expo/bundledNativeModules.json`.
- Drift test: `assets/fixtures/tiny-session/frames.json` deep-equals `backend/test/fixtures/tiny-session/frames.jsonl`.
- `grep -rn local-scans virtumetry/src` is empty; 30 frame requires in fixture-assets.ts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npx expo install` added an `expo-asset` config plugin to app.json**
- The plan forbids app.json plugin changes; reverted app.json. The plugin only embeds assets in native builds; Metro serves them in Expo Go.

**2. [Rule 3 - Blocking] display-state.test.ts built the old 3-field LocalScan**
- Cast the literal to `LocalScan & { local: true }` so the existing saved_on_phone test still type-checks. Commit e993b97.

**3. [Rule 2 - Correctness] Delete-failure path tested**
- Store test spies `Directory.prototype.delete` to throw and asserts the entry is kept and the error rethrown (T-04-22).

### Notes

- Restart is simulated with `__reloadForTest()` (drop memory, reload from disk) instead of `jest.isolateModules`: a fresh module registry would also re-create the in-memory FS mock and lose the file.
- The FS mock is not reset between tests (jest-expo's lookup hack cannot find `__resetMockFileSystem` from a test file); each test uses fresh uuid or counter-based session ids, so there is no cross-test state.
- `resolveFixtureFrame` falls back to `File.downloadFileAsync` into the cache when `localUri` is null (research A1). Not exercised on device yet.

## TDD Gate Compliance

`test(04-05)` 4faa755 precedes `feat(04-05)` 0e6df39; `test(04-05)` 72b2b91 precedes `feat(04-05)` e993b97.

## Requirements

CAP-10 (fixture source) and CAP-09 (saved on phone first) app pieces are in place; the scan screen and upload that complete them land in plans 06-08, so neither is marked complete here.

## Self-Check: PASSED

All created files exist; commits 4faa755, 0e6df39, 72b2b91, e993b97 are in git log.
