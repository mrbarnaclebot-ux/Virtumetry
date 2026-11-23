---
phase: 02-bundle-pipeline-mock-provider
plan: 05
subsystem: backend-pipeline
tags: [worker, state-machine, submit, track, import, mock, budget]

requires:
  - phase: 02-bundle-pipeline-mock-provider
    provides: "02-02 schema/queue snoozeJob/failJob(delay)/pg-schema helper; 02-03 packCapture/putStream/worldAssetKey/dev-storage Range; 02-04 ReconProvider + mock + reserveCredits/releaseCredits"
provides:
  - "src/pipeline.ts: handlePack, handleSubmit, handleTrack, failWorld, SUBMIT_MAX_ATTEMPTS = 4"
  - "worker.ts: pack/submit/track kinds, WorkerDeps.provider, runOneJob, RetryLaterError -> failJob(delay)"
  - "test/helpers/pipeline.ts: startPipeline harness (pg schema + local storage over HTTP + mock + drain + onWebhook hook)"
  - "test/integration/pipeline.pg.test.ts: happy end-to-end, validate, NOT_APPROVED, BUDGET_EXCEEDED"
affects: [02-06 webhook route (uses startPipeline/onWebhook), 02-07 scenario matrix + concurrent budget]

tech-stack:
  added: []
  patterns:
    - "Persist-before-spend: submission_key set-if-null, submit_body set-if-null, then re-read and send JSON.stringify of the DB value"
    - "track polls via snoozeJob (no attempt consumed, no lease held between polls)"
    - "Import re-hosts artifact by artifact (skip if object exists), then ONE conditional UPDATE to ready"

key-files:
  created:
    - backend/src/pipeline.ts
    - backend/test/helpers/pipeline.ts
    - backend/test/integration/pipeline.pg.test.ts
  modified:
    - backend/src/worker.ts

key-decisions:
  - "Handlers look up the world's latest capture instead of trusting the pack payload's captureId (frames:done may enqueue captureId null)"
  - "handlePack also writes the manifest's frameCount to the capture row, so the quote uses the packed count"
  - "Provider progress (0..1) is stored as an integer 0-100; track skips the status poll when the world is already importing (resume)"
  - "failWorld scrubs any http(s) URL from failure_message as a backstop to code-built messages"
  - "startPipeline drain default timeout is 60 s, not 15 s: Neon dev round trips make the happy path ~19 s"

requirements-completed: [PROC-07]

duration: 12min
completed: 2026-11-23
---

# Phase 2 Plan 05: Pack, submit, track, import through the mock Summary

**A fixture scan now goes pack → submit → track → importing → ready through the worker and the mock provider on real Postgres. All five outputs are re-hosted at `worlds/{wid}/v1/` before a single UPDATE marks the world ready and charged. Submit persists its key and body before spending, and refuses unapproved or over-budget scans before any provider call.**

## Performance

- Duration: about 12 min
- Completed: 2026-11-23
- Tasks: 3/3 (Task 1 RED test, Tasks 2-3 GREEN)
- Files: 3 created, 1 modified

## Accomplishments

- `handlePack`: if `packCapture` throws `BundleInvalidError`, the world goes to failed/validate with no credits and no submit. On success, one transaction updates the capture row (bundle key/bytes, manifest key, frame count, image size), flips packing → submitting and enqueues `submit`.
- `handleSubmit`: runs NOT_APPROVED, QUOTE_ABOVE_APPROVAL, BUNDLE_MISSING and BUDGET_EXCEEDED before any submit call. `submission_key` is only set while still null (`randomUUID` runs only on that path). A Range preflight (206 + `PK\x03\x04`) runs before the body is persisted. The webhook is added only when `PUBLIC_BASE_URL` is https. The body sent is always the one read back from the DB. Error matrix: 400/402/403 releases and fails; 409 logs loudly, keeps the reservation and parks the job dead; 429/503 retries with the same key and body (Retry-After, capped at 900 s) up to 4 attempts, then releases; 5xx/timeout/network keeps the reservation and retries, then SUBMIT_UNCERTAIN and parks dead.
- `handleTrack`: PENDING, PROCESSING or an unknown status (logged once) stores progress and snoozes. FAILED goes to failed/processing and releases. CANCELLED goes to cancelled and releases. COMPLETED goes to importing; a pending export snoozes, a failed export goes to failed/import and keeps the reservation. Then it streams every artifact through `provider.open()` into `putStream`, with a heartbeat between artifacts, reads back `floorplan.json` as `floorplanMeta`, and does one UPDATE to ready / charged / creditsSpent = quotedCredits.
- Worker: `runOneJob` is used by the loop and by the harness. `RetryLaterError` maps to `failJob(delay)`. `main()` builds the provider through `createProvider(config)`, so PROVIDER_MODE=live still throws.

## Task Commits

1. Task 1 (RED): `cda99e2` test(02-05): add failing end-to-end pipeline test and reusable harness
2. Task 2: `11ff75d` feat(02-05): pack and submit handlers with persist-before-spend and worker wiring
3. Task 3: `ef6daa8` feat(02-05): track and import handler; fixture scan reaches ready through the mock

## Verification

- `npx tsc --noEmit`: clean
- `npx vitest run`: 31 files passed, 5 skipped (gated); 287 tests passed, 27 skipped
- `node --env-file=.env scripts/test-pg.mjs test/integration` (Neon dev, throwaway schemas): 4 files passed, 1 skipped (R2-gated); **26 tests passed, 1 skipped**. That includes all 4 pipeline tests: happy (about 19 s), validate, NOT_APPROVED and BUDGET_EXCEEDED. Each refusal asserts 0 submit calls and no ledger rows.
- Happy path asserts: ready, charged, creditsSpent = 900 + 30, one submit, exactly one `reserve` row (mode mock) and no release, bundle bytes equal to the stored size, five re-hosted outputs with keys on the row, `floorplanMeta.version === 1`, pack/submit/track all `done`, and track attempts ≤ 1 after its PROCESSING polls.
- Acceptance greps: `SUBMIT_MAX_ATTEMPTS = 4` appears 1 time; `isNull(worlds.submissionKey)` is present; there is no console log of zip_url, presign or submitBody; `snoozeJob` appears 2 times; `status: 'ready'` appears 1 time.
- No real provider calls: mock only, and ALLOW_PAID_PROVIDER is unset.

## Deviations from Plan

**1. [Rule 3 - Blocking] The harness drain default timeout is 60 s instead of 15 s**
- Found during: Task 3. The happy path reached `importing` and then timed out at 15 s. Against Neon dev it takes about 17-19 s end to end, mostly per-query round trips and 30 pack heartbeats. It was not a stall.
- Fix: the default is 60 s, and the per-test timeout is 90 s.
- Commit: `ef6daa8`

**2. Task 2 committed track as a stub.** To keep the commits atomic, `handleTrack` in `11ff75d` threw NonRetryableJobError. The real handler landed in `ef6daa8`.

## Notes for downstream plans

- PROC-07 is marked complete. PROC-08 (concurrent over-budget) and PROC-10 (scenario matrix) are left to 02-07. Single-scan refusal before spend is proven here.
- `startPipeline` exposes `ctx.onWebhook`, `pool`, `getWorld`, and `seedScan({ approvedMaxCredits, mutate })`, which returns `{ worldId, captureId, frameCount }`.
- Ceiling: import treats "object exists" as done. That is safe on S3 (multipart is atomic), but the local driver could leave a partial file if the process crashes mid-stream. There is a `ponytail:` comment on it.
- A dead pack/submit/track job that the handler did not finalize (an exhausted generic retry) leaves the world in its in-progress status. Failing worlds on dead jobs is not in this plan.

## Known Stubs

None.

## Threat Flags

None. The new surface is covered by T-02-22..T-02-27.

## Self-Check: PASSED

- Files: src/pipeline.ts, test/helpers/pipeline.ts, test/integration/pipeline.pg.test.ts exist.
- Commits cda99e2, 11ff75d, ef6daa8 are in `git log`.
