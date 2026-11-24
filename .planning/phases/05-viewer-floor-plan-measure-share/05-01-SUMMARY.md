---
phase: 05-viewer-floor-plan-measure-share
plan: 01
subsystem: backend
tags: [mock-provider, fixtures, splat, floorplan, docker]
requires: []
provides:
  - backend/test/fixtures/demo-room (deterministic synthetic room in Echo-3 conventions)
  - MOCK_OUTPUTS_SET config (default | demo-room)
  - thumbnail artifact kind imported into worlds.thumbnail_key
  - world.floorplan_meta on GET /v1/worlds/:id
  - exported ASSET_FIELDS, DOWNLOAD_TTL_SECONDS, serializeWorldDetail
affects: [05-02 viewer, 05-04 public share route, Railway dev image]
tech-stack:
  added: []
  patterns: [seeded mulberry32 PRNG fixture generator, pure builders + byte-compare determinism test]
key-files:
  created:
    - backend/scripts/make-demo-room.ts
    - backend/test/demo-room.test.ts
    - backend/test/fixtures/demo-room/{splat.ply,collider.ply,floorplan.png,floorplan.json,cameras.json,thumbnail.jpg,README.md}
    - backend/test/fixtures/mock-outputs/thumbnail.jpg
    - backend/test/provider/mock-outputs-set.test.ts
    - backend/test/worlds.detail.test.ts
  modified:
    - backend/package.json
    - backend/src/config.ts
    - backend/src/provider/{index,mock,types}.ts
    - backend/src/pipeline.ts
    - backend/src/routes/worlds.ts
    - Dockerfile
    - .dockerignore
    - backend/test/{config,docker-mock-outputs}.test.ts
    - backend/test/provider/mock.test.ts
    - backend/test/integration/pipeline.pg.test.ts
    - backend/test/fixtures/mock-outputs/README.md
decisions:
  - "Demo-room determinism is checked by the pure builders against the committed bytes, not by re-running main() in a temp dir, because CI has no ffmpeg. PNG/JPEG determinism was verified locally (re-run, identical sha1)"
  - "Detail body moved into an exported serializeWorldDetail(world, storage), so it can be tested without a DB and reused by 05-04"
  - "The collider floor is a single up-facing quad, not a slab, so every collider vertex stays inside scene_bounds. Walls are 2 cm slabs whose outer face is the room boundary"
metrics:
  duration: ~25 min
  completed: 2026-11-24
---

# Phase 5 Plan 01: Demo room, MOCK_OUTPUTS_SET, thumbnail import, floorplan_meta Summary

The mock provider can now return a synthetic 4 x 5 m demo room. It is deterministic and license-free: a 72k-gaussian 3DGS splat (4.06 MB), a collider, a 0.02 m/px floor plan with exact inverse affines, a 24-frame camera loop and a 1200x630 thumbnail. You select it with `MOCK_OUTPUTS_SET=demo-room`. The importer now stores the thumbnail, and the world detail response includes `floorplan_meta`.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Demo-room generator and committed fixture | fe22ab5 |
| 2 | Mock serves the demo room with a thumbnail, importer stores it, image ships it | 0362b57 |
| 3 | floorplan_meta on the world detail response | 36c1ec9 |

## What was built

- `npm run demo-room` runs `scripts/make-demo-room.ts`. All geometry is spaitial-world-v1 (+Y up, metres). The floor is a checkerboard and each wall has its own colour, so a mirrored load is visible. The doorway is in the blue z=+2.5 wall. `camera_from_splat = F · inv(T_three) · F`. Every collider face points outward, because three's FrontSide raycast needs that.
- `config.MOCK_OUTPUTS_SET` is a zod enum `['default','demo-room']` that maps to two fixed directories, so no path is ever built from env (T-05-01).
- `ArtifactKind` gains `'thumbnail'`. The mock serves `thumbnail.jpg`, and `KEY_COLUMN.thumbnail = 'thumbnailKey'`. The pg suite confirms `thumbnail_key` is set after import.
- The Dockerfile COPYs `backend/test/fixtures/demo-room` and `.dockerignore` re-includes it. `README.md` stays excluded through `*.md`.
- `GET /v1/worlds/:id` → `{ world: { ...serializeWorld, floorplan_meta }, assets }`. The list serializer is unchanged (T-05-02).

## Verification

- `npx tsc --noEmit`: clean.
- `npx vitest run`: 358 passed, 94 skipped (pg/s3 suites gated).
- `npm run test:pg -- test/integration/pipeline.pg.test.ts`: 7/7 passed (Neon dev branch).
- Re-ran `npm run demo-room`: all 7 files byte-identical (sha1). `git status` on the fixture folder is clean.

## Deviations from Plan

**1. [Rule 3 - Blocking] The determinism test compares builder output instead of running main() into a temp dir**
- `main()` needs ffmpeg for the PNG/JPEG, and the GitHub Actions backend job does not have it. The test byte-compares `buildSplat/buildCollider/buildFloorplanMeta/buildCameras` with the committed files. Image determinism was checked by hand locally.

**2. [Rule 1 - Bug] Updated existing artifact-name assertions**
- `test/provider/mock.test.ts` and `pipeline.pg.test.ts` hard-coded five output names. Both now include `thumbnail.jpg`.

**3. Detail serialization extracted into `serializeWorldDetail`**
- The route uses `getDb()` directly, so a pure function was the smallest way to test it in the worlds.list test style. Behaviour is unchanged apart from `floorplan_meta`.

## Known Stubs

None.

## Self-Check: PASSED
