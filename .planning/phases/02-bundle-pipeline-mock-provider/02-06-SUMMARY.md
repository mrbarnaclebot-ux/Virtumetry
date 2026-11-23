---
phase: 02-bundle-pipeline-mock-provider
plan: 06
subsystem: backend/webhooks
tags: [webhook, hmac, dedupe, polling, mock-provider]
requires: [02-04 verifyWebhookSignature/signWebhook, 02-02 webhook_deliveries + jobs schema, 02-05 startPipeline harness + track snooze]
provides: [POST /v1/webhooks/spaitial (webhookRoutes), webhook pg scenarios duplicate_webhooks / webhook_dropped]
affects: [backend/src/routes/index.ts]
tech-stack:
  added: []
  patterns: [scoped raw-buffer content-type parser, nudge-only webhook (run_after = now()), ON CONFLICT DO NOTHING dedupe]
key-files:
  created: [backend/src/routes/webhooks.ts, backend/test/webhooks.test.ts, backend/test/integration/webhooks.pg.test.ts]
  modified: [backend/src/routes/index.ts]
decisions:
  - "Webhook route never parses the body and never writes worlds; it only pulls the queued track job's run_after to now()"
  - "Unknown request id with a valid signature still records the delivery (200) and nudges nothing"
metrics:
  duration: ~25 min
  completed: 2026-11-23
  tasks: 2
  files: 4
requirements-completed: [PROC-06]  # PROC-10 finishes with 02-07 (FAILED/402/409/429/503 scenarios)
---

# Phase 2 Plan 06: Webhook route (HMAC, dedupe, nudge) Summary

POST /v1/webhooks/spaitial checks the HMAC over the exact raw bytes with the existing constant-time `verifyWebhookSignature` before it touches the DB, and fails closed when the secret is unset. It dedupes on `delivery_id` with `ON CONFLICT DO NOTHING` and only moves the world's queued track job forward. Real-Postgres tests cover valid, forged and duplicate deliveries, the nudge (polling set to an hour), duplicate_webhooks and webhook_dropped.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Webhook route: scoped raw parser, verify, dedupe, nudge-only, plus unit tests | 1ef1532 |
| 2 | Real-Postgres webhook tests (a)-(d) | 1ef4988 |

## Verification

- `npx tsc --noEmit`: clean
- `npx vitest run`: 32 files passed, 6 skipped; 293 tests passed, 31 skipped
- `node --env-file=.env scripts/test-pg.mjs` (full PG run): 5 files passed, 1 skipped; 30 tests passed, 1 skipped
- `webhooks.pg.test.ts`: 4/4 passed, none skipped
- Acceptance greps: no `UPDATE worlds` / `update(worlds)`, no `JSON.parse`, one `removeAllContentTypeParsers`, `verifyWebhookSignature` used, and `webhookRoutes` registered in `routes/index.ts`

## Deviations from Plan

**1. [Rule 3 - Blocking] The nudge tests also pull the job forward once while it is in 'importing'**
- **Found during:** Task 2
- **Issue:** The mock's `mesh-simplified` export returns `pending` on its first poll, so `handleTrack` snoozes again for `TRACK_POLL_SECONDS`, this time in `importing`. With `trackPollSeconds: 3600`, nothing sends a webhook for that wait, so (b) and (c) could never reach ready within the test timeout.
- **Fix (test only; `src/pipeline.ts` belongs to 02-07):** The test runs jobs until the track job has snoozed for the hour while the world is still `processing`. It then shows the webhook alone moves the world to `importing`. After that it does `UPDATE jobs SET run_after = now()` to stand in for the next regular poll, and drains to `ready`. The nudge proof is stricter than "drain within 15 s" because it checks that track was really snoozed before the webhook arrived.
- **Also:** (b) and (c) use `processingSeconds: 3` instead of 1, so the webhook can't arrive before the first poll (the race would make the test pass without the nudge). Drain timeouts are 60 s, since Neon dev round trips take about 20 s end to end.
- **Note for orchestrator:** In production the export-pending wait uses the normal poll interval (30-60 s in practice), so this isn't a pipeline bug. If faster "ready" after a webhook matters, the export-pending snooze could use a shorter interval later.

**2. [Process] TDD order:** the route and its unit tests were written in one pass, so there is no separate RED commit. The fail-closed unit test did fail at first, but because of a bug in the test itself (a default parameter swallowed `undefined`). That bug was fixed before the commit.

## Threat Flags

None. The new surface (an unauthenticated webhook endpoint) is the one modelled as T-02-28..33, and every mitigation is in place: HMAC before any DB access, delivery-id PK dedupe, per-IP rate limit, 256 KiB body limit, no writes to worlds, raw buffer never parsed, fixed error codes with no secret in responses, and logs that carry only the delivery id and event.

## Known Stubs

None. The webhook URL is not registered with SpAItial yet (Phase 6, as planned).

## Self-Check: PASSED

- FOUND: backend/src/routes/webhooks.ts, backend/test/webhooks.test.ts, backend/test/integration/webhooks.pg.test.ts
- FOUND commits: 1ef1532, 1ef4988
