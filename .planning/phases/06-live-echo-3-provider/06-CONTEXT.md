# Phase 6: Live Echo-3 Provider - Context

**Gathered:** 2026-11-25
**Status:** Ready for planning
**Mode:** --auto (owner asleep: "keep building up to phase 6 so I can test it in the morning"; every grey area auto-resolved with the recommended option, logged in 06-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

The backend gains a real Echo-3 provider (`backend/src/provider/echo3.ts`) behind the existing `ReconProvider` interface, so an approved scan can be processed by SpAItial exactly once, inside the daily/monthly budget. A failed scan offers a **Retry** only when the failure is retryable, and retry requires a fresh explicit cost approval (new quote, new submission key). The owner is alerted when spend crosses a configured share of the daily or monthly budget. The first real paid run is prepared as a **runbook for the owner** (06-HUMAN-UAT.md), not executed by agents.

Requirements: PROC-05, LIB-02, OPS-06. Out of scope: native ARKit capture (Phase 8), real APNs push (Phase 7), retention/purge (Phase 9), any production change.

**HARD MONEY RULE (non-negotiable, applies to every plan and every agent):** zero network calls to SpAItial / `api.spaitial.ai` (not even free quote/limits/status). `ALLOW_PAID_PROVIDER` and `PROVIDER_MODE=live` are never set anywhere (local `.env`, Railway dev, Railway prod, CI). All live-client behaviour is proven against an HTTP-level fake (local `node:http` server or injected `fetch`) and the mock provider.

</domain>

<decisions>
## Implementation Decisions

### Live client (PROC-05)
- **D-01:** `backend/src/provider/echo3.ts` implements `ReconProvider` with Node 24 `fetch` (no SDK, no new dependency). Constructor takes `{ apiKey, baseUrl, webhookSecret, fetch? }`; `fetch` is injectable for tests. Every call has an `AbortSignal.timeout` (submit generous, e.g. 60 s; others 30 s) and maps failures to `ProviderError { status, code, endpoint, retryAfterS }` / `ProviderTimeoutError`. The client **never retries internally**; retry policy stays in `pipeline.ts` (already built in Phase 2, D-17).
- **D-02:** Endpoints per SpAItial docs (researcher re-verifies exact paths/fields from docs.spaitial.ai via WebFetch, no API calls): `GET /v1/captures/limits` (cached in-process ~1 h), `GET /v1/captures/process-quote?model=echo-3&frame_count=N` → `required_credits` / `available_credits`, `POST /v1/worlds` with `Idempotency-Key` header and the **exact persisted body string** (byte-identical; client sends `body` as given, never re-serializes), `202 → request_id`, `GET /v1/worlds/requests/{id}/status`, `GET /v1/worlds/requests/{id}` (envelope with world asset URLs + validation issues), export `POST/GET /v1/worlds/requests/{id}/exports/{mesh-simplified|floorplan}`, artifact download following 302 to short-lived URLs (resolved fresh in `open()`), cancel, delete. Error envelope `{ error: { code, message, details } }` → `ProviderError.code`. `Retry-After` parsed (seconds or HTTP date).
- **D-03:** Artifact mapping must match what the importer expects (`splat`, `collider`, `floorplan`, `floorplan_meta`, `cameras`, optional `thumbnail`) with the same names the mock uses, so `handleTrack` needs no change. Splat format stays `spz` (submit body already sets `output_format: 'spz'`); the viewer (Phase 5) loads SPZ.
- **D-04:** New env (zod, `config.ts`): `SPAITIAL_BASE_URL` (default the documented production base URL, https only), keep `SPAITIAL_API_KEY` / `SPAITIAL_WEBHOOK_SECRET`. `createProvider` builds the live client only when `PROVIDER_MODE=live` (already refused unless `ALLOW_PAID_PROVIDER=1`) **and** additionally requires `SPAITIAL_API_KEY` and `SPAITIAL_WEBHOOK_SECRET` to be set (boot refuses otherwise). API key is sent only as the documented auth header and never logged; logs carry request ids and codes only.
- **D-05:** Idempotency retention window is undocumented → keep the Phase 2 cap (4 attempts, ≤15 min backoff) so every automatic resubmit with the same key happens well within an hour. Recorded as an owner question for SpAItial in the runbook.

### Exactly-once proof (success criterion 1)
- **D-06:** Contract tests run the **real `handleSubmit` against `echo3.ts` pointed at a local fake Echo-3 HTTP server** (`backend/test/helpers/fake-echo3.ts`) that implements documented semantics: same key + same body → replay original 202 with the same `request_id`; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`; configurable 429/503/500/timeout/drop-after-accept responses; counts how many *distinct worlds* it "billed". Scenarios: crash after the fake accepted but before `provider_request_id` was saved (resume → same key + same body → same request id, billed count 1); two workers racing the same world (lease + key → billed count 1); timeout then retry (billed 1); 409 parks without minting a key. Pg suites against Neon dev where the DB is involved.
- **D-07:** Fixture replay: the fake server can serve a **recorded-response set** (status sequence, envelope, export responses, artifact bytes) from `backend/test/fixtures/echo3-recorded/`. Tonight that set is **hand-written from the documented shapes** (marked `synthetic: true` in its manifest). The morning paid run adds a script (`backend/scripts/record-echo3-run.ts`) that, given a ready world id, copies the scrubbed JSON responses (no presigned URLs, no keys) and the re-hosted output object list into a recorded set; large binary outputs stay in R2 dev (`fixtures/echo3-run-1/…`), never committed (public repo). A replay test asserts the full submit → track → import → ready path against the set.

### Retry (LIB-02, success criterion 3)
- **D-08:** Retryability is decided **server-side** by one pure function `isRetryable(failure_stage, failure_code)` in the backend, exposed on the world payload as `retryable: boolean`. Retryable (a new paid attempt can plausibly succeed and the old attempt provably did not leave an unknown charge): submit-stage `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `BUDGET_EXCEEDED`, `QUOTE_ABOVE_APPROVAL`, `HTTP_402` (insufficient credits, after top-up); processing-stage provider `FAILED` whose code is **not** a bundle/validation code (`ZIP_*`, `IMAGE_*`, `EXIF_*`, `TRAJECTORY_*`, `MATRIX_*`, `ROTATION_*`, `*INTRINSICS*`, `CAMERA_FILE_*`, `CAPTURE_*`) — i.e. provider-side/internal errors. **Not retryable**: validate/pack/upload-stage failures (re-paying for a bad capture wastes money — rescan instead), validation-code processing failures, `SUBMIT_UNCERTAIN`, `IDEMPOTENCY_KEY_REUSED` (may already be billed — needs human check), import-stage failures (credits already spent; re-import is an ops action), `cancelled`, deleted worlds. Unknown codes default to **not retryable**.
- **D-09:** `POST /v1/worlds/:id/retry { approved_max_credits }` (auth, owner-only 404, Idempotency-Key header like other creates, rate-limited with the create bucket): refuses unless `status='failed'` and retryable; re-quotes via the provider; refuses if `approved_max_credits < quote`; then in **one transaction** with a conditional update (`WHERE status='failed' AND failure_*` unchanged) archives the previous attempt and resets `submission_key`, `submit_body`, `provider_request_id`, `quoted_credits`, failure columns, sets `approved_max_credits` to the new approval, increments a new `submit_attempt` integer, flips status to `submitting` (bundle still present) or `packing` (bundle gone), and enqueues the job. Two concurrent retries → exactly one wins (the other gets 409 `not_retryable`/replay). The old reservation is untouched (released or kept exactly as Phase 2 decided). A new `submission_key` is minted only here — the pipeline still never mints a second key on its own.
- **D-10:** Previous attempts are kept for audit in a small append-only `world_attempts` table (world_id, attempt, submission_key, provider_request_id, failure_stage, failure_code, quoted_credits, created_at) written by the retry transaction. Migration via `drizzle-kit generate` + `src/migrate.ts` against the Neon **dev** branch only; never `drizzle-kit push`.
- **D-11:** App: the failed state (world screen / failed row action, wherever the failed scan currently renders its reason) shows **Retry** only when `retryable` is true. Tapping it opens the same cost-approval pattern as the capture review screen (fresh `GET /v1/quote?frames=N`, "~N credits ≈ $X", budget check, explicit "Approve and retry" button; Cancel does nothing). The approval call is `POST /v1/worlds/:id/retry`. Non-retryable failures show the reason plus "Scan again" guidance, never a retry button. Expo Go testable with the mock provider (`MOCK_SCENARIO` that yields a retryable failure). Visuals per 06-UI-SPEC.md.

### Budget alerts (OPS-06, success criterion 4)
- **D-12:** New env `BUDGET_ALERT_SHARE` (default `0.8`, 0 < x ≤ 1). After every successful `reserveCredits` (inside or right after the reservation tx), compute the window totals; if the daily or monthly total crosses `share × budget`, insert into a `budget_alerts` table with a unique key `(provider_mode, window, window_start)` so each window alerts **once**. A new insert triggers: a structured `console.warn('[budget-alert] …')` (Railway logs), a `sendPush` call to the owner(s) (still the stub — real APNs is Phase 7, so this becomes a real notification then with zero change), and the alert is surfaced in-app.
- **D-13:** In-app surfacing: `GET /v1/quote` (and the capture config/library data the app already polls, whichever is lighter) returns `budgetAlert: { window, share, spent, budget } | null` for the current windows; the Library shows a dismissible-per-session banner ("You've used 82% of today's processing budget"). Mock spend and live spend are separate (provider_mode), as today.

### Live run preparation (success criterion 2)
- **D-14:** Agents do **not** perform the paid run. 06-HUMAN-UAT.md contains a runbook: exact Railway **dev** variables to set (`PROVIDER_MODE=live`, `ALLOW_PAID_PROVIDER=1`, `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET`, tight `DAILY_CREDIT_BUDGET`/`MONTHLY_CREDIT_BUDGET` just above one run, `BUDGET_ALERT_SHARE`), the input bundle, expected cost (900 + frames credits; minimum frames ≈ lowest cost), how to watch (worker logs, world status, webhook deliveries table), how to verify exactly-once (one `request_id`, one reserve row, webhook delivery rows deduped), how to abort (cancel endpoint / delete world → provider cancel; failed/cancelled = 0 credits), and how to revert to mock (unset the vars, redeploy). Production is never touched.
- **D-15:** Input choice is the owner's. Recommendation recorded in the runbook: the Phase 4/5 **synthetic fixture room is a bad paid input** (rendered/synthetic frames may fail validation or reconstruct as garbage — ~$9–18 wasted). Prefer a **minimum-frame bundle converted from a real public posed capture** (e.g. SpAItial's capture-prototype sample if it meets min frames, or a small public ARKit-style dataset) uploaded through the existing scan pipeline, or **wait for Phase 8 real ARKit capture** and run the first paid world on the owner's own room. The researcher states Echo-3's min/max frame limits and what public sample is realistic.

### Deploy
- **D-16:** The Phase 6 code deploys to Railway **dev** in mock mode only (`railway up -s <svc> -e dev --ci`), migrations applied by the existing deploy migrate step. New env values (`BUDGET_ALERT_SHARE`, `SPAITIAL_BASE_URL`) get safe defaults so no variable change is required on dev. Production untouched. No `eas build`.

### Claude's Discretion
- Exact fake-server implementation (node:http vs injected fetch), module split inside `echo3.ts`, wording of failure reasons, the mock scenario name for a retryable failure, banner dismissal storage.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and rules
- `.planning/ROADMAP.md` §"Phase 6: Live Echo-3 Provider" — goal, success criteria
- `.planning/REQUIREMENTS.md` — PROC-05, LIB-02, OPS-06 (and PROC-06/07/08 already complete)
- `CLAUDE.md` — money constraints, stack, webhook rules
- `virtumetry/AGENTS.md` — Expo rules, EAS quota rules (never `eas build`)

### Echo-3 API (already researched in Phase 2; re-verify, do not call the API)
- `.planning/phases/02-bundle-pipeline-mock-provider/02-RESEARCH.md` §Echo-3 API facts (lines ~111-200) — endpoints, Idempotency-Key semantics, 202 shape, status enum, exports, webhook headers/body, error envelope, rate limits
- `.planning/research/ARCHITECTURE.md` §"Echo-3 Job State Machine" and integration table — submit/track flow
- `.planning/research/PITFALLS.md` — double-charge pitfalls, reconciliation, openapi drift
- https://docs.spaitial.ai (`/api/worlds.md`, `/api/capture-worlds.md`, `/api/exports.md`, `/api/webhooks.md`, `/api/errors.md`, `/api/rate-limits.md`, `llms.txt`) — read-only via WebFetch

### Prior-phase decisions
- `.planning/phases/02-bundle-pipeline-mock-provider/02-CONTEXT.md` — D-11 provider interface, D-15 statuses, D-17 submit state machine, D-18 budget, D-20 webhooks
- `.planning/phases/04-0-capture-to-world-loop/04-CONTEXT.md` — cost approval UI, quote route
- `.planning/phases/05-viewer-floor-plan-measure-share/05-CONTEXT.md` — demo-room outputs set, viewer format expectations

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `backend/src/provider/types.ts`: `ReconProvider`, `ProviderError` (status/code/retryAfterS), `ProviderTimeoutError`, `signWebhook`/`verifyWebhookSignature` (constant-time) — echo3.ts reuses all of these.
- `backend/src/provider/mock.ts`: reference implementation + artifact naming; `MOCK_SCENARIO` list in `config.ts` to extend with a retryable-failure scenario.
- `backend/src/pipeline.ts`: `handleSubmit` already persists key + exact body before spend, reserves budget, classifies 400/402/403/409/429/503/5xx/timeout, sticky "uncertain" marker, revives submit-failed world on late success; `handleTrack` imports outputs. Phase 6 should need little or no change here.
- `backend/src/budget.ts`: `reserveCredits` (advisory-locked), `spentCredits`, `releaseCredits` — alert hook attaches here.
- `backend/src/routes/webhooks.ts`: HMAC + dedupe + nudge already done (PROC-06 complete).
- `backend/src/routes/scans.ts` `GET /v1/quote`: budget fields; add `budgetAlert`.
- `backend/src/push.ts`: `sendPush` stub.
- App: `virtumetry/src/app/capture/[id].tsx` approve mutation + quote card (pattern for retry approval); `virtumetry/src/library/display-state.ts` failure text; `virtumetry/src/lib/api.ts` client.

### Established Patterns
- Persist-before-spend, conditional status flips (`WHERE status = …`), enqueue inside the same tx.
- Tests: vitest unit + `test/integration/*.pg.test.ts` against Neon dev; app jest-expo + RNTL.
- Migrations: drizzle-kit generate + guard scripts; `node --env-file=.env`.

### Integration Points
- `createProvider(config)` in `backend/src/provider/index.ts` (currently throws for live).
- World payload serializer in `backend/src/routes/worlds.ts` (add `retryable`, `submit_attempt`).
- Library + world screen in the app for Retry and the budget banner.

</code_context>

<specifics>
## Specific Ideas

- The owner wants to test in the morning: everything $0 must be testable in Expo Go against Railway dev (mock), and the paid run must be a copy-paste runbook with an abort path.
- Synthetic fixture room is probably a waste of money as a paid input — say so plainly.

</specifics>

<deferred>
## Deferred Ideas

- Daily reconciliation of ledger vs SpAItial `available_credits` and weekly openapi.json drift CI (PITFALLS) — later ops phase.
- Free "re-import" retry for import-stage failures (no new spend) — ops action for now.
- Real push delivery of budget alerts — Phase 7 (APNs) makes the existing `sendPush` call real.
- `.RAD` LoD pre-build of real Echo-3 outputs — revisit if real SPZ is choppy.

</deferred>

---

*Phase: 06-live-echo-3-provider*
*Context gathered: 2026-11-25*
