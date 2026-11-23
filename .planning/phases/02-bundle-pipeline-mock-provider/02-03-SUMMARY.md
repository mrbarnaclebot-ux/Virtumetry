---
phase: 02-bundle-pipeline-mock-provider
plan: 03
subsystem: backend-bundle
tags: [yazl, lib-storage, r2, range, zip, exif, purge]

requires:
  - phase: 02-bundle-pipeline-mock-provider
    provides: "02-01 manifest/convert/exif/validate/zipread + tiny-session fixture; 02-02 dev-guard.mjs"
provides:
  - "StorageDriver.putStream/getStream/list (local + S3) and captureKey/bundleKeyFor/worldAssetKey"
  - "packCapture(storage, captureId, opts) + BundleInvalidError (src/bundle/pack.ts)"
  - "/dev-storage GET honours single byte ranges (206 / 416, Accept-Ranges)"
  - "scripts/test-r2.mjs + test/integration/r2-range.s3.test.ts (gated R2 Range proof)"
  - "purge deletes by prefix: worlds/{wid}/, captures/{cid}/, bundles/{cid}/"
affects: [02-04 mock provider, 02-05 pack job handler]

tech-stack:
  added: ["yazl 3.3.1", "@aws-sdk/lib-storage 3.1134.0", "@types/yazl 3.3.1 (dev)"]
  patterns:
    - "Bundle ZIP streamed yazl -> putStream, one frame in memory at a time; lazy-entry errors abort the upload and delete any partial object"
    - "Gated real-bucket tests run through a guard script that refuses any bucket but virtumetry-dev"

key-files:
  created:
    - backend/src/bundle/pack.ts
    - backend/test/bundle/pack.test.ts
    - backend/scripts/test-r2.mjs
    - backend/test/integration/r2-range.s3.test.ts
  modified:
    - backend/package.json
    - backend/package-lock.json
    - backend/src/storage/index.ts
    - backend/src/storage/s3.ts
    - backend/src/storage/local.ts
    - backend/src/worker.ts
    - backend/test/storage.local.test.ts
    - backend/test/worker.test.ts
    - backend/test/account-deleted.test.ts

key-decisions:
  - "Purge list failures fail the job (retry) instead of being swallowed; per-key deletes stay best-effort and idempotent"
  - "Missing/unparseable session.json or frames.jsonl content maps to BundleInvalidError MANIFEST_INVALID; storage read errors propagate as retryable"
  - "R2 checksum workaround (Pitfall 5) not needed: no requestChecksumCalculation in s3.ts"

requirements-completed: [PROC-04]

duration: 7min
completed: 2026-11-23
---

# Phase 2 Plan 03: Bundle packer and R2 Range proof Summary

**The stored session is streamed by yazl (store-only) and lib-storage into `bundles/{cid}/capture_bundle.zip`, which holds exactly the Echo-3 layout, has EXIF that reads back correctly and an exact byte size. On virtumetry-dev that bundle answers Range requests through a 24 h presigned URL.**

## Performance

- Duration: ~7 min
- Completed: 2026-11-23
- Tasks: 3/3
- Files: 4 created, 9 modified

## Accomplishments

- Storage drivers can stream data in and out and list by prefix. The local `/dev-storage` GET now serves byte ranges (206 with Content-Range, 416 when the range can't be satisfied).
- `packCapture` validates the session before it writes anything, then writes `images/Image_%06d.jpg`, `cameras/per_frame_intrinsics.json` and `cameras/camera_trajectory.json` (`[N][4][4]`) and nothing else. Every entry uses method 0.
- The fixture bundle is **1,573,439 bytes** for 30 frames at 640x480. `bundleBytes` equals yazl's calculatedTotalSize, which equals the stored object size.
- Gated R2 test: `node --env-file=.env scripts/test-r2.mjs` **passed 1/1 on virtumetry-dev** (about 85 s). The URL is presigned for 86400 s (X-Amz-Expires asserted, never printed). `Range: bytes=0-15` returned 206 with `PK\x03\x04` and `Content-Range: bytes 0-15/1573439`. The central directory read over Range has 32 entries. Test objects under `captures/it-<uuid>/` and `bundles/it-<uuid>/` were deleted, and the test asserts both prefixes are empty afterwards.
- Guard: with `S3_BUCKET=virtumetry-prod`, `test-r2.mjs` exits 1 before any network call.
- Purge deletes by prefix. A `cap-10`/`w-10` neighbour in the test proves that the trailing-slash prefixes don't over-delete.

## Task Commits

1. Task 1, storage primitives + Range: `41387d9`
2. Task 2 (TDD): RED `c053ddb` test, GREEN `02b4ef6` feat
3. Task 3, R2 proof + prefix purge: `47d352c`

## Verification

- `npx tsc --noEmit`: 0
- `npx vitest run`: 31 files passed, 3 skipped (gated pg/R2). 273 tests passed, 15 skipped
- `node --env-file=.env scripts/test-r2.mjs`: 1 passed (executed, not skipped)
- PG integration tests: not re-run. This plan changed no DB code, and the worker tests use stubs.

## Deviations from Plan

**1. [Rule 3 - Blocking] `@types/yazl` types `end()`'s callback as `() => void`**
- yazl passes `calculatedTotalSize`, so the callback is cast, with a comment. `EndOptions` requires both fields, so `{ forceZip64Format: false, comment: '' }` is passed.
- Commit: `02b4ef6`

## Notes

- The fixture bundle (1.5 MB) is smaller than one 16 MiB part, so lib-storage `Upload` sent it as a single PutObject. The multipart path against R2 is therefore not exercised by this fixture. It will be first exercised by a bundle larger than 16 MiB (a real capture), and Pitfall 5 is the fallback if that fails.
- worker.test.ts dropped the World Labs `MODEL_CREDITS` / `creditsForModel` describe as planned. 02-04 owns the new mock tests.

## Known Stubs

None.

## Self-Check: PASSED
