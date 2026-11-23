---
phase: 02-bundle-pipeline-mock-provider
plan: 01
subsystem: backend-bundle
tags: [zod, arkit, opencv, exif, zip, fixtures, tum-rgbd]

requires:
  - phase: 01-backend-foundation
    provides: backend skeleton, MAX_FRAME_BYTES, zod/vitest/tsx toolchain
provides:
  - "Session format schema 1 (SessionV1, FrameLineV1, parseFramesJsonl)"
  - "arkitToOpenCV (D·inv(T), nested row-major [4][4]), cameraCentre, rotationIssues"
  - "106-byte EXIF APP1 writer (exifApp1, withExif) and jpegSize"
  - "D-06 validator (validateSession, validateFrameImage) with named issue codes"
  - "ZIP central-directory reader (readCentralDirectory, readEntry, ReadRange)"
  - "30-frame TUM fr3 tiny-session fixture and mock-output placeholders"
affects: [02-03 pack, 02-04 mock provider, 02-05 submit, phase 3/4 app session writer, phase 6 first paid run]

tech-stack:
  added: []
  patterns:
    - "Pure bundle helpers under backend/src/bundle, tested on Windows"
    - "Validators return {code,message}[] and never throw; thresholds are exported UPPER_SNAKE constants"
    - "Storage keys generated from frame index i, never taken from the manifest"

key-files:
  created:
    - backend/src/bundle/manifest.ts
    - backend/src/bundle/convert.ts
    - backend/src/bundle/exif.ts
    - backend/src/bundle/validate.ts
    - backend/src/bundle/zipread.ts
    - backend/scripts/make-tiny-session.ts
    - backend/test/bundle/convert.test.ts
    - backend/test/bundle/exif.test.ts
    - backend/test/bundle/validate.test.ts
    - backend/test/helpers/capture-exif.ts
    - backend/test/fixtures/tiny-session/ (session.json, frames.jsonl, 30 JPEGs, README.md)
    - backend/test/fixtures/mock-outputs/ (splat.ply, collider.ply, floorplan.png, floorplan.json, cameras.json, README.md)
  modified:
    - .gitattributes

key-decisions:
  - "Fixture sequence is TUM fr3/nostructure_texture_far (211 MB, smallest fr3 with motion), not large_cabinet"
  - "Fixture world up is the TUM mocap +Z axis, not the image-down average, because the camera looks down at a floor poster"
  - "validateFrameImage reports an unreadable JPEG as IMAGE_SIZE_MISMATCH rather than adding a new code"
  - "backend/test/fixtures/** pinned to eol=lf so PLY/JSONL bytes survive autocrlf checkouts"

patterns-established:
  - "Vendored third-party test helpers carry origin URL, commit and licence in a header comment"

requirements-completed: [PROC-04]

duration: 12min
completed: 2026-11-23
---

# Phase 2 Plan 01: Bundle Building Blocks & Fixture Summary

**Schema 1 session contract, a verified ARKit→OpenCV converter, a 106-byte EXIF writer that SpAItial's own reader reads back, a D-06 validator with 15 named codes, and a 30-frame CC BY TUM fixture (1.6 MB), all pure TypeScript with no new dependency.**

## Performance

- **Duration:** about 12 min
- **Started:** 2026-11-23T12:53Z
- **Completed:** 2026-11-23T13:05Z
- **Tasks:** 3 of 3
- **Files:** 11 source/test files plus 41 fixture files

## Accomplishments
- `manifest.ts` locks schema 1: `schema: z.literal(1)` and `tzOffset` must be `±HH:MM`. `parseFramesJsonl` reports `line N: path: message`.
- `arkitToOpenCV` passes the SpAItial minimal-bundle golden (i=0..2), the D-03 case, the det/bottom-row check, a round-trip test and a reprojection test (principal point, plus +X right).
- The EXIF APP1 writer is read back by the vendored SpAItial `readCaptureExif` as `1341847980.722 s` with `+02:00`. Negative offsets and zero-padded millis work, and only `getUTC*` is used.
- The validator passes the fixture with zero issues. Each of the 15 D-06 codes has a failing test. Path traversal (`../x`) fails as `FRAME_FILE_MISMATCH`.
- The fixture script re-runs end to end. For every frame it checks `arkitToOpenCV(W·T·F) == inv(T)·Wᵀ` within 1e-9 and that W maps up to +Y.

## Dataset / Fixture Facts
- **Sequence:** `rgbd_dataset_freiburg3_nostructure_texture_far` (TUM RGB-D, CC BY 4.0, Sturm et al. IROS 2012), downloaded to the scratchpad only.
- **Frame range:** `rgb/1341839847.710094.png` to `rgb/1341839855.485969.png` (rgb.txt lines 71–301), 30 frames at ≥0.25 s spacing, 2.54 m path, max step < 0.5 m.
- **Size:** tiny-session 1613 KB, mock-outputs 38 KB, so about 1.65 MB in total (cap is 3.5 MB). No `.tgz`/`groundtruth.txt`/`rgb.txt` in git.
- **EXIF reader:** the real vendored SpAItial reader (`tools/validate-bundle/src/exif.ts`, commit f351e1b, MIT-0) was used, not the fallback. The synthetic fallback was not needed, so no `--synthetic` flag was built.

## Task Commits
1. **Task 1: manifest, converter, EXIF (TDD)**: `c03b7ca` (test, RED), `3232fe1` (feat, GREEN)
2. **Task 2: TUM fixture + mock outputs**: `a4c7788` (feat)
3. **Task 3: validator + zipread (TDD)**: `c1cbe06` (test, RED), `a3ca341` (feat, GREEN)

## Test Evidence
- `npx vitest run test/bundle`: 39 passed (convert 12, exif 7, validate 20)
- `npx vitest run` (full): 268 passed, 12 skipped (32 files: 30 passed, 2 skipped). Baseline was 229 passed. The skips are the existing env-gated integration tests.
- `npx tsc --noEmit`: clean

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Gravity estimate from mean image-down axis was wrong for this sequence**
- **Found during:** Task 2
- **Issue:** The camera looks down at a floor poster about 52° below horizontal, so `−mean(R_tum[:,1])` gave an "up" that was almost horizontal, and the converted camera appeared to look at the ceiling. The convention self-check still passed, because it holds for any W.
- **Fix:** Use the mocap frame's +Z as up. The trajectory confirms it: height tz stays at 1.87–1.95 m while the camera travels 4.3 m in y. The camera now sits at y≈1.94 m looking down. This also supports assumption A1: with flipped TUM camera axes it would look up.
- **Files modified:** backend/scripts/make-tiny-session.ts
- **Commit:** a4c7788

**2. [Rule 1 - Bug] rotateOntoY axis sign**
- **Found during:** Task 2
- **Issue:** The axis was computed as Y×u instead of u×Y, which mapped up onto −Y.
- **Fix:** Corrected the cross product and added an assertion that W·up = +Y.
- **Commit:** a4c7788

**3. [Rule 3 - Blocking] CRLF conversion of fixtures on Windows checkouts**
- **Issue:** With `core.autocrlf=true` and `* text=auto`, a fresh checkout would rewrite `collider.ply` to start with `ply\r`, which breaks the acceptance check and PLY parsers.
- **Fix:** Added `backend/test/fixtures/** text=auto eol=lf` to `.gitattributes`.
- **Commit:** a4c7788

**4. [Plan choice] Smaller fr3 sequence**
- The plan allowed a smaller fr3 sequence with motion. I used `nostructure_texture_far` (211 MB) instead of `large_cabinet` (498 MB).

## Known Stubs
- `backend/test/fixtures/mock-outputs/*` are intentional placeholders (D-14), described in their README and consumed by the mock in plan 02-04.

## Notes for Later Plans
- `zipread.ts` has no test yet by design. Plans 02-03 (pack) and 02-04 (mock) exercise it.
- Phase 6 risk A8 is unchanged: the fixture is 640x480, valid per the docs, but the prototype validator allows only 1920-wide images.

## Self-Check: PASSED
