---
phase: 06-live-echo-3-provider
plan: 06
subsystem: backend/test (money path proof)
tags: [exactly-once, idempotency, echo3, replay, recorder]
requires: [06-01 echo3.ts + fake-echo3.ts, 06-04 submit refusal classification]
provides: [startPipeline provider option, fake-echo3 replaySet, echo3-contract pg suite, synthetic replay manifest, record-echo3-run.ts]
affects: [backend/test/helpers/pipeline.ts, backend/test/helpers/fake-echo3.ts, backend/package.json]
tech-stack:
  added: []
  patterns: [crash simulated as a never-settling provider call (job left locked with the sending marker), recorded-response manifest replay]
key-files:
  created:
    - backend/test/integration/echo3-contract.pg.test.ts
    - backend/test/fixtures/echo3-recorded/manifest.json
    - backend/scripts/record-echo3-run.ts
  modified:
    - backend/test/helpers/pipeline.ts
    - backend/test/helpers/fake-echo3.ts
    - backend/package.json
decisions:
  - "The kill-mid-submit case simulates the crash with a provider call that never settles after the fake accepted, not with a thrown LeaseLostError: handleSubmit's catch around provider.submit turns any throw into an ordinary uncertain retry (unlocks and requeues the job), so a throw tests a retry, not a crash"
  - "The 409 case sets up the earlier use of the key by sending the same key with different bytes (body plus a trailing space) through the real client. billed stays 1 (that earlier world only), and the 409 bills nothing"
  - "The recorder writes statusSequence ['COMPLETED'] (only the final status can be observed after the fact) and keeps the small committed artifact paths. Real outputs are server-side copied in R2 dev to fixtures/echo3-run-1/"
metrics:
  duration: ~45 min
  completed: 2026-11-25
---

# Phase 6 Plan 06: Exactly-once proof on the live client Summary

The real `handleSubmit` plus `echo3.ts`, run on Neon dev Postgres against the hermetic fake Echo-3 server, bills exactly one world (`fake.state.billed === 1`) in every scenario: a crash after accept, two workers on one job, a dropped connection, a timeout, and 429 then 503. Every resend carries one Idempotency-Key and a byte-identical body, and there is one reserve row. A 409 parks the world and a 401 releases the reservation. A synthetic recorded-response set replays submit, track, exports and import through to `ready`. The owner has a recorder for the morning's paid run, and it refuses to run without the live flags.

## Tasks

| Task | Commit | What |
|------|--------|------|
| 1 | 8de1426 | `startPipeline({ provider })` factory option (mock stays the default, `.calls` typing kept for existing callers); echo3-contract.pg.test.ts with happy path, V2 crash, V3 concurrent, V4 drop/timeout/429+503/409/401 |
| 2 | b96632b | fake-echo3 `replaySet`; `manifest.json` (`synthetic: true`); replay test; `scrubRecorded` unit tests; `scripts/record-echo3-run.ts`; `npm run record:echo3` |

## Contract coverage (all against echo3.ts → fake on 127.0.0.1)

| Case | Result |
|------|--------|
| happy | 1 submit, billed 1, ready, ledger `[reserve]` |
| V2 kill mid-submit | the fake accepts, the worker never returns (job stays `running`, `locked_by` the dead worker, payload `{uncertain:false, sending:true}`, no `provider_request_id`). The lease expires, another worker resumes: 2 submits, same key + body, billed 1, `providerRequestId` = the first accept's id |
| V3 concurrent | two `handleSubmit` on one claimed job via `Promise.allSettled`, both fulfilled: billed 1, one reserve row, one track job |
| V4 drop-after-accept | 2 submits, billed 1, ready, reservation never released |
| V4 timeout (`timeouts.submit = 300`) | 2 submits, billed 1, ready |
| V4 429 → 503 → accept | 3 submits, one key, billed 1, ready |
| V4 409 | failed/submit `IDEMPOTENCY_KEY_REUSED`, submit job `dead`, key unchanged, ledger `[reserve]`, no new billing |
| V4 401 | 1 submit, failed/submit `PROVIDER_AUTH`, ledger `[reserve, release]`, billed 0 |
| replay | `splat.spz`, `collider.ply`, `floorplan.png`, `floorplan.json`, `cameras.json` re-hosted under `worlds/<id>/v<n>/`; `floorplanMeta` deep-equals the manifest's floorplan block; mesh export started once from NOT_REQUESTED |

Every provider request goes through a recording `fetch`, and each case asserts that every host was `127.0.0.1` or `localhost`.

## Verification

- `npx tsc --noEmit`: clean. The backend tsconfig only includes `src/`, so the new test and script files were also type-checked with a scratch tsconfig that extends it (clean).
- `npx vitest run`: 481 passed, 153 skipped (pg-gated). The `scrubRecorded` cases run here without a DB.
- `npm run test:pg -- test/integration/echo3-contract.pg.test.ts test/integration/scenarios.pg.test.ts`: 2 files, 35 passed (echo3-contract: 15 tests = 9 pg cases + 6 DB-free scrub cases; scenarios: 20, unchanged)
- Recorder refusal: `env -u PROVIDER_MODE -u ALLOW_PAID_PROVIDER node --import tsx scripts/record-echo3-run.ts 00000000-0000-0000-0000-000000000000` printed `[record:echo3] refused: owner-only, paid session (needs PROVIDER_MODE=live and ALLOW_PAID_PROVIDER=1)` and exited 1, before any DB, R2 or network access. No env file was loaded.
- Zero SpAItial calls. PROVIDER_MODE and ALLOW_PAID_PROVIDER were never set. The manifest contains no `http(s)://`, `X-Amz` or `spt_live_`.

## Deviations from Plan

**1. [Rule 1 - test fidelity] The crash is simulated with a never-settling call instead of a thrown LeaseLostError**
- **Found during:** Task 1, on the first run. The log showed `retry in 60s: submit outcome uncertain (network)` for the crash case.
- **Issue:** `handleSubmit` wraps `provider.submit` in a catch that classifies any non-ProviderError as an uncertain outcome. So a `LeaseLostError` thrown from the submit wrapper turns into `RetryLaterError`, and the job is unlocked and requeued. That tests the retry path, not a crash, and the "expire the lease" step does nothing. This is not a production bug: the real provider never throws LeaseLostError, and a real crash leaves the job locked.
- **Fix:** the crashed run is `void handleSubmit(...)` on a claimed job, with a provider call that never settles after the fake accepted. The test asserts the real crash state (job `running`, locked by the dead worker, `sending: true`, no request id) before it expires the lease and resumes.
- **Note:** 06-04's `scenarios.pg.test.ts` "V5: kill mid-submit" still uses the throw pattern, so it really exercises an uncertain retry. It passes, but its "crash" label overstates what it tests. That file is outside this plan's files and I did not change it. Suggested follow-up: switch it to the same never-settling pattern.

No double-charge bug was found in `src/`. Every scenario billed exactly once on the first run.

## Known Stubs

- `backend/test/fixtures/echo3-recorded/manifest.json` is `synthetic: true` by design (D-07). The owner replaces it with `npm run record:echo3 <worldId>` after the first paid run.

## Self-Check: PASSED

- FOUND: backend/test/integration/echo3-contract.pg.test.ts, backend/test/fixtures/echo3-recorded/manifest.json, backend/scripts/record-echo3-run.ts
- FOUND commits: 8de1426, b96632b
