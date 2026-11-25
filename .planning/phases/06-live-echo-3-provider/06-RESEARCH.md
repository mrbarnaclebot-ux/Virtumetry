# Phase 6: Live Echo-3 Provider - Research

**Researched:** 2026-11-25
**Domain:** Paid third-party REST integration (SpAItial Echo-3), exactly-once submit, retry state machine, budget alerting
**Confidence:** HIGH for codebase findings and documented API shapes; MEDIUM for undocumented API edges (export enum, envelope details, idempotency window)

**HARD MONEY RULE honoured:** no request was sent to `api.spaitial.ai`. Only `docs.spaitial.ai` pages and GitHub/web pages were read. The OpenAPI spec lives at `https://api.spaitial.ai/v1/openapi.json`, which is on the forbidden host, so it was **not** fetched. Anything that only the spec could confirm is marked `[ASSUMED]` below.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**HARD MONEY RULE (non-negotiable, applies to every plan and every agent):** zero network calls to SpAItial / `api.spaitial.ai` (not even free quote/limits/status). `ALLOW_PAID_PROVIDER` and `PROVIDER_MODE=live` are never set anywhere (local `.env`, Railway dev, Railway prod, CI). All live-client behaviour is proven against an HTTP-level fake (local `node:http` server or injected `fetch`) and the mock provider.

#### Live client (PROC-05)
- **D-01:** `backend/src/provider/echo3.ts` implements `ReconProvider` with Node 24 `fetch` (no SDK, no new dependency). Constructor takes `{ apiKey, baseUrl, webhookSecret, fetch? }`; `fetch` is injectable for tests. Every call has an `AbortSignal.timeout` (submit generous, e.g. 60 s; others 30 s) and maps failures to `ProviderError { status, code, endpoint, retryAfterS }` / `ProviderTimeoutError`. The client **never retries internally**; retry policy stays in `pipeline.ts` (already built in Phase 2, D-17).
- **D-02:** Endpoints per SpAItial docs (researcher re-verifies exact paths/fields from docs.spaitial.ai via WebFetch, no API calls): `GET /v1/captures/limits` (cached in-process ~1 h), `GET /v1/captures/process-quote?model=echo-3&frame_count=N` → `required_credits` / `available_credits`, `POST /v1/worlds` with `Idempotency-Key` header and the **exact persisted body string** (byte-identical; client sends `body` as given, never re-serializes), `202 → request_id`, `GET /v1/worlds/requests/{id}/status`, `GET /v1/worlds/requests/{id}` (envelope with world asset URLs + validation issues), export `POST/GET /v1/worlds/requests/{id}/exports/{mesh-simplified|floorplan}`, artifact download following 302 to short-lived URLs (resolved fresh in `open()`), cancel, delete. Error envelope `{ error: { code, message, details } }` → `ProviderError.code`. `Retry-After` parsed (seconds or HTTP date).
- **D-03:** Artifact mapping must match what the importer expects (`splat`, `collider`, `floorplan`, `floorplan_meta`, `cameras`, optional `thumbnail`) with the same names the mock uses, so `handleTrack` needs no change. Splat format stays `spz` (submit body already sets `output_format: 'spz'`); the viewer (Phase 5) loads SPZ.
- **D-04:** New env (zod, `config.ts`): `SPAITIAL_BASE_URL` (default the documented production base URL, https only), keep `SPAITIAL_API_KEY` / `SPAITIAL_WEBHOOK_SECRET`. `createProvider` builds the live client only when `PROVIDER_MODE=live` (already refused unless `ALLOW_PAID_PROVIDER=1`) **and** additionally requires `SPAITIAL_API_KEY` and `SPAITIAL_WEBHOOK_SECRET` to be set (boot refuses otherwise). API key is sent only as the documented auth header and never logged; logs carry request ids and codes only.
- **D-05:** Idempotency retention window is undocumented → keep the Phase 2 cap (4 attempts, ≤15 min backoff) so every automatic resubmit with the same key happens well within an hour. Recorded as an owner question for SpAItial in the runbook.

#### Exactly-once proof (success criterion 1)
- **D-06:** Contract tests run the **real `handleSubmit` against `echo3.ts` pointed at a local fake Echo-3 HTTP server** (`backend/test/helpers/fake-echo3.ts`) that implements documented semantics: same key + same body → replay original 202 with the same `request_id`; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`; configurable 429/503/500/timeout/drop-after-accept responses; counts how many *distinct worlds* it "billed". Scenarios: crash after the fake accepted but before `provider_request_id` was saved (resume → same key + same body → same request id, billed count 1); two workers racing the same world (lease + key → billed count 1); timeout then retry (billed 1); 409 parks without minting a key. Pg suites against Neon dev where the DB is involved.
- **D-07:** Fixture replay: the fake server can serve a **recorded-response set** (status sequence, envelope, export responses, artifact bytes) from `backend/test/fixtures/echo3-recorded/`. Tonight that set is **hand-written from the documented shapes** (marked `synthetic: true` in its manifest). The morning paid run adds a script (`backend/scripts/record-echo3-run.ts`) that, given a ready world id, copies the scrubbed JSON responses (no presigned URLs, no keys) and the re-hosted output object list into a recorded set; large binary outputs stay in R2 dev (`fixtures/echo3-run-1/…`), never committed (public repo). A replay test asserts the full submit → track → import → ready path against the set.

#### Retry (LIB-02, success criterion 3)
- **D-08:** Retryability is decided **server-side** by one pure function `isRetryable(failure_stage, failure_code)` in the backend, exposed on the world payload as `retryable: boolean`. Retryable (a new paid attempt can plausibly succeed and the old attempt provably did not leave an unknown charge): submit-stage `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `BUDGET_EXCEEDED`, `QUOTE_ABOVE_APPROVAL`, `HTTP_402` (insufficient credits, after top-up); processing-stage provider `FAILED` whose code is **not** a bundle/validation code (`ZIP_*`, `IMAGE_*`, `EXIF_*`, `TRAJECTORY_*`, `MATRIX_*`, `ROTATION_*`, `*INTRINSICS*`, `CAMERA_FILE_*`, `CAPTURE_*`) — i.e. provider-side/internal errors. **Not retryable**: validate/pack/upload-stage failures (re-paying for a bad capture wastes money — rescan instead), validation-code processing failures, `SUBMIT_UNCERTAIN`, `IDEMPOTENCY_KEY_REUSED` (may already be billed — needs human check), import-stage failures (credits already spent; re-import is an ops action), `cancelled`, deleted worlds. Unknown codes default to **not retryable**.
- **D-09:** `POST /v1/worlds/:id/retry { approved_max_credits }` (auth, owner-only 404, Idempotency-Key header like other creates, rate-limited with the create bucket): refuses unless `status='failed'` and retryable; re-quotes via the provider; refuses if `approved_max_credits < quote`; then in **one transaction** with a conditional update (`WHERE status='failed' AND failure_*` unchanged) archives the previous attempt and resets `submission_key`, `submit_body`, `provider_request_id`, `quoted_credits`, failure columns, sets `approved_max_credits` to the new approval, increments a new `submit_attempt` integer, flips status to `submitting` (bundle still present) or `packing` (bundle gone), and enqueues the job. Two concurrent retries → exactly one wins (the other gets 409 `not_retryable`/replay). The old reservation is untouched (released or kept exactly as Phase 2 decided). A new `submission_key` is minted only here — the pipeline still never mints a second key on its own.
- **D-10:** Previous attempts are kept for audit in a small append-only `world_attempts` table (world_id, attempt, submission_key, provider_request_id, failure_stage, failure_code, quoted_credits, created_at) written by the retry transaction. Migration via `drizzle-kit generate` + `src/migrate.ts` against the Neon **dev** branch only; never `drizzle-kit push`.
- **D-11:** App: the failed state (world screen / failed row action, wherever the failed scan currently renders its reason) shows **Retry** only when `retryable` is true. Tapping it opens the same cost-approval pattern as the capture review screen (fresh `GET /v1/quote?frames=N`, "~N credits ≈ $X", budget check, explicit "Approve and retry" button; Cancel does nothing). The approval call is `POST /v1/worlds/:id/retry`. Non-retryable failures show the reason plus "Scan again" guidance, never a retry button. Expo Go testable with the mock provider (`MOCK_SCENARIO` that yields a retryable failure). Visuals per 06-UI-SPEC.md.

#### Budget alerts (OPS-06, success criterion 4)
- **D-12:** New env `BUDGET_ALERT_SHARE` (default `0.8`, 0 < x ≤ 1). After every successful `reserveCredits` (inside or right after the reservation tx), compute the window totals; if the daily or monthly total crosses `share × budget`, insert into a `budget_alerts` table with a unique key `(provider_mode, window, window_start)` so each window alerts **once**. A new insert triggers: a structured `console.warn('[budget-alert] …')` (Railway logs), a `sendPush` call to the owner(s) (still the stub — real APNs is Phase 7, so this becomes a real notification then with zero change), and the alert is surfaced in-app.
- **D-13:** In-app surfacing: `GET /v1/quote` (and the capture config/library data the app already polls, whichever is lighter) returns `budgetAlert: { window, share, spent, budget } | null` for the current windows; the Library shows a dismissible-per-session banner ("You've used 82% of today's processing budget"). Mock spend and live spend are separate (provider_mode), as today.

#### Live run preparation (success criterion 2)
- **D-14:** Agents do **not** perform the paid run. 06-HUMAN-UAT.md contains a runbook: exact Railway **dev** variables to set (`PROVIDER_MODE=live`, `ALLOW_PAID_PROVIDER=1`, `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET`, tight `DAILY_CREDIT_BUDGET`/`MONTHLY_CREDIT_BUDGET` just above one run, `BUDGET_ALERT_SHARE`), the input bundle, expected cost (900 + frames credits; minimum frames ≈ lowest cost), how to watch (worker logs, world status, webhook deliveries table), how to verify exactly-once (one `request_id`, one reserve row, webhook delivery rows deduped), how to abort (cancel endpoint / delete world → provider cancel; failed/cancelled = 0 credits), and how to revert to mock (unset the vars, redeploy). Production is never touched.
- **D-15:** Input choice is the owner's. Recommendation recorded in the runbook: the Phase 4/5 **synthetic fixture room is a bad paid input** (rendered/synthetic frames may fail validation or reconstruct as garbage — ~$9–18 wasted). Prefer a **minimum-frame bundle converted from a real public posed capture** (e.g. SpAItial's capture-prototype sample if it meets min frames, or a small public ARKit-style dataset) uploaded through the existing scan pipeline, or **wait for Phase 8 real ARKit capture** and run the first paid world on the owner's own room. The researcher states Echo-3's min/max frame limits and what public sample is realistic.

#### Deploy
- **D-16:** The Phase 6 code deploys to Railway **dev** in mock mode only (`railway up -s <svc> -e dev --ci`), migrations applied by the existing deploy migrate step. New env values (`BUDGET_ALERT_SHARE`, `SPAITIAL_BASE_URL`) get safe defaults so no variable change is required on dev. Production untouched. No `eas build`.

### Claude's Discretion
- Exact fake-server implementation (node:http vs injected fetch), module split inside `echo3.ts`, wording of failure reasons, the mock scenario name for a retryable failure, banner dismissal storage.

### Deferred Ideas (OUT OF SCOPE)
- Daily reconciliation of ledger vs SpAItial `available_credits` and weekly openapi.json drift CI (PITFALLS) — later ops phase.
- Free "re-import" retry for import-stage failures (no new spend) — ops action for now.
- Real push delivery of budget alerts — Phase 7 (APNs) makes the existing `sendPush` call real.
- `.RAD` LoD pre-build of real Echo-3 outputs — revisit if real SPZ is choppy.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROC-05 | At most one submit per approved scan; key and exact body saved before the call; a retry after failure needs new explicit owner approval | §Echo-3 API Contract, Pattern 1 (echo3.ts), Pattern 2 (fake server), Pitfalls 1-6, Validation tests V1-V6 |
| LIB-02 | Owner can retry a failed scan only when the failure is retryable, after re-confirming the cost | Pattern 3 (isRetryable + ledger guard), Pattern 4 (retry route tx), Pitfalls 7-9, app tests V10-V12 |
| OPS-06 | Owner is alerted when spend reaches a set share of the budget | Pattern 5 (alert inside reserve tx), Pitfall 10, tests V8-V9 |
</phase_requirements>

## Summary

The codebase already has most of the exactly-once machinery. `handleSubmit` persists the key and body before spending, reserves the budget under an advisory lock, classifies provider errors, keeps a sticky "uncertain" marker, and revives a world when a late success arrives. So Phase 6 is mostly about **adding things**: `echo3.ts` (about 250 lines of `fetch`), a fake Echo-3 HTTP server for tests, one migration (`worlds.submit_attempt`, `world_attempts`, `budget_alerts`), a retry route, an alert hook inside `reserveCredits`, and the app's retry sheet and banner. No new npm packages are needed.

The SpAItial docs confirm the Phase 2 contract (base `https://api.spaitial.ai`, `Authorization: Bearer spt_live_…`, the endpoints, 202 + `request_id`, the error envelope, the 409 semantics, `Retry-After` in seconds). They add three facts that matter here:
1. **Failed and cancelled jobs refund automatically.** Async validation failures are `FAILED` with 0 credits.
2. **There is no sandbox or test key.** Every key is `spt_live_`.
3. **The idempotency retention window is undocumented.**

The research found four **correctness gaps in the existing code** that the plan must fix:
1. A `401` (and other non-409 4xx codes) is treated as "uncertain" and burns 4 attempts before `SUBMIT_UNCERTAIN`.
2. A 400/402/403 that follows an uncertain attempt is failed with a code D-08 lists as retryable (e.g. `INSUFFICIENT_CREDITS`) while the reservation is still held. A retry would then mint a new key while the first request may exist and be billed. The retry route therefore needs a ledger guard.
3. `purge` will FK-fail once `world_attempts` exists. It also never asks SpAItial to delete archived attempts' requests.
4. A failing optional thumbnail download would loop `handleTrack` forever.

On cost: Echo-3 costs **900 + frames credits ($9 + $0.01/frame)**. The base fee dominates, so a "minimum-frame" run saves almost nothing. 30 frames = $9.30, 300 frames = $12.00. The capture-prototype sample is 3 flat placeholder frames that SpAItial says "can't be reconstructed". The committed TUM fixture is 30 frames of a flat textured floor at 640×480, which is not a room. The honest recommendation: run the first paid world on the owner's own room after Phase 8 (about $11-13). If SC2 must close in Phase 6, use a converted ARKitScenes raw scene (real ARKit poses, 1920×1440) with about 200-300 frames. The planner keeps SC2's paid part as a human-only runbook either way.

**Primary recommendation:** Build `echo3.ts` against a `node:http` fake that bills distinct worlds. Run the real `handleSubmit`/`handleTrack` against it through an injectable-provider variant of `test/helpers/pipeline.ts`. Fix the four gaps above in the same phase.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Echo-3 HTTP client (`echo3.ts`) | API/Backend (worker + api processes) | — | The secret key is server-side only. The API process also calls limits/quote |
| Exactly-once submit | Backend worker + Postgres | Provider idempotency | Persist-before-spend. The DB is the ledger and the provider key is the second line |
| Retryability decision | API/Backend (pure fn + ledger check) | — | The client only renders `retryable`. It is never trusted (T-04-14 pattern) |
| Retry approval + reset | API route + Postgres tx | Worker picks up job | Conditional update + enqueue in one tx (existing pattern) |
| Budget alert | Postgres (inside the advisory-locked reserve tx) | Worker side effects (log/push) after commit | Dedupe must be atomic. Side effects must not roll back |
| Budget banner | Browser/Client (Library) | API (`GET /v1/worlds` field) | The server computes, the app displays |
| Fake Echo-3 | Test tier (`node:http`, port 0) | — | Zero real calls (money rule) |

## Echo-3 API Contract (re-verified 2026-11-25, docs only)

### Transport [CITED: docs.spaitial.ai/api/authentication.md]
- Base URL `https://api.spaitial.ai`, paths under `/v1`. Header: `Authorization: Bearer spt_live_<32 base32>`. Full-access scopes are needed (`worlds:create` for limits/quote/create, `worlds:read`, `worlds:write` for cancel/delete/POST exports).
- `401 UNAUTHORIZED` means a missing or revoked key. `403 FORBIDDEN` means the key lacks the scope. `403 MODEL_FORBIDDEN` means the plan has no API access (the Free plan has the API disabled) [CITED: credits-billing.md].
- **No sandbox or test-key mode** [CITED: llm-skills.md]. Every call against a real key is real.

### Endpoints the provider needs
| ReconProvider method | HTTP | Response used | Source |
|---|---|---|---|
| `limits()` | `GET /v1/captures/limits` | `min_frames` (1), `max_frames` (default 5000; `max_frames_ceiling` 12000) | [CITED: capture-worlds.md] |
| `quote(n)` | `GET /v1/captures/process-quote?model=echo-3&frame_count=n` | `required_credits`, `available_credits`, `has_enough`, `estimated_duration_seconds`. Over max → `400 CAPTURE_FRAME_LIMIT_EXCEEDED` (`details.max_frames`) | [CITED] |
| `submit(body,key)` | `POST /v1/worlds` + `Idempotency-Key` | `202` → `request_id` (`req_…`). Phase 2 also recorded `status_url/response_url/cancel_url` | [CITED: worlds.md]; the 202 field list beyond `request_id` is [ASSUMED] |
| `status(id)` | `GET /v1/worlds/requests/{id}/status` | `status`, `progress` (0..1 or null), `estimated_duration_seconds`, `error {code,message}` on FAILED, `world_id` | [CITED: worlds.md, reference] |
| (inside `status` on FAILED, and in `artifacts`) | `GET /v1/worlds/requests/{id}` | `world.{splat_url, cameras_url, thumbnail_url, splat_format, …}`, `validation {passed, issues[]}`, `error` | [CITED: worlds.md] |
| `ensureExport(id,'mesh-simplified')` | `GET …/exports/mesh-simplified`, then `POST` if not started | `status`: `PROCESSING`/`READY`/`FAILED` (`NOT_REQUESTED` seen for old floorplans). POST → `202` started / `200` already READY | [CITED: exports.md]; full enum [ASSUMED] |
| `ensureExport(id,'floorplan')` | `GET …/exports/floorplan` (auto-started for Echo-3) | READY response carries the `floorplan` meta block + `download_url` | [CITED: exports.md, llm-skills.md] |
| `open(splat)` | `GET …/splat` → **302** to a ~5-min signed URL | SPZ bytes (`output_format: 'spz'`) | [CITED] |
| `open(collider)` | `GET …/exports/mesh-simplified?download=1` → 302 | PLY | [CITED] |
| `open(floorplan)` | `GET …/exports/floorplan?download=1` → 302 | PNG (styled; `&variant=raw` for raw) | [CITED] |
| `open(cameras)` | `GET …/cameras` → 302 | `cameras.json` (`404 CAMERAS_NOT_AVAILABLE` if not a capture) | [CITED] |
| `open(thumbnail)` | `world.thumbnail_url` (on `img.spaitial.ai`, **not** an API proxy) | JPEG | [CITED: worlds.md]. Whether it needs auth is unknown [ASSUMED public] |
| `cancel(id)` | `POST …/cancel` | Safe to retry. `409 REQUEST_NOT_CANCELLABLE` once terminal → treat as success | [CITED] |
| `deleteWorld(id)` | `DELETE /v1/worlds/requests/{id}` | `409 RESOURCE_NOT_DELETABLE` while active (cancel first). `404 REQUEST_NOT_FOUND` = gone (purge already accepts 404) | [CITED] |

Status enum: `PENDING → PROCESSING → COMPLETED`, branching to `FAILED` / `CANCELLED` [CITED: llm-skills.md]. Keep it an open enum (pipeline already does).

### Artifact mapping (feeds the unchanged `handleTrack` KEY_COLUMN)
| kind | name (our R2 file) | contentType | ref (resolved fresh in `open()`) |
|---|---|---|---|
| `splat` | `splat.spz` | `application/octet-stream` | `/v1/worlds/requests/{id}/splat` |
| `collider` | `collider.ply` | `application/octet-stream` | `/v1/worlds/requests/{id}/exports/mesh-simplified?download=1` |
| `floorplan` | `floorplan.png` | `image/png` | `/v1/worlds/requests/{id}/exports/floorplan?download=1` |
| `floorplan_meta` | `floorplan.json` | `application/json` | `json:/v1/worlds/requests/{id}/exports/floorplan`. `open()` GETs the export JSON and streams `JSON.stringify(body.floorplan)` |
| `cameras` | `cameras.json` | `application/json` | `/v1/worlds/requests/{id}/cameras` |
| `thumbnail` | `thumbnail.jpg` | `image/jpeg` | the envelope's `world.thumbnail_url`, listed only when non-null and https on `*.spaitial.ai` |

- Only the splat name differs from the mock (`splat.ply` → `splat.spz`). The viewer sniffs bytes (`getSplatFileType(fileBytes)` in `virtumetry/src/viewer/engine.ts:137`) and rotates RDF for `spz`, so no viewer change is needed [VERIFIED: codebase].
- The floorplan meta block has the same shape as the committed `test/fixtures/demo-room/floorplan.json` (version, coordinate_system, origin_xz, image{world_xz_from_pixel, pixel_from_world_xz,…}, raw_image) [VERIFIED: fixture vs exports.md]. Note: the docs say `projection: "orthographic-top-down"` (hyphen) while the fixture has `orthographic_top_down` (underscore). Check that the viewer doesn't compare it (grep showed no use of `projection` in `virtumetry/src/viewer`) [VERIFIED: codebase].

### Idempotency [CITED: worlds.md, errors.md, llm-skills.md]
- Same key + identical body → "cached 202 response (no new job)". Same key + different body → `409 IDEMPOTENCY_KEY_REUSED`. After `FAILED`, retry with a **new key**.
- **Retention window: not documented anywhere** (checked worlds.md, errors.md, llm-skills.md, create-job reference). Keep D-05.
- **Concurrent in-flight same-key behaviour: not documented.** Some APIs answer 409 while the first request is still in flight. If SpAItial does, a double-run would park a world that actually exists as `IDEMPOTENCY_KEY_REUSED`. Mitigation: keep the submit timeout (60 s) far under `LEASE_SECONDS` (600 s), so two runs of one submit job can't overlap [VERIFIED: queue.ts LEASE_SECONDS=600].
- "Identical body" comparison method (bytes vs canonical JSON) is undocumented → always resend the exact bytes (see Pitfall 1).

### Errors and retry [CITED: errors.md, rate-limits.md]
Envelope: `{ error: { code, message, request_id?, details } }`. The full code table is in errors.md. The ones that matter:

| HTTP | code | Submit handling |
|---|---|---|
| 400/413 | `INVALID_INPUT`, `INVALID_WEBHOOK_URL`, `CAPTURE_FRAME_LIMIT_EXCEEDED`, `MODEL_NOT_FOUND` | definitive refusal → release, failed/submit, not retryable |
| 401 | `UNAUTHORIZED` | **definitive refusal** (currently mis-handled, see Pitfall 3) |
| 402 | `INSUFFICIENT_CREDITS` (`details.required_credits/available_credits`) | release, failed/submit, retryable after top-up |
| 403 | `FORBIDDEN`, `MODEL_FORBIDDEN`, `MODERATION_REJECTED` | definitive refusal, not retryable |
| 409 | `IDEMPOTENCY_KEY_REUSED` | park dead, keep reservation (existing) |
| 422 | `VALIDATION_FAILED` (only with `validation.error_on_fail: true`, which we never send) | definitive |
| 429 | `RATE_LIMIT_EXCEEDED` (`Retry-After` **seconds**), `WORLD_USER_LIMIT` (concurrency; no Retry-After documented) | not submitted; retry same key+body |
| 500 | `INTERNAL_ERROR` | ambiguous; retry same key |
| 503 | `MODEL_UNAVAILABLE`, `WORLD_INTAKE_PAUSED`, `WORLD_INTAKE_UNAVAILABLE` | not submitted; retry with backoff |

- Rate limits per key, 60 s fixed windows: General 60/min, World create 10/min (in addition), Downloads 120/min. Headers: `X-RateLimit-Limit/Remaining/Reset`, `Retry-After` on 429 only [CITED: rate-limits.md]. With `TRACK_POLL_SECONDS=60` and a single owner, we're far below these.
- Async failure: `FAILED`, **0 credits** ("Failed and cancelled jobs automatically refund their reserved credits") [CITED: credits-billing.md, capture-worlds.md]. Validation issues come in `validation.issues[].code`. The top-level `error.code` for a validation failure is **undocumented** (the only documented async code is `WORLD_GENERATION_FAILED`). See Pitfall 8.

### Validation issue codes (non-retryable family) [CITED: capture-worlds.md]
Download: `ZIP_URL_HTTP_ERROR, ZIP_URL_NOT_FOUND, ZIP_URL_FORBIDDEN, ZIP_URL_NOT_ALLOWED, ZIP_URL_TOO_MANY_REDIRECTS, ZIP_RANGE_UNSUPPORTED, CAPTURE_INGEST_TIMEOUT`. Archive: `ZIP_*`. Images: `IMAGES_MISSING, TOO_MANY_FRAMES, IMAGE_*`. EXIF: `EXIF_*`. Cameras: `TRAJECTORY_*, MATRIX_*, ROTATION_*, PER_FRAME_INTRINSICS_*, INTRINSICS_*, ORIENTATION_*, CAMERA_FILE_INVALID_JSON`. Multi-scan: `SCANS_*`.
**D-08's pattern list misses `IMAGES_MISSING`/`TOO_MANY_FRAMES` (covered by `IMAGE`? No: `IMAGES_MISSING` doesn't start with `IMAGE_`), `ORIENTATION_*`, `SCANS_*`, and `VALIDATION_FAILED`.** Add them to the regex (see Pattern 3).

### Bundle URL and webhook constraints [CITED: capture-worlds.md, webhooks.md]
- ZIP URL: https, unauthenticated GET, `Accept-Ranges: bytes`, valid and unchanged ≥ 2.5 h or until terminal. The current presign is `BUNDLE_URL_TTL_SECONDS=86400` (24 h). That's fine; R2 presign max is 7 days [ASSUMED].
- `webhook.url`: per request, public https only (private → `400 INVALID_WEBHOOK_URL`). The pipeline already omits it when `PUBLIC_BASE_URL` isn't https. One signing secret per account, from the Developer Portal Webhooks page → `SPAITIAL_WEBHOOK_SECRET`.
- The webhook route (PROC-06) already matches the documented headers and signature. **No change needed.**

### Pricing [CITED: credits-billing.md, capture-worlds.md]
- 1 credit = $0.01. Echo-3 API = **900 + frame_count** credits. Exports cost 0.
- Plans: Free (API disabled → `403 MODEL_FORBIDDEN`), Standard $49.99/mo 7,500 credits (non-commercial), Pro $99.99/mo 15,000 (commercial). Top-ups 1,600/3,200/8,000 credits.

| Frames | Credits | USD |
|---|---|---|
| 30 (TUM fixture) | 930 | $9.30 |
| 200 | 1,100 | $11.00 |
| 300 | 1,200 | $12.00 |
| 1,200 (docs example, ETA 3,210 s) | 2,100 | $21.00 |

## Standard Stack

No new dependencies. Everything uses the stdlib or installed packages.

| Need | Use | Version | Notes |
|---|---|---|---|
| HTTP client | global `fetch` (undici) | Node 24 runtime (local dev Node 22.21.1 also has it) | `AbortSignal.timeout`, `redirect: 'manual'` |
| Stream bridge | `Readable.fromWeb` (`node:stream`) | stdlib | `open()` must return a Node `Readable` for `storage.putStream` |
| Fake server | `node:http` `createServer`, `listen(0,'127.0.0.1')` | stdlib | The same pattern as the harness's Fastify dev-storage server |
| Validation | `zod` 4 (installed) | ^4.6.7 | `BUDGET_ALERT_SHARE`, `SPAITIAL_BASE_URL`, retry body |
| DB | `drizzle-orm` ^0.45.2 / `drizzle-kit` ^0.31.10 (installed) | — | `npm run db:generate` → `drizzle/0005_*.sql` |
| Tests | vitest ^2.1 (backend), jest-expo 58 + RNTL (app) | installed | Don't upgrade vitest (CLAUDE.md) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| `node:http` fake server | injected `fetch` stub | A stub can't test real redirects, socket drops, auth-header leakage or timeouts. Use the real server; keep `fetch` injectable for the odd unit test |
| `world_attempts` table | JSONB array on `worlds` | A table is append-only and FK-able. Locked by D-10 |
| `budget_alerts` table dedupe | compute-only (no table) | No once-per-window guarantee for push. Locked by D-12 |

## Package Legitimacy Audit

No external packages are installed in this phase, so slopcheck wasn't needed.
**Packages removed due to slopcheck [SLOP]:** none. **Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram
```
App (Expo Go)                         API (Fastify)                          Worker                         Echo-3 (live) / fake-echo3 (tests)
 Library poll ─GET /v1/worlds──────▶ serialize + retryable + budgetAlert
 Retry sheet ─GET /v1/quote────────▶ provider.quote ───────────────────────────────────────────────────────▶ GET /captures/process-quote
            ─POST /worlds/:id/retry▶ isRetryable + ledger-clear? ─no─▶ 409 not_retryable
                                     quote ≤ approval? ─no─▶ 400 approval_below_quote
                                     TX: insert world_attempts(prev) ; UPDATE worlds … WHERE status='failed' AND submit_attempt=N
                                         reset key(new uuid)/body/rid/quote/failure ; status submitting|packing ; enqueue job
                                                                        │
                                                         [submit] quote→persist key+body→reserveCredits(tx: lock, check, insert, ALERT insert)
                                                                        │       └─ alert row new? → console.warn + push(owner)
                                                                        ├─ provider.submit(exact DB bytes, key) ──────────────▶ POST /v1/worlds (Idempotency-Key)
                                                                        │     202 → TX{rid, processing, enqueue track}           same key+body → same req id (billed once)
                                                                        │     4xx definitive → release, failed/submit             same key+other body → 409
                                                                        │     429/503 → retry same key ; 5xx/timeout/drop → uncertain, retry same key
                                                         [track] status ──────────────────────────────────────────────▶ GET …/status (+ GET envelope on FAILED)
                                                                 FAILED → failed/processing + release ; CANCELLED → release
                                                                 COMPLETED → exports (GET/POST) → artifacts (envelope) → open(302 → signed URL, no auth) → R2
 Webhook ◀── (live only) ──────────── /v1/webhooks/spaitial: HMAC → dedupe → nudge track
```

### Recommended file layout (additions only)
```
backend/src/provider/echo3.ts            # live client (D-01..D-03)
backend/src/provider/index.ts            # createProvider: live branch
backend/src/retry.ts                     # isRetryable() + retry tx (or inside routes/worlds.ts — fewer files)
backend/src/budget.ts                    # + alert insert inside reserveCredits, budgetAlertFor()
backend/src/db/schema.ts                 # + worlds.submitAttempt, worldAttempts, budgetAlerts
backend/drizzle/0005_<generated>.sql     # drizzle-kit generate output (+ meta snapshot/journal)
backend/test/helpers/fake-echo3.ts       # node:http fake (idempotency, scripts, billed count, replay set)
backend/test/fixtures/echo3-recorded/    # manifest.json {synthetic:true,…} + tiny binaries (reuse mock-outputs bytes)
backend/test/echo3.client.test.ts        # client ↔ fake (no DB)
backend/test/retryable.test.ts           # pure table test
backend/test/integration/echo3-contract.pg.test.ts  # real handleSubmit/handleTrack ↔ fake
backend/test/integration/retry.pg.test.ts
backend/test/integration/budget-alert.pg.test.ts
backend/scripts/record-echo3-run.ts      # owner-only, run during the paid session
virtumetry/src/components/approval.tsx   # moved from capture/[id].tsx (UI-SPEC reuse rule)
virtumetry/src/app/world/[id]/retry.tsx  # retry / non-retryable sheet
```

### Pattern 1: `echo3.ts` core (stdlib only)
```typescript
// Source: docs.spaitial.ai/api/{authentication,worlds,errors,rate-limits,exports}.md
import { Readable } from 'node:stream';
import { ProviderError, ProviderTimeoutError, verifyWebhookSignature, type ReconProvider } from './types.js';

const T_SUBMIT = 60_000, T_CALL = 30_000, T_DOWNLOAD = 15 * 60_000; // download timeout covers the whole body

export function parseRetryAfter(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.ceil(s));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : undefined;
}

export function createEcho3Provider(o: { apiKey: string; baseUrl: string; webhookSecret: string; fetch?: typeof fetch; timeouts?: Partial<{ submit: number; call: number; download: number }> }): ReconProvider {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  async function call(endpoint: string, path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        ...init,
        redirect: 'manual',
        headers: { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json', ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(init.timeoutMs ?? o.timeouts?.call ?? T_CALL),
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') throw new ProviderTimeoutError(`${endpoint} timed out`, endpoint);
      throw new ProviderError(`${endpoint} network error`, { endpoint, cause: err }); // no status = uncertain
    }
    if (res.status >= 400) {
      const env = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      throw new ProviderError(`${endpoint} ${res.status}`, {
        status: res.status, endpoint, code: env?.error?.code ?? `HTTP_${res.status}`,
        retryAfterS: parseRetryAfter(res.headers.get('retry-after')),
      }); // never put the message/body/URL in logs beyond the code
    }
    return res;
  }
  // submit: body sent EXACTLY as given (the persisted string)
  //   const res = await call('submit', '/v1/worlds', { method: 'POST', body, timeoutMs: T_SUBMIT,
  //     headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
  //   if (res.status !== 202 && res.status !== 200) throw new ProviderError(...uncertain...);
  //   const { request_id } = await res.json(); if (!/^req_/.test(request_id)) throw ...;
  // download: 302 → follow MANUALLY to the signed URL WITHOUT the Authorization header
  //   const r = await call('download', ref, { timeoutMs: T_DOWNLOAD });
  //   const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
  //   const s = loc ? await f(new URL(loc, base), { signal: AbortSignal.timeout(T_DOWNLOAD) }) : r;
  //   return Readable.fromWeb(s.body as never);
  ...
}
```
Key rules:
- **`redirect: 'manual'` plus a second bare `fetch` for the `Location`.** This guarantees the bearer token never goes to the storage host. (undici strips `Authorization` on cross-origin redirects in current versions, but don't rely on it [ASSUMED].) The fake server redirects to `localhost` while the API base is `127.0.0.1` (different origin), so a test can assert no `Authorization` arrived.
- `limits()` caches in a closure for 1 h. `quote()` maps `{ credits: required_credits, available: available_credits }`.
- `cancel()`: a 409 `REQUEST_NOT_CANCELLABLE` counts as success. `deleteWorld()`: 404 propagates as `ProviderError{status:404}` (purge already treats 404 as gone). A 409 `RESOURCE_NOT_DELETABLE` should trigger cancel first, then rethrow so purge retries.
- `status()`: GET `/status`. When `status === 'FAILED'`, also GET the envelope and return `issues = envelope.validation?.issues` (codes only). Return `progress` as given (null stays null).
- `ensureExport(kind)`: GET → `READY`→'ready', `FAILED`→'failed', `PROCESSING`→'pending'. `NOT_REQUESTED` or 404 → POST (202→'pending', 200→'ready'). 409 `RESOURCE_NOT_READY`→'pending'.
- Allowlist refs: `open()` accepts only refs starting with `/v1/worlds/requests/` (or `json:` of the same), plus the one thumbnail URL whose host ends with `.spaitial.ai` and scheme is https (SSRF guard, mirrors mock T-02-21).
- `verifyWebhook` = `verifyWebhookSignature(webhookSecret, …)` (reuse).

### Pattern 2: fake Echo-3 server (`test/helpers/fake-echo3.ts`)
```typescript
// Behaviour per docs; one instance per test. ~150 lines.
import { createServer } from 'node:http';
type Step = 'accept' | '429' | '503' | '500' | '401' | '402' | 'timeout' | 'drop-after-accept';
export async function startFakeEcho3(o: { apiKey?: string; submitScript?: Step[]; replaySet?: string } = {}) {
  const byKey = new Map<string, { body: string; requestId: string }>();
  const state = { billed: 0, submits: [] as { key: string; body: string; auth?: string }[], signedHits: [] as { auth?: string }[] };
  const script = [...(o.submitScript ?? [])];
  const server = createServer(async (req, res) => {
    const raw = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const json = (code: number, body: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
    const err = (code: number, c: string, h?: Record<string, string>) => json(code, { error: { code: c, message: c, details: {} } }, h);
    if (req.url?.startsWith('/signed/')) { state.signedHits.push({ auth: req.headers.authorization }); /* serve bytes */ return; }
    if (req.headers.authorization !== `Bearer ${o.apiKey ?? 'spt_live_test'}`) return err(401, 'UNAUTHORIZED');
    if (req.method === 'POST' && req.url === '/v1/worlds') {
      const key = String(req.headers['idempotency-key']);
      state.submits.push({ key, body: raw });
      const step = script.shift() ?? 'accept';
      if (step === '429') return err(429, 'RATE_LIMIT_EXCEEDED', { 'retry-after': '0' });
      if (step === '503') return err(503, 'WORLD_INTAKE_UNAVAILABLE');
      if (step === '500') return err(500, 'INTERNAL_ERROR');
      if (step === '401') return err(401, 'UNAUTHORIZED');
      if (step === '402') return err(402, 'INSUFFICIENT_CREDITS');
      const prior = byKey.get(key);
      if (prior && prior.body !== raw) return err(409, 'IDEMPOTENCY_KEY_REUSED');
      const rec = prior ?? { body: raw, requestId: `req_${crypto.randomUUID()}` };
      if (!prior) { byKey.set(key, rec); state.billed++; }      // billed = distinct worlds
      if (step === 'drop-after-accept') return req.socket.destroy();
      if (step === 'timeout') return;                            // client AbortSignal fires
      return json(202, { request_id: rec.requestId });
    }
    // GET limits / process-quote (900+n) / status (scripted sequence) / envelope / exports / 302s → /signed/* on http://localhost:<port>
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) };
}
```
- `replaySet` mode loads `test/fixtures/echo3-recorded/manifest.json` (`{ synthetic: true, statusSequence: [...], envelope, exports: { 'mesh-simplified': [...], floorplan: {...} }, artifacts: { splat: 'mock-outputs/splat.ply', … } }`) and serves those bodies. Binaries reuse the committed `mock-outputs` bytes (KB-sized, already public).
- **Harness change:** `startPipeline` in `test/helpers/pipeline.ts` hard-codes `createMockProvider`. Add an option `provider?: (ctx) => ReconProvider` (or `providerOverride`). Keep `calls`-based assertions for the mock and use `fake.state` for echo3. The harness's dev-storage serves http presigned URLs, and the pipeline's Range preflight works against it. `PUBLIC_BASE_URL` is http, so the body has no `webhook` (correct, same as live behaviour for non-https).
- Make the test client timeouts small (`timeouts: { submit: 500 }`) so the 'timeout' step finishes fast.

### Exactly-once test designs (SC1)
| Test | Setup | Assertion |
|---|---|---|
| Kill mid-submit (after accept, before rid saved) | Wrap `provider.submit`: `await real(b,k); throw new LeaseLostError('simulated crash')`. `handleJobError` leaves the job `running`/locked (worker.ts:215). Then `UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE world_id=$1 AND kind='submit'` and drain | `fake.state.billed === 1`; 2 submits with the same key and byte-identical body; `provider_request_id` = the first request id; exactly one `reserve` row, no `release`; world reaches `ready` |
| Drop after accept (network) | `submitScript: ['drop-after-accept']` | billed 1, second send replays, ready, reservation kept (uncertain marker) |
| Timeout then retry | `submitScript: ['timeout']` | billed 1, ready |
| Concurrent submits (two workers) | After the world is `submitting`, claim the job, then run `Promise.all([handleSubmit(depsA, job), handleSubmit(depsB, {...job})])` (simulates an expired-lease double run). Also a variant with two `runOneJob` on different `workerId`s | billed 1; both sends carry the same key and body (set-if-null + re-read); one `reserve` row (`'already'` for the loser); a single `provider_request_id` |
| 409 parks | Pre-seed the fake `byKey` with the world's key and a different body (or script) | world `failed/submit IDEMPOTENCY_KEY_REUSED`, job `dead`, `submission_key` unchanged, reservation kept, billed 0 new |
| 401 definitive (gap fix) | `submitScript: ['401']` | exactly 1 submit call, `failed/submit UNAUTHORIZED`, reservation released |
| Same against the mock | Existing `scenarios.pg.test.ts` + one new kill-mid-submit case using `createMockProvider` (its `byKey` replays) | `calls.submit` same key/body, one request |
| Contract unit | `echo3.client.test.ts`: auth header, exact body bytes, 409 mapping, Retry-After seconds + HTTP date, timeout → `ProviderTimeoutError`, 302 followed without Authorization (`fake.state.signedHits[i].auth === undefined`), allowlist rejects foreign refs | — |

### Pattern 3: `isRetryable` + the ledger guard
```typescript
const VALIDATION = /^(VALIDATION_FAILED|INVALID_INPUT|TOO_MANY_FRAMES|IMAGES?_|ZIP_|EXIF_|TRAJECTORY_|MATRIX_|ROTATION_|ORIENTATION_|SCANS_|CAMERA_FILE_|CAMERAS?_|CAPTURE_|PER_FRAME_INTRINSICS_|INTRINSICS_)|INTRINSICS/;
const SUBMIT_RETRYABLE = new Set(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'BUDGET_EXCEEDED', 'QUOTE_ABOVE_APPROVAL', 'HTTP_402', 'INSUFFICIENT_CREDITS']);
/** Pure. `message` carries the joined issue codes for processing failures (pipeline.ts failWorld call). */
export function isRetryable(w: { status: string; deletedAt: Date | null; failureStage: string | null; failureCode: string | null; failureMessage: string | null }): boolean {
  if (w.status !== 'failed' || w.deletedAt) return false;
  const code = w.failureCode ?? '';
  if (w.failureStage === 'submit') return SUBMIT_RETRYABLE.has(code);
  if (w.failureStage === 'processing') {
    const tokens = [code, ...(w.failureMessage ?? '').split(/[,\s]+/)].filter(Boolean);
    return code !== '' && code !== 'FAILED' && !tokens.some((t) => VALIDATION.test(t));
  }
  return false; // upload/validate/pack/import, unknown
}
```
- Note: `INSUFFICIENT_CREDITS` is the real 402 code (the pipeline uses `err.code ?? HTTP_402`). D-08 names `HTTP_402`, so include both.
- **Processing-stage unknown codes:** D-08 says "not a validation code → retryable" but also "unknown codes default to not retryable". The rule above treats any non-validation provider code (e.g. `WORLD_GENERATION_FAILED`) as retryable and the generic fallback `FAILED` as not. This is safe money-wise: FAILED = 0 credits, so a retry only costs if it succeeds. Planner: confirm this reading.
- **Ledger guard (mandatory, Pitfall 7):** the retry route must also check that the current `submission_key` has no unreleased reservation:
  `NOT EXISTS (SELECT 1 FROM credit_events r WHERE r.submission_key = $key AND r.kind='reserve' AND NOT EXISTS (SELECT 1 FROM credit_events x WHERE x.submission_key = r.submission_key AND x.kind='release'))`. This is the same query purge uses for WR-01 (worker.ts). `submission_key IS NULL` (e.g. BUDGET_EXCEEDED before mint, QUOTE_ABOVE_APPROVAL) passes.
- **Recommended pipeline tweak** so the payload's `retryable` is accurate without a per-row ledger query: in `handleSubmit`'s 400/402/403 branch, when `uncertain` is true, fail with code `SUBMIT_UNCERTAIN` (message keeps the provider code) instead of the provider code. This needs an update to the existing test `CR-02: a crash mid-send … then 402 keeps the reservation` (expects `INSUFFICIENT_CREDITS` today).

### Pattern 4: retry route transaction
```typescript
// POST /v1/worlds/:id/retry  { approved_max_credits }  + Idempotency-Key (uuid)
// 1. auth, findOwnedWorld (404), parse body (zod int ≤ 2e9), parse key (z.guid)
// 2. replay: SELECT world_attempts WHERE world_id=$id AND client_request_id=$key → 200 { world }
// 3. !isRetryable(w) || !ledgerClear(w) → 409 { error: 'not_retryable' }
// 4. cap = latestCapture; quote = provider.quote(cap.frameCount); approved < quote.credits → 400 { error:'approval_below_quote', quote_credits }
// 5. tx:
//    INSERT world_attempts (world_id, attempt=w.submitAttempt, submission_key, provider_request_id, failure_stage, failure_code,
//                           quoted_credits, client_request_id=$key)        -- unique(world_id, attempt) + unique(world_id, client_request_id)
//    UPDATE worlds SET submission_key = gen uuid, submit_body = NULL, provider_request_id = NULL, quoted_credits = NULL,
//           failure_stage/code/message = NULL, progress = NULL, approved_max_credits = $approved,
//           submit_attempt = submit_attempt + 1, status = bundleKey ? 'submitting' : 'packing', updated_at = now()
//      WHERE id=$id AND status='failed' AND deleted_at IS NULL AND submit_attempt = w.submitAttempt
//      RETURNING *            -- 0 rows → throw → rollback → 409 not_retryable
//    enqueue(tx, bundleKey ? 'submit' : 'pack', id)
//    unique violation on world_attempts → the concurrent winner already archived → 409 (or replay if same client key)
```
- `submit_attempt` doubles as the optimistic-lock version. The unique `(world_id, attempt)` makes the second concurrent retry fail at the INSERT even before the UPDATE.
- Minting the key here (`submission_key = randomUUID()`) means the pipeline's `isNull(submissionKey)` set-if-null becomes a no-op. That fits D-09 ("minted only here").
- The bundle is never deleted except by purge (worker.ts handlePurge; pack.ts only on a failed pack) [VERIFIED: grep deleteObject], so `submitting` is the normal path. Re-presign happens automatically because `submit_body` is NULL, so the retry gets a fresh 24 h URL.
- The job payload's `uncertain/sending` marker is per job. A retry enqueues a new submit job, so the marker is effectively per key. That's correct, and the "ponytail: one submit job per world" comment in pipeline.ts should be updated.
- Rate limit: copy the `/v1/scans` route config (`RATE_LIMIT_CREATE_MAX`, key `create:${userId}`).
- Payload: `serializeWorld` adds `retryable: isRetryable(w)` (plus the ledger tweak above) and `submit_attempt`. UI-SPEC also wants `frame_count` on `LibraryItem`. **That column lives on `captures`, not `worlds`** (UI-SPEC says "already exists in worlds", which is wrong). Either add a correlated subquery in the list query, or have the retry sheet read `frame_count` from a field the server adds only to the detail route. Easiest: have `POST /retry` quote server-side, plus a tiny `GET /v1/worlds/:id/retry-quote` that returns the same body as `/v1/quote` for the world's latest capture. Planner picks; the subquery in `GET /v1/worlds` is the smallest change if the sheet must use `/v1/quote?frames=N`.

### Pattern 5: budget alert inside the reserve transaction
```typescript
// budget.ts — after the reserve insert, still holding pg_advisory_xact_lock (so the check + insert is serialized)
const after = { day: day + a.amount, month: month + a.amount };
const crossed: Alert[] = [];
for (const [window, spent, budget] of [['daily', after.day, a.daily], ['monthly', after.month, a.monthly]] as const) {
  if (budget > 0 && spent >= a.share * budget) {
    const ins = await tx.execute(sql`
      INSERT INTO budget_alerts (provider_mode, "window", window_start, spent, budget, share)
      VALUES (${a.mode}, ${window},
        date_trunc(${window === 'daily' ? 'day' : 'month'}, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        ${spent}, ${budget}, ${a.share})
      ON CONFLICT (provider_mode, "window", window_start) DO NOTHING RETURNING 1`);
    if (rowsOf(ins).length) crossed.push({ window, spent, budget, share: a.share });
  }
}
return { result: 'reserved', alerts: crossed };
```
- Change the return type to `{ result: 'reserved' | 'already'; alerts: Alert[] }`, or keep the string and add an `onAlert` callback param. A callback keeps every existing caller and test unchanged: `reserveCredits(db, {..., share, onAlert})`, with `onAlert` called **after** the tx commits (collect inside, call after `db.transaction` resolves).
- Side effects in `handleSubmit` after commit: `console.warn('[budget-alert]', JSON.stringify({ mode, window, spent, budget, share, worldId }))` + `deps.push(ownerId, 'Processing budget', "You've used 82% of today's processing budget")`. The owner comes from `w.ownerId`. Wrap the push in try/catch: an alert must never fail a submit.
- `window` is a reserved word in Postgres. Quote it, or name the column `budget_window` (simpler; recommended).
- In-app (UI-SPEC: on `GET /v1/worlds`, not only `/v1/quote`): compute from `spentCredits(db, config.PROVIDER_MODE)` live (one indexed aggregate per poll) → monthly first if over, else daily, else null. Computing live (not reading the table) is always correct, and disappears when releases bring spend back under. Use the same helper in `/v1/quote`.
- Config: `BUDGET_ALERT_SHARE` **cannot use `numberFromEnv`** (it pipes `.int()`). Use `z.string().optional().transform(v => v ? Number(v) : 0.8).pipe(z.number().gt(0).lte(1))`.

### Anti-Patterns to Avoid
- **Re-serializing the body inside echo3.ts** (`JSON.stringify(JSON.parse(body))`): this breaks byte identity. Send `body` as given.
- **`redirect: 'follow'` with the bearer header:** it leaks the key to the storage host on same-origin or older-undici paths.
- **Internal retries in echo3.ts:** the pipeline owns retry policy and counting (D-01).
- **Running `drizzle-kit push`, or `migrate` against anything but the dev branch:** use `npm run db:generate` then `npm run db:migrate:dev` (guarded by `scripts/dev-guard.mjs`).
- **A provider instance per request:** `createProvider` is called once in `server.ts` (and once in the worker). Keep that so the limits cache works.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Webhook signature | new verifier | `verifyWebhookSignature` in `provider/types.ts` | already constant-time, fail-closed |
| Exactly-once ledger | new reservation logic | `reserveCredits` / `releaseCredits` | advisory-locked, tested, window-pinned UTC |
| Ledger "held" check | new SQL | copy the purge WR-01 query (worker.ts) | same semantics |
| Job enqueue / lease / snooze | anything new | `enqueue`, `RetryLaterError`, `LeaseLostError`, `snoozeJob` | the state machine depends on them |
| Test DB | new fixtures | `createTestSchema` (applies the real migration SQL) | migrations are tested for free |
| Retry approval UI | new components | move `Layout/Primary/Neutral/StatRow` + quote card from `capture/[id].tsx` to `components/approval.tsx` (UI-SPEC) | no forked styles |
| UUIDs in app | new dep | `uuid.v4()` from `expo` (already used in `src/capture/fixture-source.ts`) | — |

**Key insight:** the money safety lives in Postgres (persist-before-spend, conditional updates, unique keys, advisory lock). echo3.ts should be a thin, dumb translator. Every clever bit added there is untestable against the real API.

## Runtime State Inventory

Not a rename/refactor phase. One schema migration is added (additive: a new column with a default and two new tables), so existing rows need no data migration. `submit_attempt` gets `DEFAULT 1 NOT NULL`.

| Category | Items Found | Action Required |
|---|---|---|
| Stored data | Existing `worlds` rows (dev/prod) lack `submit_attempt` | Column default covers them; no backfill |
| Live service config | Railway dev/prod env vars: none required (safe defaults). The paid run needs owner-set vars on **both api and worker services** | runbook only |
| OS-registered state | None (verified: no OS tasks involved) | none |
| Secrets/env vars | `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET` already defined in config (unused until now) | none for agents |
| Build artifacts | none | none |

## Common Pitfalls

### Pitfall 1: "exact body" vs JSONB round-trip
**What goes wrong:** `worlds.submit_body` is `jsonb`. Postgres normalizes key order and whitespace, so the bytes sent equal `JSON.stringify(<jsonb read back>)`, not the original object's stringify.
**Why it's still OK:** `handleSubmit` re-reads the row before the **first** send too ("Always send what the DB holds", pipeline.ts), so every send uses the same normalized form. JSONB output and `JSON.stringify` are deterministic [VERIFIED: codebase; jsonb ordering ASSUMED stable across Neon minor versions].
**How to avoid regressions:** never send a body built in memory. The contract test asserts all `fake.state.submits[i].body` strings are identical. A `text` column would be stricter, but it isn't needed (don't migrate).

### Pitfall 2: 302 download timeouts and auth leakage
`AbortSignal.timeout(30 s)` on a download aborts mid-body for a 100+ MB SPZ. Use a separate long download timeout (≈15 min) and `redirect:'manual'`. Signed URLs live about 5 min and are only checked at request start, so resolve them in `open()` right before streaming (D-02). The import loop heartbeats after each artifact. The lease is 600 s, so a single artifact taking more than 10 min would lose the lease. That's acceptable at Railway bandwidth (`ponytail:` note).

### Pitfall 3: 401 and other definitive 4xx treated as "uncertain" (existing bug)
`handleSubmit` marks only 400/402/403/429/503 as definitive. A `401 UNAUTHORIZED` (wrong or revoked key, the most likely first-live-run error) goes down the 5xx path: 4 attempts, then `SUBMIT_UNCERTAIN`, with the reservation **held forever** and the world not retryable. Same for 404/413/422. **Fix:** `definitive = status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429`, plus 503. Refuse-and-release for every definitive 4xx except 429. Test: fake `submitScript:['401']`.

### Pitfall 4: no sandbox, so tests must be hermetic
Any test that accidentally builds echo3 with the real base URL would spend money (the key isn't in CI, but it is in local `.env` once the owner adds it). **Guard:** add a vitest `setupFiles` entry that wraps `globalThis.fetch` and throws on any URL whose host ends in `spaitial.ai`. That's about 6 lines and enforces the money rule for every test. Also: `loadConfig` already refuses live without `ALLOW_PAID_PROVIDER=1`. Add a config test asserting that live also requires both keys and an https `SPAITIAL_BASE_URL`.

### Pitfall 5: WORLD_USER_LIMIT (429 concurrency)
It has no documented `Retry-After`. The pipeline backoff (30·2^n s, ≤ 900 s, 4 attempts) totals about 7.5 min, while an active Echo-3 job runs 30-120 min. A second scan while one is processing would end as `RATE_LIMITED` (released, retryable). That's acceptable for a single owner; the Retry button covers it.

### Pitfall 6: submit timeout vs lease
If a submit could outlive `LEASE_SECONDS` (600 s), a second worker could resend concurrently. SpAItial's concurrent in-flight behaviour is undocumented (might 409 → falsely parked). Keep `T_SUBMIT = 60 s`. Add an assertion in a unit test: `T_SUBMIT_MS < LEASE_SECONDS * 1000 / 2`.

### Pitfall 7: retrying a world whose old key may be billed (gap)
A 402/400/403 after an uncertain earlier attempt keeps the reservation but records a "retryable" code (`INSUFFICIENT_CREDITS`). A retry mints a new key, and if the earlier request exists we'd have two paid worlds. **Fix:** the ledger guard in the retry route (mandatory) plus the `SUBMIT_UNCERTAIN` re-code in pipeline (recommended). Test: seed a world failed with `INSUFFICIENT_CREDITS` whose key has an unreleased reserve → `POST /retry` → 409 `not_retryable`, no job enqueued.

### Pitfall 8: validation failures may not carry a validation code in `failure_code`
`handleTrack` stores `s.error?.code ?? codes[0]`. If SpAItial's top-level `error.code` for a bad bundle is generic (undocumented; the mock uses `VALIDATION_FAILED`), `failure_code` hides the issue codes. They're still in `failure_message` (codes joined). `isRetryable` must scan both (Pattern 3). Alternative one-token change: `codes[0] ?? s.error?.code`. That also changes display-state text for mock validation failures; no existing test asserts `VALIDATION_FAILED` as a world failure code [VERIFIED: grep].

### Pitfall 9: purge breaks once `world_attempts` exists (gap)
`handlePurge` hard-deletes `worlds` in a tx that deletes `share_slugs, jobs, captures` first. An FK from `world_attempts.world_id` would make the delete fail, and purge would retry forever. Also, LIB-03 promises deletion at SpAItial, and archived attempts' `provider_request_id`s (processing-FAILED worlds exist at SpAItial) would never be deleted. **Fix:** in purge, for each `world_attempts.provider_request_id` call `provider.deleteWorld` (404 ok), then `DELETE FROM world_attempts WHERE world_id` inside the hard-delete tx. Test: extend `purge-cascade.pg.test.ts`.

### Pitfall 10: alert side effects inside the transaction
If `sendPush` threw inside the reserve tx, the reservation would roll back and the submit would fail. Insert the alert row inside the tx (atomic dedupe under the lock). Log and push only after commit, wrapped in try/catch.

### Pitfall 11: optional thumbnail can wedge the import (gap)
`handleTrack` streams every artifact in `provider.artifacts()`. Any `open()` error snoozes and retries forever ("never gives up"). The live thumbnail is on `img.spaitial.ai` (not an API proxy; auth unknown). **Fix (2 lines in handleTrack):** `if (a.kind === 'thumbnail')`, wrap open+put in try/catch and skip with a warn. Test: fake returns 403 for the thumbnail → world still `ready`, `thumbnail_key` null.

### Pitfall 12: mixed modes across Railway services
api and worker are separate services. If only the worker is `live`, `/v1/quote` answers from the mock and shows the **mock** ledger's budget (`spentCredits(provider.mode)`), and the app's approval would be against the wrong partition. The runbook must set the vars on both services and redeploy both, and revert both.

### Pitfall 13: config schema details
- `SPAITIAL_BASE_URL`: `z.string().url().default('https://api.spaitial.ai')` + refine `startsWith('https://')`. Tests pass `baseUrl` directly to `createEcho3Provider`, so they never need http in config.
- When live, also require `BUNDLE_URL_TTL_SECONDS >= 9000` (2.5 h rule) and `PUBLIC_BASE_URL` https (or accept polling-only; the pipeline already omits the webhook).
- Update `.env.example` (`SPAITIAL_BASE_URL`, `BUDGET_ALERT_SHARE`, `MONTHLY_CREDIT_BUDGET` is missing there too).

## Code Examples

### createProvider live branch
```typescript
// backend/src/provider/index.ts
if (config.PROVIDER_MODE === 'live') {
  // refine() already enforced ALLOW_PAID_PROVIDER=1 + keys present (D-04)
  return createEcho3Provider({
    apiKey: config.SPAITIAL_API_KEY!,
    baseUrl: config.SPAITIAL_BASE_URL,
    webhookSecret: config.SPAITIAL_WEBHOOK_SECRET!,
  });
}
```

### Mock scenario for a retryable failure (Expo Go check)
Add `'failed_retryable'` (or reuse `'failed'`: it already yields `WORLD_GENERATION_FAILED` at the processing stage with the reservation released, which Pattern 3 classifies as retryable). Reusing `'failed'` needs zero code. Recommend reuse, and add `'429_exhausted'` only if a submit-stage retryable case is wanted in Expo Go (the existing `'402'` → `INSUFFICIENT_CREDITS` with release is already one). **Caveat:** with `MOCK_SCENARIO=failed`, the retry will fail again (the scenario is global). For the manual check, switch the Railway dev var back to `happy` before tapping Approve, or make the mock fail only the first submit per world.

### record-echo3-run.ts (owner-only)
Inputs: world id. It reads the world from the DB, then makes free GETs with the live key: status, envelope, `exports/floorplan`, `exports/mesh-simplified`. Scrub: drop `splat_url, cameras_url, thumbnail_url, viewer_url, panorama_url, download_url`, signed `Location`s, and any `req_` → keep it (not secret). Copy `worlds/<id>/v1/*` from our R2 to `fixtures/echo3-run-1/` in R2 dev (no SpAItial download needed). Write `test/fixtures/echo3-recorded/manifest.json` with `synthetic: false` and object keys instead of bytes. Guards: `assertDevBucket()`, refuse unless `PROVIDER_MODE=live`, never print the key.

## State of the Art

| Old | Current | Impact |
|---|---|---|
| Phase 2: echo3 "lands in Phase 6" (`createProvider` throws) | live branch behind 2 flags + key checks | boot-time guard |
| Retry = none (failed is terminal) | `submit_attempt` + `world_attempts` + explicit re-approval | new key only via owner approval |
| Budget = hard cap only | cap + once-per-window alert at a share | OPS-06 |

**Deprecated/outdated:** the capture-prototype validator's 1920×1440/1080-only rule vs the docs' "long ≤ 1920, short ≥ 360". The docs still say ≥360 short edge [CITED: capture-worlds.md], so 640×480 is documented-valid.

## Paid-run input recommendation (for 06-HUMAN-UAT.md)

| Option | Frames / res | Cost | Verdict |
|---|---|---|---|
| SpAItial `samples/minimal-bundle` | 3 frames, 1920×1440, **flat placeholder images** | 903 credits ($9.03) if it passes validation | **Don't.** The sample README itself says it "can't be reconstructed". The best case is a free FAILED; the worst case is a billed garbage world [CITED: github.com/spaitial-ai/spaitial-capture-prototype/tree/main/samples] |
| Committed TUM fixture (fr3/nostructure_texture_far) | 30 frames, 640×480, downward view of a flat textured floor | 930 ($9.30) | Real images and poses, but **not a room** and a planar scene. It proves the money path only. Risk of `IMAGE_RESOLUTION_*` (free) if the server follows the prototype validator. The Phase 5 demo room is synthetic **output**, not an input |
| ARKitScenes raw scene, converted | ~200-300 of the `highres_wide` 1920×1440 frames + `lowres_wide.traj` ARKit poses (interpolated to frame timestamps) + intrinsics | 1,100-1,200 ($11-12) | The best public option: real iPad ARKit room captures at Echo-3's preferred resolution [MEDIUM: web search + paper]. Costs: a new converter script (pose interpolation, EXIF timestamps), a multi-GB download per scene, and license [ASSUMED non-commercial CC BY-NC-SA; verify the LICENSE file] |
| **Owner's own room after Phase 8** | ~200-400 frames native | 1,100-1,300 ($11-13) | **Recommended.** It exercises the real capture path, and there's no conversion layer to blame. It defers SC2's paid part to Phase 8. The automated replay (D-07 synthetic set) still closes the automated half of SC2 in Phase 6 |

Key fact for the owner: the **900-credit base fee dominates**. Going from 30 to 300 frames adds only $2.70, so never pick a "minimum-frame" bundle that can't reconstruct a room. Echo-3 cadence guidance: about 3-5 keyframes/s while moving [CITED: capture-worlds.md].

Runbook checklist items the research surfaced:
- The SpAItial plan must have API access (not Free), with balance ≥ quote.
- Set the vars on **api and worker**: `PROVIDER_MODE=live`, `ALLOW_PAID_PROVIDER=1`, `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET` (from the Developer Portal → Webhooks), `DAILY_CREDIT_BUDGET` = quote + about 300 (e.g. 1,500 for a 1,200 run, so `BUDGET_ALERT_SHARE=0.8` crosses on that one run and SC4's manual check fires), and a similar `MONTHLY_CREDIT_BUDGET`.
- Watch: worker logs (`[pipeline]`, `[budget-alert]`), `worlds` row, `credit_events` (exactly one `reserve` for `provider_mode='live'`), `webhook_deliveries`.
- Abort: `DELETE /v1/worlds/:id` → track job cancels the provider request (refund).
- Revert: unset all four vars on both services, redeploy.
- Ask SpAItial support: the idempotency retention window, concurrent same-key behaviour, and the top-level `error.code` for validation failures.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 202 body has fields beyond `request_id` (`status_url` etc.). Only `request_id` is used | API Contract | none (we read only `request_id`) |
| A2 | Export status enum = `PROCESSING/READY/FAILED/NOT_REQUESTED`; GET on an unrequested export returns `NOT_REQUESTED` or 404 | Pattern 1 | ensureExport mis-maps → import snoozes; fix after the first paid run with the recorded responses |
| A3 | `world.thumbnail_url` on `img.spaitial.ai` is fetchable without auth | Artifact mapping | the thumbnail is skipped (Pitfall 11 guard makes it harmless) |
| A4 | undici strips `Authorization` on cross-origin redirects | Pattern 1 | moot, since we use `redirect:'manual'` |
| A5 | Same-key concurrent in-flight requests replay rather than 409 | Idempotency | a double-run is prevented by the lease anyway (Pitfall 6) |
| A6 | JSONB → JS → `JSON.stringify` is byte-stable across reads | Pitfall 1 | key replay sees a "different body" → 409 park; detected by the 409 log |
| A7 | ARKitScenes license is non-commercial share-alike; raw has `highres_wide` 1920×1440 + ARKit traj | Paid-run input | owner verifies before converting |
| A8 | R2 presigned URL max lifetime 7 days | Bundle URL | 24 h default is well within it either way |
| A9 | Top-level `error.code` for async validation failures is undocumented (handled by scanning the message) | Pitfall 8 | wrong retryable flag; the ledger is unaffected and FAILED is free |

## Open Questions

1. **Processing-stage unknown codes: retryable or not?** D-08 has wording in both directions. Recommendation: any non-validation provider code is retryable (FAILED = 0 credits); the generic `FAILED` fallback is not. Planner confirms.
2. **Where does the retry sheet get `frame_count`?** UI-SPEC assumes a `worlds` column that doesn't exist. Recommendation: correlated subquery `(SELECT frame_count FROM captures c WHERE c.world_id = worlds.id ORDER BY created_at DESC LIMIT 1)` in the list and detail serializers.
3. **Charge `DAILY_SCAN_QUOTA` on retry?** Not decided. Recommendation: no (budget caps and the create rate-limit already guard money). Planner notes it.
4. **SC2 paid part in Phase 6 or Phase 8?** This is the owner's call per D-15. Phase 6 delivers the runbook plus the synthetic replay test either way.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Node | backend tests | ✓ | 22.21.1 locally (engines ≥24; Railway image uses 24) | fetch/AbortSignal.timeout/Readable.fromWeb all exist in 22 |
| Neon dev branch (`MIGRATE_DATABASE_URL` in `backend/.env`) | pg suites, migrate:dev | ✓ (var present; value not read) | — | none: the pg tests skip without it |
| R2 dev bucket | not needed (harness uses local storage over http) | — | — | — |
| SpAItial API | **never in this phase** | forbidden | — | fake-echo3 |
| Railway CLI | D-16 deploy | assumed (prior phases deployed) | — | owner deploys |

**Missing dependencies with no fallback:** none for agent work.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | backend: vitest ^2.1 (node env, 30 s test timeout); app: jest-expo 58 + Jest 30 + RNTL 14 |
| Config file | `backend/vitest.config.ts` (add `setupFiles: ['test/setup-no-spaitial.ts']`); `virtumetry/package.json` `jest` block |
| Quick run command | `cd backend && npx vitest run test/echo3.client.test.ts test/retryable.test.ts test/config.test.ts` |
| Full suite command | `cd backend && npx vitest run && node --env-file=.env scripts/test-pg.mjs` ; `cd virtumetry && npx jest --ci && npx tsc --noEmit && npx expo lint` ; `cd backend && npm run typecheck` |

### Phase Requirements → Test Map
| ID | Req / SC | Behavior | Type | Automated Command | File Exists? |
|----|----------|----------|------|-------------------|-------------|
| V1 | PROC-05 / SC1 | echo3 client: auth header, exact body bytes, error/Retry-After mapping, timeout, 302 w/o auth, ref allowlist, 409 cancel = ok | unit (fake http) | `npx vitest run test/echo3.client.test.ts` | ❌ Wave 0 |
| V2 | PROC-05 / SC1 | kill mid-submit → billed 1, same rid, one reserve | pg integration | `node --env-file=.env scripts/test-pg.mjs test/integration/echo3-contract.pg.test.ts` | ❌ |
| V3 | PROC-05 / SC1 | concurrent double handleSubmit → billed 1 | pg | same file | ❌ |
| V4 | PROC-05 / SC1 | drop-after-accept, timeout, 429, 503 → billed 1; 409 parks; 401 definitive + released | pg | same file | ❌ |
| V5 | PROC-05 / SC1 | kill mid-submit against the **mock** | pg | `… scripts/test-pg.mjs test/integration/scenarios.pg.test.ts` | ✅ (add case) |
| V6 | SC2 (automated half) | replay set: submit → track → exports → import → ready, `splat.spz` re-hosted, floorplan_meta stored | pg | `… test/integration/echo3-contract.pg.test.ts -t replay` | ❌ (+ `test/fixtures/echo3-recorded/`) |
| V7 | LIB-02 / SC3 | `isRetryable` truth table (every D-08 code, the validation-token scan, unknowns) | unit | `npx vitest run test/retryable.test.ts` | ❌ |
| V8 | LIB-02 / SC3 | retry route: 404 non-owner, 409 not retryable, 409 ledger-held, 400 below quote, success resets columns + new key + `submit_attempt+1` + job enqueued + `world_attempts` row, idempotent replay, two concurrent → one wins, retried world reaches ready with billed 2 distinct keys | pg | `… test/integration/retry.pg.test.ts` | ❌ |
| V9 | OPS-06 / SC4 | crossing share inserts one alert per window, second reservation same window → no new row/push, push+warn called after commit, push throw doesn't fail submit, `budgetAlert` on `GET /v1/worlds` + `/v1/quote` | pg + unit | `… test/integration/budget-alert.pg.test.ts` | ❌ |
| V10 | LIB-02 / SC3 | Library: failed row pressable, "Retry…" menu item only when `retryable` | RNTL | `cd virtumetry && npx jest src/__tests__/library-actions.test.tsx` | ✅ (extend) |
| V11 | LIB-02 / SC3 | retry sheet: fresh quote, approve disabled over budget, same Idempotency-Key across presses, 409 hides primary, non-retryable shows "Scan again" and no quote call | RNTL | `npx jest src/__tests__/world-retry.test.tsx` | ❌ |
| V12 | OPS-06 | banner renders from `budgetAlert`, dismiss per window per session | RNTL | `npx jest src/__tests__/library.test.tsx` | ✅ (extend) |
| V13 | money rule | config: live needs ALLOW + both keys + https base; any test fetch to `*.spaitial.ai` throws | unit | `npx vitest run test/config.test.ts` | ✅ (extend) + setup file ❌ |
| V14 | LIB-03 regression | purge deletes `world_attempts` + provider-deletes archived request ids | pg | `… test/integration/purge-cascade.pg.test.ts` | ✅ (extend) |
| M1 | SC2 | first paid run: one request id, ready, viewer opens, recorded set written | manual (owner, runbook) | — | 06-HUMAN-UAT.md |
| M2 | SC3 | Expo Go: failed (mock `failed`) row → Retry → approve → processing → ready | manual | — | 06-HUMAN-UAT.md |
| M3 | SC4 | alert visible in logs and banner during the live run | manual | — | 06-HUMAN-UAT.md |

### Sampling Rate
- **Per task commit:** quick run (unit files touched) + `npm run typecheck` (backend) or `npx tsc --noEmit` (app)
- **Per wave merge:** full backend vitest + the pg suites touched in the wave + full app jest
- **Phase gate:** everything green, including all of `scripts/test-pg.mjs`, before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `backend/test/helpers/fake-echo3.ts`: fake server (idempotency, scripts, billed count, replay mode, cross-origin `/signed/` redirect)
- [ ] `backend/test/helpers/pipeline.ts`: injectable provider option
- [ ] `backend/test/setup-no-spaitial.ts` + `setupFiles` in `vitest.config.ts`
- [ ] `backend/test/fixtures/echo3-recorded/manifest.json` (`synthetic: true`)
- [ ] migration `drizzle/0005_*` (needed by every pg test that touches new columns, since `createTestSchema` applies committed SQL)

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | yes (outbound API key) | bearer only in the header, never logged; config refuses live without it |
| V3 Session Management | no change | Better Auth (existing) |
| V4 Access Control | yes | retry route uses `findOwnedWorld` (404 for non-owner), the same as rename/delete |
| V5 Input Validation | yes | zod for retry body + `z.guid()` Idempotency-Key; provider responses treated as untrusted (validate `request_id` shape, ref allowlist) |
| V6 Cryptography | yes (webhook HMAC) | existing `verifyWebhookSignature` |
| V10 Malicious code / SSRF | yes | `open()` allowlist of API paths + `*.spaitial.ai` https thumbnail; redirect followed manually |

### Known Threat Patterns
| Pattern | STRIDE | Mitigation |
|---|---|---|
| Double charge via replay/race | Tampering / financial | persisted key + body, provider idempotency, lease, unique `(world_id, attempt)`, optimistic `submit_attempt` |
| Retry of an uncertain-billed attempt | financial | ledger guard (Pitfall 7) |
| API key leak to the storage host or logs | Info disclosure | `redirect:'manual'`; logs carry codes/ids only; failure messages scrub URLs (existing `failWorld`) |
| SSRF via provider-supplied URLs | Elevation | ref allowlist |
| Retry button spam | DoS / financial | create-bucket rate limit + Idempotency-Key + explicit approval + budget caps |
| Webhook replay | Spoofing | existing dedupe + nudge-only |

## Project Constraints (from CLAUDE.md)
- Every real Echo-3 run costs money: the mock is the default, never retry blind, persist request ids before polling, budget caps server-side.
- Data isolation: Neon dev branch only for migrations/tests (`scripts/dev-guard.mjs`); never touch prod or VirtSpace.
- Use `node:crypto` HMAC over raw bytes, constant-time compare (existing).
- No Echo-3 SDK exists, so a thin typed `fetch` client goes behind the provider interface (CLAUDE.md stack table).
- Don't upgrade vitest/TS during this work.
- Run app jest and backend vitest locally or on GitHub Actions, not EAS minutes. **Never run `eas build`** (virtumetry/AGENTS.md). Run lint (`npx expo lint`) + typecheck (`npx tsc --noEmit`) before declaring app tasks done; use `npx expo install` for any app dep (none needed).
- Licensing: the Echo-3 Standard plan is non-commercial (fine for the owner-only test run).
- GSD workflow: edits only via GSD execute.

## Sources

### Primary (HIGH)
- Codebase (read 2026-11-25): `backend/src/{pipeline,budget,config,push,worker,queue}.ts`, `src/provider/{types,index,mock}.ts`, `src/routes/{worlds,scans,webhooks}.ts`, `src/db/schema.ts`, `drizzle/`, `test/helpers/{pipeline,pg-schema}.ts`, `test/integration/{pipeline,scenarios}.pg.test.ts`, `scripts/{test-pg,migrate-dev,dev-guard}.mjs`, `virtumetry/src/{library/display-state.ts,lib/api.ts,viewer/engine.ts,viewer/coords.ts}`, `06-UI-SPEC.md`
- https://docs.spaitial.ai/llms.txt: page index
- https://docs.spaitial.ai/api/authentication.md: base URL, Bearer `spt_live_`, scopes
- https://docs.spaitial.ai/api/worlds.md: create/idempotency/status/envelope/cancel/delete
- https://docs.spaitial.ai/api/capture-worlds.md: limits, quote, pricing, frame/resolution rules, ZIP URL, validation codes, 0 credits on FAILED
- https://docs.spaitial.ai/api/errors.md: envelope, full code table, retry rules, retention undocumented
- https://docs.spaitial.ai/api/exports.md: export types/paths/302/floorplan block
- https://docs.spaitial.ai/api/rate-limits.md: buckets, headers, Retry-After seconds
- https://docs.spaitial.ai/api/credits-billing.md: $0.01/credit, 900+n, refunds on failed/cancelled, plans
- https://docs.spaitial.ai/api/webhooks.md: headers/events/body/retries
- https://docs.spaitial.ai/api/llm-skills.md: status enum incl. CANCELLED, no sandbox, openapi location (not fetched, since it's on the forbidden host)

### Secondary (MEDIUM)
- https://github.com/spaitial-ai/spaitial-capture-prototype/tree/main/samples: minimal-bundle is 3 synthetic placeholder frames
- `.planning/phases/02-bundle-pipeline-mock-provider/02-RESEARCH.md`: prior contract + TUM fixture facts
- [ARKitScenes repo](https://github.com/apple/ARKitScenes), [ARKitScenes paper](https://arxiv.org/abs/2111.08897): raw highres 1920×1440 + ARKit poses (DATA.md returned 503; license unverified)

### Tertiary (LOW)
- undici cross-origin Authorization stripping (training knowledge; avoided by design)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (no new deps; stdlib)
- API contract: MEDIUM-HIGH (docs fetched; reference pages are thin, OpenAPI not fetchable under the money rule)
- Architecture / existing-code gaps: HIGH (read directly from source)
- Pitfalls: HIGH for codebase gaps, MEDIUM for provider-behaviour edges
- Paid-run input: MEDIUM

**Research date:** 2026-11-25
**Valid until:** 2026-12-25 (re-check docs.spaitial.ai release notes before the paid run)
