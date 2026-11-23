# Phase 2: Bundle Pipeline & Mock Provider - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning
**Mode:** auto (all gray areas resolved with the recommended option; see 02-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

Backend-only. The on-disk capture session format is fixed (schema 1). A session stored in R2 under `captures/{captureId}/` is turned by the worker into a valid Echo-3 capture-bundle ZIP on R2 (OpenCV poses, intrinsics, EXIF timestamps, store-only, Range-capable 24 h presigned URL), then runs pack → submit → track → import → ready against the **mock** provider, with outputs re-hosted in our R2, HMAC-verified/deduplicated webhooks as nudges only, scripted failures, and an atomic daily + monthly credit reservation. All at $0. Requirements: PROC-04, PROC-06, PROC-07, PROC-08, PROC-10.

Not in this phase: live Echo-3 client (`echo3.ts`, Phase 6), auth/Better Auth and the scan/upload HTTP API used by the app (Phase 3/4), app changes, viewer (Phase 5), push (Phase 7), retention/lifecycle (Phase 9).

</domain>

<decisions>
## Implementation Decisions

### Session format (the contract — schema 1)
- **D-01:** On-disk / R2 session format is exactly the ARCHITECTURE.md contract: `session.json` (`{ sessionId, schema: 1, device, appVersion, imageWidth, imageHeight, startedAtISO, tzOffset, gateConfig }`), `frames.jsonl` (one line per kept frame: `{ i, file: "frames/000001.jpg", t, wallMs, T_arkit: [16 floats column-major camera.transform], K: {fx,fy,cx,cy}, tracking, blurPx?, expS? }`), `frames/000001.jpg …` (1-indexed, 6-digit, contiguous, identical size, no EXIF). Raw ARKit values only; all conversion happens in the backend. In R2: `captures/{captureId}/session.json`, `captures/{captureId}/frames.jsonl`, `captures/{captureId}/frames/000001.jpg`.
- **D-02:** A zod schema for `session.json` and each `frames.jsonl` line lives in `backend/src/bundle/manifest.ts` and is the single source of truth (Phase 3/4 app hand-copies the TS type). Unknown `schema` versions are rejected.

### Bundle building
- **D-03:** Code lives in `backend/src/bundle/{manifest,convert,exif,validate,pack}.ts`. `convert.ts` exports a pure `arkitToOpenCV(T_colMajor16) -> rowMajor16` = `D · inv(T)` with `D = diag(1,-1,-1,1)`, transposed to row-major, metres untouched. Unit tests: known camera at (0,1.5,0) looking down −Z, bottom row `[0,0,0,1]`, det(R)=+1, round-trip.
- **D-04:** Echo-3 capture-bundle layout (file names inside the ZIP, intrinsics/poses JSON schema, `orientation.json` if any) is taken from docs.spaitial.ai capture-bundle docs by the researcher — the docs are authoritative; if they differ from research notes, docs win. The packer writes exactly that layout.
- **D-05:** EXIF: insert `DateTimeOriginal`, `SubSecTimeOriginal` (3 digits), `OffsetTimeOriginal` (from `session.tzOffset`) from `wallMs` into an APP1 segment right after SOI, within the first 64 KiB. Prefer a small hand-written EXIF writer (3 tags + ExifIFD pointer, no new dependency); a tiny well-maintained lib is acceptable only if the hand-written one is not clearly simpler. Strictly increasing timestamps asserted before writing.
- **D-06:** Validation runs before and during pack, failing as `failed`/stage `validate` with 0 credits: identical dimensions, long edge ≤1920, short edge ≥360, contiguous 1-indexed names matching `frames.jsonl`, strictly increasing `wallMs`, `fx,fy ∈ [100,10000]`, `0<cx<w`, `0<cy<h`, frame count within provider `limits()`, valid 4x4 (orthonormal R, bottom row), plus semantic checks: camera-centre jump ≤0.5 m between adjacent frames, `tracking == "normal"`. Thresholds are named constants.
- **D-07:** Pack streams: R2 GET per frame → EXIF insert (per-frame buffer is fine, frames are ≤12 MB) → `yazl` with `compress:false` → `@aws-sdk/lib-storage` `Upload` (fixed partSize 16 MiB) to `bundles/{captureId}/capture_bundle.zip`. The ZIP is never held whole in memory. Local storage driver gets an equivalent stream path for tests. Record `bundle_key` and `bundle_bytes`.
- **D-08:** Bundle presigned GET TTL = **24 h** (direct `*.r2.cloudflarestorage.com` endpoint). The worker runs a Range preflight (`Range: bytes=0-15` → 206) before submit; the mock provider additionally reads the ZIP central directory through the presigned URL via Range.

### Fixture session
- **D-09:** Fixture = converted from a **public, permissively licensed posed RGB dataset** (researcher picks; preference order: CC-BY datasets such as TUM RGB-D, then ARKitScenes if its license permits redistribution of a few frames in a private repo; licence noted in a README next to the fixture). A one-off Node script under `backend/scripts/` converts it into session format with raw ARKit-convention `T_arkit` (column-major world_from_camera, y-up, camera looks −Z) and `K`, so `arkitToOpenCV` is exercised end-to-end.
- **D-10:** Committed fixture `backend/test/fixtures/tiny-session/`: ~30 frames, ≥360 px short edge (e.g. 640x480), total ≤ ~3 MB. No large fixtures in git; larger sessions/outputs may go to `virtumetry-dev` R2 under `fixtures/` only.

### Provider interface & mock
- **D-11:** Replace the World Labs-shaped `WorldGenProvider` with the `ReconProvider` interface from ARCHITECTURE.md (`limits`, `quote`, `submit(body, idempotencyKey)`, `status`, `ensureExport`, `artifacts`, `open` (stream), `cancel`, `verifyWebhook`). Remove `MODEL_CREDITS`/`findWorldByDisplayName`/display-name reconciliation. `PROVIDER_MODE` stays `mock|live`; live still throws "Phase 6" and still needs `ALLOW_PAID_PROVIDER=1`.
- **D-12:** Mock quote = `900 + frameCount` credits (Echo-3 pricing shape) so budget logic is exercised for real; mock never touches the network except reading our own presigned ZIP URL (Range) and optionally POSTing a signed webhook to our own endpoint.
- **D-13:** Scripted scenarios: `happy`, `failed` (status FAILED with issues), `402`, `409`, `429`, `503`, `duplicate_webhooks`, `webhook_dropped`. Selected per provider instance in tests; `MOCK_SCENARIO` env (default `happy`) for manual/dev runs; `MOCK_PROCESSING_SECONDS` (default small) controls time-to-complete. 429/503 honour `Retry-After` and are retried with the **same key and same persisted body**; 402 → failed/submit (released); 409 → park dead + loud log, never a new key; FAILED → failed/processing, released, `charged=false`.
- **D-14:** Mock outputs: small committed placeholder files under `backend/test/fixtures/mock-outputs/` covering every artifact kind — splat (`.spz` or `.ply`, tiny valid), `mesh-simplified` (tiny PLY), floor plan PNG + affine/meta JSON, `cameras.json` (derived from the fixture poses). Real public sample splats for the viewer are a Phase 5 concern (may be placed in dev R2 `fixtures/`).

### State machine, jobs, money path
- **D-15:** World status replaces the Phase 1 set with: `uploading → packing → submitting → processing → importing → ready`, plus `failed` (with `failure_stage ∈ {upload,validate,pack,submit,processing,import}`, `failure_code`, `failure_message`, `charged`) and `cancelled`. New migration via `drizzle-kit generate` (0001) + `src/migrate.ts` against the Neon **dev** branch direct host only; never `drizzle-kit push`. Schema additions per ARCHITECTURE.md §"Echo-3 Job State Machine" (worlds: `approved_max_credits`, `quoted_credits`, `submission_key`, `submit_body jsonb`, `provider_request_id` unique, failure columns, asset keys `splat_key`, `collider_key`, `floorplan_key`, `floorplan_meta jsonb`, `cameras_key`, `thumbnail_key`; captures: `manifest_key`, `bundle_key`, `bundle_bytes`, `image_w/h`; new `webhook_deliveries(delivery_id pk, request_id, event, received_at)`). World-Labs asset columns (`spz_*_url`, `collider_glb_url`) are dropped.
- **D-16:** Job kinds `pack`, `submit`, `track`, `purge`. Add `snoozeJob(jobId, seconds)` to `queue.ts` (requeue without consuming an attempt). `track` never holds a lease across polls. Only `track` writes processing/importing/ready state.
- **D-17:** The provider-agnostic submit state machine (persist `submission_key` and byte-identical `submit_body` before the first call, persist `provider_request_id` + status + enqueue track in one transaction, no automatic new key ever) is built **now** against the mock, so Phase 6 only adds `echo3.ts`. Submit retry backoff capped (≤15 min, 4 attempts).
- **D-18:** Budget: daily **and** monthly caps (`DAILY_CREDIT_BUDGET`, new `MONTHLY_CREDIT_BUDGET`), UTC windows. Reservation is one atomic operation keyed on `submission_key` (unique; `ON CONFLICT DO NOTHING` makes a resumed submit not double-reserve), serialized so two concurrent reservations that together exceed a cap yield exactly one success. Over-budget → `failed/submit` code `BUDGET_EXCEEDED` before any provider `submit` call. FAILED/CANCELLED/402/400 → compensating release. Ledger rows carry the provider mode so mock spends never count against a live budget.
- **D-19:** Import: stream every artifact via `provider.open()` into R2 at `worlds/{worldId}/v{assetVersion}/<name>` (idempotent per key, resumable artifact-by-artifact), then one UPDATE sets all asset keys + `status=ready` + `charged=true`. `downloadAsset(): Buffer` is replaced by streams.

### Webhooks
- **D-20:** Route `POST /v1/webhooks/spaitial`, excluded from auth, separately rate-limited, scoped raw-buffer content-type parser. Verify `X-Spaitial-Signature: sha256=<hex HMAC-SHA256(SPAITIAL_WEBHOOK_SECRET, rawBody)>` with the existing constant-time compare helper (`secretEquals`-style; no `===`). Insert `webhook_deliveries` `ON CONFLICT DO NOTHING`; duplicate → 200 no-op; then set the matching queued `track` job's `run_after=now()`. Invalid signature → 401, no DB write. Exact header names / payload fields come from SpAItial webhook docs (researcher confirms). Mock produces deliveries signed with the same secret (tests use a test secret; never print the real one).
- **D-21:** With webhooks dropped, polling (snoozed `track`, ~60 s in prod, configurable and tiny in tests) reaches the terminal state on its own.

### Tests & evidence
- **D-22:** Automated: `arkitToOpenCV` unit tests; ZIP structure + EXIF validator test on the packed fixture; pack→submit→track→ready integration test (Postgres via `TEST_DATABASE_URL` = Neon dev direct, set in-process; local storage driver or dev R2); webhook tests (valid, invalid signature, duplicate); scenario tests for FAILED/402/409/429/503/duplicate webhooks asserting final state and exactly one `submit` call (or zero where refused); concurrency test for budget reservation. Range preflight test against `virtumetry-dev` R2, skipped when S3 env is absent. Existing 229 unit tests stay green; `tsc --noEmit` clean.
- **D-23:** A dev script (e.g. `npm run fixture:e2e`) uploads the tiny fixture to `virtumetry-dev` R2 and drives the full loop with the mock — manual evidence and Phase 4's backend half. Never against `virtumetry-prod`.

### Claude's Discretion
- Whether existing `/v1/worlds` routes are trimmed now or left for Phase 3 to reshape (no new app-facing upload routes are required in Phase 2; tests seed R2 directly). Keep diffs minimal.
- Exact retry/backoff numbers, poll interval config names, and module split inside `bundle/`.
- Whether `cameras.json` for the mock is generated at mock time or committed.
- Plan count / wave structure.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project scope
- `.planning/ROADMAP.md` — Phase 2 goal and the 5 success criteria (the acceptance bar)
- `.planning/REQUIREMENTS.md` — PROC-04, PROC-06, PROC-07, PROC-08, PROC-10 (and PROC-05 for the submit contract shape)
- `.planning/PROJECT.md` — money/isolation constraints
- `CLAUDE.md` — stack decisions (yazl, lib-storage, node:crypto HMAC, scoped raw-body parser)

### Research
- `.planning/research/ARCHITECTURE.md` — §Contracts (session format, ReconProvider), §Where the ZIP Is Built, §Data Flow, §Echo-3 Job State Machine (submit/track), §R2 Storage Layout, Patterns 3–5, Anti-Patterns 1–5
- `.planning/research/PITFALLS.md` — P1 (pose conversion), P2 (double submit), P3 (presign/Range), P4 (EXIF), P11 (budget race), P16 (webhooks), P20 (re-host outputs)
- `.planning/research/STACK.md` — yazl / lib-storage / webhook details
- `.planning/research/SUMMARY.md` — settled decisions (24 h bundle presign, snooze)

### External (authoritative for formats)
- https://docs.spaitial.ai — capture-bundle format, `POST /v1/worlds`, status, exports, webhooks (headers, signature), limits/quote. Read-only; NEVER call the API.

### Phase 1 (what exists)
- `.planning/phases/01-isolated-backend-fork/01-CONTEXT.md` — decisions D-01..D-16 (isolation, migrations, guards)
- `.planning/phases/01-isolated-backend-fork/01-VERIFICATION.md` — current test baseline (229 passed / 12 skipped)
- `backend/README.md` — subsystem docs

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `backend/src/budget.ts` — `reserveCredits` (advisory-lock + ledger, daily only), `releaseCredits` (compensating row), UTC day window. Extend with monthly + `submission_key` uniqueness; drop `creditsForModel` dependency.
- `backend/src/queue.ts` — Postgres SKIP LOCKED leases, `enqueue`, `claimNextJob`, `failJob`, `parkJobDead`, `heartbeatJob`, backoff. Add `snoozeJob`. `setProviderOperationId`/`clearProviderOperationId` belong to the old pending-marker design and can go.
- `backend/src/worker.ts` — loop + reapers + `NonRetryableJobError`/`LeaseLostError`; currently only `purge`. Add pack/submit/track handlers.
- `backend/src/storage/{index,s3,local}.ts` — `presignDownload`, `putObject`, `getObject`, `objectSize`; needs stream get/put (or multipart Upload) and possibly `listKeys(prefix)`.
- `backend/src/provider/{types,mock,index}.ts` — to be replaced by ReconProvider + new mock.
- `backend/src/auth.ts` — has a constant-time secret compare to reuse for HMAC.
- `backend/src/config.ts` — zod env, `PROVIDER_MODE`, `ALLOW_PAID_PROVIDER` guard, `SPAITIAL_WEBHOOK_SECRET`, `DAILY_CREDIT_BUDGET`.
- Integration tests pattern: `test/integration/*.pg.test.ts` gated on `TEST_DATABASE_URL`.

### Established Patterns
- Conditional status flips in one statement (`UPDATE … WHERE status IN (…) RETURNING`) — VirtSpace R20/R27.
- zod contracts, Conventional Commits, mock default.

### Integration Points
- `backend/drizzle/0000_init.sql` is the only migration; Phase 2 adds 0001.
- `src/routes/index.ts` registers routes; the webhook route needs to bypass the auth hook.

</code_context>

<specifics>
## Specific Ideas

- Hard rules from the owner for every agent: never call the real SpAItial API; `ALLOW_PAID_PROVIDER` stays unset; never print/commit `.env` values; never touch VirtSpace resources (Neon long-hat-19889473, Railway 1690518b-…, R2 virtspace-assets / propestate-photos); only `virtumetry-dev` for tests and Range preflight, never write to `virtumetry-prod`; migrations via drizzle-kit generate + `src/migrate.ts` on the dev branch (assert dev endpoint host `ep-mute-fog-arwonnkz`, non-pooler); never `eas build`; fixture in git ≤ a few MB.
- Load env with `node --env-file=.env` (POSIX sourcing does not work on this file).

</specifics>

<deferred>
## Deferred Ideas

- App-facing scan create / per-frame presign / `uploads:missing` / `:complete` routes — Phase 3/4.
- Live `echo3.ts` client, weekly openapi diff, first paid run — Phase 6.
- Thumbnail generation from the splat (`@playcanvas/splat-transform`) — later.
- `.RAD` LoD prebuild — Phase 5 decision.
- R2 lifecycle / purge clocks for bundles and frames — Phase 9.

</deferred>

---

*Phase: 02-bundle-pipeline-mock-provider*
*Context gathered: 2026-11-23*
