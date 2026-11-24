---
phase: 04-0-capture-to-world-loop
plan: 02
subsystem: backend/upload-path
tags: [scans, presign, idempotency, approval, validation, e2e]
requires:
  - "04-01: captureConfig, validateStored, MANIFEST_MAX_BYTES, DEV_CAPTURE_CONFIG_JSON"
provides:
  - "routes/scans.ts: POST /v1/scans, POST /v1/scans/:id/uploads, GET /v1/scans/:id/uploads:missing, POST /v1/scans/<uuid>:complete"
  - "presignUpload optional 5th arg ttlSeconds (S3 honours it, local ignores it)"
  - "RouteDeps.provider (optional, defaults to createProvider(config))"
  - "worlds.ts exports requireUserId, sendScanQuotaExceeded, findWorldByClientRequestId, findOwnedWorld"
  - "test/helpers/pipeline.ts exports readFixture"
affects: [app plans 07/08 (consume the scans contract), plan 03 (removes old /v1/worlds upload routes)]
tech-stack:
  added: []
  patterns: ["uuid regex param + escaped literal colon for action routes", "storage.list is the upload source of truth"]
key-files:
  created:
    - backend/src/routes/scans.ts
    - backend/test/integration/scans.pg.test.ts
    - backend/test/integration/scans-e2e.pg.test.ts
  modified:
    - backend/src/routes/worlds.ts
    - backend/src/routes/index.ts
    - backend/src/routes/deps.ts
    - backend/src/server.ts
    - backend/src/storage/index.ts
    - backend/src/storage/s3.ts
    - backend/src/storage/local.ts
    - backend/test/helpers/pipeline.ts
decisions:
  - "RouteDeps.provider is optional with a createProvider(config) fallback, so the 8 existing hand-built RouteDeps in unit tests stay untouched"
  - "frame_count above provider.limits().maxFrames is 400 invalid_body (checked in the handler, not the zod schema, because limits are async)"
  - "dev-storage routes live in their own Fastify scope with only a raw-buffer parser"
metrics:
  duration: ~20min
  completed: 2026-11-24
  tasks: 3
  files: 11
---

# Phase 4 Plan 02: Server upload path to ready Summary

An approved session-format scan is created idempotently (approval checked against the provider quote), uploaded file by file through 6 h presigned PUTs to allowlisted paths, reconciled against what storage actually holds, and completed: `:complete` runs the plan-01 checks before any credit (bad scans fail at `validate` for free) and otherwise flips to `packing` so the mock pipeline takes it to `ready`.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Failing route-contract + create-to-ready e2e tests (RED) | b11ca86 |
| 2 | scans create, presign batch (6 h TTL), uploads:missing | 11c309e |
| 3 | :complete checks before credit, flip + pack enqueue (GREEN) | 9245237 |

## Verification

- RED: both pg files failed before the routes existed (11 failures: 404s on `/v1/scans`, e2e import of the missing `routes/scans.ts`).
- `npx tsc --noEmit` clean; `npx vitest run` 345 passed, 92 skipped (pg/r2 gated).
- `npm run test:pg -- scans, scans-e2e, pipeline, ownership`: 4 files, 28 tests passed.
- e2e: create (930 approved, 30 frames) -> 32 presigned PUTs over real HTTP -> missing [] -> complete -> drain -> `ready`, `approved_max_credits` 930, ledger exactly `[{ amount: 930, kind: 'reserve', provider_mode: 'mock' }]`.
- Broken fixtures (pose jump, 8 frames, tracking 10-17 limited) -> 200 `failed/validate`, `charged: false`, issues contain CAMERA_JUMP / FRAME_COUNT_OUT_OF_RANGE / TRACKING_GAP, zero `credit_events` rows, no pack/submit job.
- `/v1/scans/<uuid>:completeX` -> 404; owner B -> 404 on every `:id` route.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Local dev-storage rejected `frames.jsonl` PUTs**
- **Found during:** Task 3 (e2e)
- **Issue:** the presigned PUT carries `content-type: application/json`; Fastify's root JSON parser took precedence over the `*` buffer parser and returned 400 on JSONL. Would also have broken Expo Go uploads against a local-driver backend.
- **Fix:** `registerDevStorageRoutes` registers its routes in their own scope with `removeAllContentTypeParsers()` + a raw-buffer `*` parser. The root app no longer has the global `*` parser (no route relied on it; full unit suite green).
- **Files modified:** backend/src/storage/local.ts
- **Commit:** 9245237

**2. [Plan adjustment] `RouteDeps.provider` optional instead of required**
- Fallback `createProvider(config)` inside `scansRoutes`; server.ts passes it explicitly. Avoids editing 8 unrelated test constructors.

## TDD Gate Compliance

`test(04-02)` b11ca86 precedes `feat(04-02)` 11c309e and 9245237.

## Requirements

PROC-01, PROC-02, PROC-03 not marked complete: their app halves (device checks, quote/approval screen, resumable upload) land in later Phase 4 plans.

## Known Stubs

None. Old `/v1/worlds` create / uploads:refresh / frames:done routes intentionally remain (plan 03 removes them).

## Self-Check: PASSED
