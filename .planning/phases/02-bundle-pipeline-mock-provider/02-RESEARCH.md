# Phase 2: Bundle Pipeline & Mock Provider - Research

**Researched:** 2026-11-23
**Domain:** Echo-3 capture-bundle format, streaming ZIP to R2, EXIF writing, pose conversion, provider state machine, webhooks, atomic credit budget (Node 24 / Fastify 5 / Drizzle / Postgres)
**Confidence:** HIGH. The format was read from docs.spaitial.ai and cross-checked against SpAItial's MIT-0 reference repo. The EXIF writer and pose converter were run against SpAItial's own reader and sample. The yazl central-directory round-trip was run locally.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Session format (the contract — schema 1)
- **D-01:** On-disk / R2 session format is exactly the ARCHITECTURE.md contract: `session.json` (`{ sessionId, schema: 1, device, appVersion, imageWidth, imageHeight, startedAtISO, tzOffset, gateConfig }`), `frames.jsonl` (one line per kept frame: `{ i, file: "frames/000001.jpg", t, wallMs, T_arkit: [16 floats column-major camera.transform], K: {fx,fy,cx,cy}, tracking, blurPx?, expS? }`), `frames/000001.jpg …` (1-indexed, 6-digit, contiguous, identical size, no EXIF). Raw ARKit values only; all conversion happens in the backend. In R2: `captures/{captureId}/session.json`, `captures/{captureId}/frames.jsonl`, `captures/{captureId}/frames/000001.jpg`.
- **D-02:** A zod schema for `session.json` and each `frames.jsonl` line lives in `backend/src/bundle/manifest.ts` and is the single source of truth (Phase 3/4 app hand-copies the TS type). Unknown `schema` versions are rejected.

#### Bundle building
- **D-03:** Code lives in `backend/src/bundle/{manifest,convert,exif,validate,pack}.ts`. `convert.ts` exports a pure `arkitToOpenCV(T_colMajor16) -> rowMajor16` = `D · inv(T)` with `D = diag(1,-1,-1,1)`, transposed to row-major, metres untouched. Unit tests: known camera at (0,1.5,0) looking down −Z, bottom row `[0,0,0,1]`, det(R)=+1, round-trip.
- **D-04:** Echo-3 capture-bundle layout (file names inside the ZIP, intrinsics/poses JSON schema, `orientation.json` if any) is taken from docs.spaitial.ai capture-bundle docs by the researcher — the docs are authoritative; if they differ from research notes, docs win. The packer writes exactly that layout.
- **D-05:** EXIF: insert `DateTimeOriginal`, `SubSecTimeOriginal` (3 digits), `OffsetTimeOriginal` (from `session.tzOffset`) from `wallMs` into an APP1 segment right after SOI, within the first 64 KiB. Prefer a small hand-written EXIF writer (3 tags + ExifIFD pointer, no new dependency); a tiny well-maintained lib is acceptable only if the hand-written one is not clearly simpler. Strictly increasing timestamps asserted before writing.
- **D-06:** Validation runs before and during pack, failing as `failed`/stage `validate` with 0 credits: identical dimensions, long edge ≤1920, short edge ≥360, contiguous 1-indexed names matching `frames.jsonl`, strictly increasing `wallMs`, `fx,fy ∈ [100,10000]`, `0<cx<w`, `0<cy<h`, frame count within provider `limits()`, valid 4x4 (orthonormal R, bottom row), plus semantic checks: camera-centre jump ≤0.5 m between adjacent frames, `tracking == "normal"`. Thresholds are named constants.
- **D-07:** Pack streams: R2 GET per frame → EXIF insert (per-frame buffer is fine, frames are ≤12 MB) → `yazl` with `compress:false` → `@aws-sdk/lib-storage` `Upload` (fixed partSize 16 MiB) to `bundles/{captureId}/capture_bundle.zip`. The ZIP is never held whole in memory. Local storage driver gets an equivalent stream path for tests. Record `bundle_key` and `bundle_bytes`.
- **D-08:** Bundle presigned GET TTL = **24 h** (direct `*.r2.cloudflarestorage.com` endpoint). The worker runs a Range preflight (`Range: bytes=0-15` → 206) before submit; the mock provider additionally reads the ZIP central directory through the presigned URL via Range.

#### Fixture session
- **D-09:** Fixture = converted from a **public, permissively licensed posed RGB dataset** (researcher picks; preference order: CC-BY datasets such as TUM RGB-D, then ARKitScenes if its license permits redistribution of a few frames in a private repo; licence noted in a README next to the fixture). A one-off Node script under `backend/scripts/` converts it into session format with raw ARKit-convention `T_arkit` (column-major world_from_camera, y-up, camera looks −Z) and `K`, so `arkitToOpenCV` is exercised end-to-end.
- **D-10:** Committed fixture `backend/test/fixtures/tiny-session/`: ~30 frames, ≥360 px short edge (e.g. 640x480), total ≤ ~3 MB. No large fixtures in git; larger sessions/outputs may go to `virtumetry-dev` R2 under `fixtures/` only.

#### Provider interface & mock
- **D-11:** Replace the World Labs-shaped `WorldGenProvider` with the `ReconProvider` interface from ARCHITECTURE.md (`limits`, `quote`, `submit(body, idempotencyKey)`, `status`, `ensureExport`, `artifacts`, `open` (stream), `cancel`, `verifyWebhook`). Remove `MODEL_CREDITS`/`findWorldByDisplayName`/display-name reconciliation. `PROVIDER_MODE` stays `mock|live`; live still throws "Phase 6" and still needs `ALLOW_PAID_PROVIDER=1`.
- **D-12:** Mock quote = `900 + frameCount` credits (Echo-3 pricing shape) so budget logic is exercised for real; mock never touches the network except reading our own presigned ZIP URL (Range) and optionally POSTing a signed webhook to our own endpoint.
- **D-13:** Scripted scenarios: `happy`, `failed` (status FAILED with issues), `402`, `409`, `429`, `503`, `duplicate_webhooks`, `webhook_dropped`. Selected per provider instance in tests; `MOCK_SCENARIO` env (default `happy`) for manual/dev runs; `MOCK_PROCESSING_SECONDS` (default small) controls time-to-complete. 429/503 honour `Retry-After` and are retried with the **same key and same persisted body**; 402 → failed/submit (released); 409 → park dead + loud log, never a new key; FAILED → failed/processing, released, `charged=false`.
- **D-14:** Mock outputs: small committed placeholder files under `backend/test/fixtures/mock-outputs/` covering every artifact kind — splat (`.spz` or `.ply`, tiny valid), `mesh-simplified` (tiny PLY), floor plan PNG + affine/meta JSON, `cameras.json` (derived from the fixture poses). Real public sample splats for the viewer are a Phase 5 concern (may be placed in dev R2 `fixtures/`).

#### State machine, jobs, money path
- **D-15:** World status replaces the Phase 1 set with: `uploading → packing → submitting → processing → importing → ready`, plus `failed` (with `failure_stage ∈ {upload,validate,pack,submit,processing,import}`, `failure_code`, `failure_message`, `charged`) and `cancelled`. New migration via `drizzle-kit generate` (0001) + `src/migrate.ts` against the Neon **dev** branch direct host only; never `drizzle-kit push`. Schema additions per ARCHITECTURE.md §"Echo-3 Job State Machine" (worlds: `approved_max_credits`, `quoted_credits`, `submission_key`, `submit_body jsonb`, `provider_request_id` unique, failure columns, asset keys `splat_key`, `collider_key`, `floorplan_key`, `floorplan_meta jsonb`, `cameras_key`, `thumbnail_key`; captures: `manifest_key`, `bundle_key`, `bundle_bytes`, `image_w/h`; new `webhook_deliveries(delivery_id pk, request_id, event, received_at)`). World-Labs asset columns (`spz_*_url`, `collider_glb_url`) are dropped.
- **D-16:** Job kinds `pack`, `submit`, `track`, `purge`. Add `snoozeJob(jobId, seconds)` to `queue.ts` (requeue without consuming an attempt). `track` never holds a lease across polls. Only `track` writes processing/importing/ready state.
- **D-17:** The provider-agnostic submit state machine (persist `submission_key` and byte-identical `submit_body` before the first call, persist `provider_request_id` + status + enqueue track in one transaction, no automatic new key ever) is built **now** against the mock, so Phase 6 only adds `echo3.ts`. Submit retry backoff capped (≤15 min, 4 attempts).
- **D-18:** Budget: daily **and** monthly caps (`DAILY_CREDIT_BUDGET`, new `MONTHLY_CREDIT_BUDGET`), UTC windows. Reservation is one atomic operation keyed on `submission_key` (unique; `ON CONFLICT DO NOTHING` makes a resumed submit not double-reserve), serialized so two concurrent reservations that together exceed a cap yield exactly one success. Over-budget → `failed/submit` code `BUDGET_EXCEEDED` before any provider `submit` call. FAILED/CANCELLED/402/400 → compensating release. Ledger rows carry the provider mode so mock spends never count against a live budget.
- **D-19:** Import: stream every artifact via `provider.open()` into R2 at `worlds/{worldId}/v{assetVersion}/<name>` (idempotent per key, resumable artifact-by-artifact), then one UPDATE sets all asset keys + `status=ready` + `charged=true`. `downloadAsset(): Buffer` is replaced by streams.

#### Webhooks
- **D-20:** Route `POST /v1/webhooks/spaitial`, excluded from auth, separately rate-limited, scoped raw-buffer content-type parser. Verify `X-Spaitial-Signature: sha256=<hex HMAC-SHA256(SPAITIAL_WEBHOOK_SECRET, rawBody)>` with the existing constant-time compare helper (`secretEquals`-style; no `===`). Insert `webhook_deliveries` `ON CONFLICT DO NOTHING`; duplicate → 200 no-op; then set the matching queued `track` job's `run_after=now()`. Invalid signature → 401, no DB write. Exact header names / payload fields come from SpAItial webhook docs (researcher confirms). Mock produces deliveries signed with the same secret (tests use a test secret; never print the real one).
- **D-21:** With webhooks dropped, polling (snoozed `track`, ~60 s in prod, configurable and tiny in tests) reaches the terminal state on its own.

#### Tests & evidence
- **D-22:** Automated: `arkitToOpenCV` unit tests; ZIP structure + EXIF validator test on the packed fixture; pack→submit→track→ready integration test (Postgres via `TEST_DATABASE_URL` = Neon dev direct, set in-process; local storage driver or dev R2); webhook tests (valid, invalid signature, duplicate); scenario tests for FAILED/402/409/429/503/duplicate webhooks asserting final state and exactly one `submit` call (or zero where refused); concurrency test for budget reservation. Range preflight test against `virtumetry-dev` R2, skipped when S3 env is absent. Existing 229 unit tests stay green; `tsc --noEmit` clean.
- **D-23:** A dev script (e.g. `npm run fixture:e2e`) uploads the tiny fixture to `virtumetry-dev` R2 and drives the full loop with the mock — manual evidence and Phase 4's backend half. Never against `virtumetry-prod`.

### Claude's Discretion
- Whether existing `/v1/worlds` routes are trimmed now or left for Phase 3 to reshape (no new app-facing upload routes are required in Phase 2; tests seed R2 directly). Keep diffs minimal.
- Exact retry/backoff numbers, poll interval config names, and module split inside `bundle/`.
- Whether `cameras.json` for the mock is generated at mock time or committed.
- Plan count / wave structure.

### Deferred Ideas (OUT OF SCOPE)
- App-facing scan create / per-frame presign / `uploads:missing` / `:complete` routes — Phase 3/4.
- Live `echo3.ts` client, weekly openapi diff, first paid run — Phase 6.
- Thumbnail generation from the splat (`@playcanvas/splat-transform`) — later.
- `.RAD` LoD prebuild — Phase 5 decision.
- R2 lifecycle / purge clocks for bundles and frames — Phase 9.
</user_constraints>

## Project Constraints (from CLAUDE.md)

- **Money:** never call the real SpAItial/Echo-3 API. Mock and fixtures are the default. `ALLOW_PAID_PROVIDER` stays unset. Persist request ids before polling. Budget caps are enforced server-side. Never retry blind.
- **Isolation:** new Neon DB and Railway project only. Never touch VirtSpace (Neon `long-hat-19889473`, Railway `1690518b-…`, R2 `virtspace-assets` / `propestate-photos`). Tests and preflight use only `virtumetry-dev`, never `virtumetry-prod`.
- **Stack (prescribed):** `yazl` with `compress:false`, plus `@aws-sdk/lib-storage` `Upload` with a fixed partSize for R2. Webhook HMAC is `node:crypto` over the raw body, through a scoped Fastify buffer parser, a constant-time compare (`secretEquals`), and a unique `delivery_id`. No Echo-3 npm SDK exists, so use plain `fetch` (Phase 6). Do the ARKit→OpenCV conversion in TypeScript.
- **Don't upgrade during the copy:** vitest stays `^2.1` and TS stays 5.x. Add `@aws-sdk/lib-storage` at the **same version as `@aws-sdk/client-s3`** (installed: 3.1134.0).
- **Migrations:** `drizzle-kit generate` + `src/migrate.ts` on the dev **direct** host (`ep-mute-fog-arwonnkz`, non-pooler). Never `drizzle-kit push`.
- **Secrets:** never print or commit `.env` values. Load env with `node --env-file=.env`.
- **Never `eas build`.** Keep the git fixture ≤ a few MB. Follow the GSD workflow (`/gsd-execute-phase`) for repo edits.
- **Ponytail:** reuse existing code (`secretEquals`, `budget.ts`, `queue.ts`, conditional-UPDATE flips) and add no deps where a few lines suffice.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROC-04 | ARKit→OpenCV `camera_from_world`, intrinsics + EXIF, valid store-only bundle ZIP on R2, Range presign ≥24 h | §Echo-3 Capture Bundle Contract (exact layout/schemas), Code Examples 1–4 (verified converter, EXIF writer, packer, CD reader), Pitfalls 1–5, TUM fixture recipe |
| PROC-06 | Signed webhooks (HMAC, dedupe on `delivery_id`) + polling fallback; webhooks only nudge | §Webhook contract (exact headers/payload), Code Example 6 (scoped raw parser + `secretEquals`), Pattern "nudge" SQL, Pitfall 8 |
| PROC-07 | Copy all outputs (splat, `mesh-simplified`, floor plan + affine, `cameras.json`) into our storage before ready | §Outputs contract (routes, 302, floorplan meta shape, cameras.json shape), import pattern, `putStream` storage addition |
| PROC-08 | Hard daily + monthly budget, atomic reservation, refused before spend | Code Example 7 (advisory-lock reservation with `submission_key`), Pitfall 6 (cross-day release bug in current ledger) |
| PROC-10 | Mock provider default with scripted FAILED/402/409/429/503/duplicate webhooks | §Mock provider design, Echo-3 error catalog (codes, Retry-After, WORLD_USER_LIMIT), scenario test map |
</phase_requirements>

## Summary

The Echo-3 contract is fully documented. SpAItial also publishes an **MIT-0 reference repo** (`spaitial-ai/spaitial-capture-prototype`) with a TypeScript bundle validator, an EXIF reader and a 3-frame sample bundle. That removes most of the format guesswork. The bundle is `images/Image_%06d.jpg` (1-indexed, contiguous) plus `cameras/per_frame_intrinsics.json` (parallel arrays `fx_px/fy_px/cx_px/cy_px` + `frame_count/width_px/height_px`) and `cameras/camera_trajectory.json`, which is a **nested `[N][4][4]` row-major** array of OpenCV `camera_from_world` matrices, not flat 16-vectors. `orientation.json` is optional, and the reference app **does not write it**. Write neither `orientation.json` nor `camera_intrinsics.json`. That settles the PITFALLS P21 open question for Phase 2.

Two candidate core routines were written and run in this session. The hand-written EXIF APP1 writer (106 bytes, big-endian TIFF, IFD0 → ExifIFD with three ASCII tags) produced output **byte-identical to the APP1 Pillow wrote in SpAItial's sample JPEG**, and SpAItial's own `readCaptureExif` reads it back with the correct timestamp. The `arkitToOpenCV` converter reproduces SpAItial's sample `camera_trajectory.json` exactly. Both are in Code Examples, ready to drop in. No EXIF library, no `sharp`, no `exifr`.

Streaming is `yazl` (`addReadStreamLazy` with `compress:false` and `size`; verified to give an exact `calculatedTotalSize` and correct central-directory sizes) piped into `@aws-sdk/lib-storage` `Upload` pinned to **3.1134.0** to match the installed `client-s3`. The mock validates bundles through a ~40-line HTTP-Range central-directory reader (verified against a yazl output). The money path reuses the existing advisory-lock ledger, extended with `submission_key`, `kind` and `provider_mode`. **One real bug to fix while extending it:** a compensating release dated on a later UTC day lowers *that* day's total and lets that day overspend. Date the release with the reservation's `created_at`.

**Primary recommendation:** Build `bundle/{manifest,convert,exif,validate,zipread,pack}.ts` from the verified snippets. Pin `yazl@3.3.1` + `@aws-sdk/lib-storage@3.1134.0` as the only new runtime deps. Make the fixture from TUM RGB-D fr3 (CC BY 4.0, pinhole, already undistorted) with a one-off script that uses the locally installed `ffmpeg` for PNG→JPEG. Use SpAItial's sample trajectory as a golden test for the converter.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session format contract (zod) | API/Backend (`bundle/manifest.ts`) | Mobile app (hand-copied type, Phase 3/4) | Server is the authority; the app only writes raw values |
| Pose conversion, EXIF insert, validation | Backend worker (`pack` job) | — | Fixes ship as a Railway deploy, not an EAS build (Anti-Pattern 1) |
| ZIP build + multipart upload | Backend worker → R2 (Storage) | — | Bounded memory, R2 is source of truth |
| Range presign + preflight | Backend worker (`submit` job) | R2 | Echo-3 needs Range + ≥2.5 h; we use 24 h |
| Submit / idempotency / reservation | Backend worker + Postgres | Provider | Persist-before-spend; DB is the money ledger |
| Status tracking, import | Backend worker (`track` job) → R2 | Provider | Single writer of processing/importing/ready |
| Webhook ingest | API route (Fastify) + Postgres | — | Verify, dedupe, nudge only. Never writes world state |
| Budget caps | Postgres (advisory-locked txn) | Config env | Atomicity must live in the DB |

## Echo-3 Capture Bundle Contract (authoritative, docs.spaitial.ai, fetched 2026-11-23)

> Read from `https://docs.spaitial.ai/api/capture-worlds.md`, `/api/webhooks.md`, `/api/exports.md`, `/api/worlds.md`, `/api/errors.md`, `/api/rate-limits.md`, cross-checked against `github.com/spaitial-ai/spaitial-capture-prototype` (`docs/bundle-format.md`, `docs/coordinate-conventions.md`, `samples/minimal-bundle`, `tools/validate-bundle`; MIT-0, pushed 2026-11-10). The API was **not** called.

### ZIP layout [CITED: docs.spaitial.ai/api/capture-worlds.md#capture-layout]
```
capture_bundle.zip
├── images/Image_000001.jpg …        required. 6-digit, 1-indexed, no gaps
└── cameras/
    ├── per_frame_intrinsics.json    required
    └── camera_trajectory.json       optional, recommended. WE ALWAYS WRITE IT
```
- `images/` and `cameras/` sit at the ZIP root (one wrapper folder is tolerated, but don't use one). [CITED: prototype docs/bundle-format.md]
- **Don't write** `orientation.json` or `camera_intrinsics.json`. The reference app writes neither. Echo-3 derives the hold from the trajectory, and a wrong `orientation.json` value is a failure source (`ORIENTATION_*`). [CITED: prototype docs/bundle-format.md + coordinate-conventions.md "The bundle doesn't need orientation.json"]
- Archive rules: Stored or Deflate only; ≤64 MiB per entry; ≤8 GiB uncompressed total; ≤51,024 entries; no encryption, symlinks, absolute paths, `..`, or duplicates. Don't add other files (they're ignored, with a warning). [CITED]

### `cameras/per_frame_intrinsics.json` [CITED]
```json
{ "frame_count": 2, "width_px": 1920, "height_px": 1440,
  "fx_px": [1403.0, 1408.2], "fy_px": [1403.0, 1408.2],
  "cx_px": [960.1, 960.2],   "cy_px": [719.9, 720.0] }
```
`fx_px, fy_px ∈ [100, 10000]`, `0 < cx_px < width_px`, `0 < cy_px < height_px`, each array has exactly `frame_count` finite values, and `width_px/height_px` equal the encoded JPEG size.

### `cameras/camera_trajectory.json` [CITED: docs + prototype bundle-format.md]
- JSON shape **`[N][4][4]`** (array of nested row-major matrices; `matrix[row][col]`, translation at `[0..2][3]`).
- OpenCV `camera_from_world` (+X right, +Y down, +Z forward, metres). `M = diag(1,-1,-1,1) · inverse(T_wc_arkit)`. Flip on the **left**.
- Rotation columns unit length and orthogonal within 1e-4, det = +1 within 1e-4, last row `[0,0,0,1]` within 1e-6. Index parity: `Image_{i+1}` ↔ trajectory[i] ↔ intrinsics[i].
- Validation checks shape, **not correctness**. A transposed or right-multiplied matrix passes structure checks and then reconstructs as garbage (billed).

### Images / EXIF [CITED]
- Identical JPEG dimensions; long edge ≤1920; short edge ≥360 (docs). EXIF `Orientation` absent or 1.
- `DateTimeOriginal` (`YYYY:MM:DD HH:MM:SS`), `SubSecTimeOriginal` (digits only), `OffsetTimeOriginal` (`±HH:MM`) present in the **first 64 KiB**, strictly increasing. Capture time = DateTimeOriginal in the OffsetTimeOriginal zone + `0.<SubSec>` s.
- **Discrepancy (flag):** the reference *validator* (`tools/validate-bundle/src/validation.ts`) accepts **only 1920×1440 or 1920×1080** (`PER_FRAME_INTRINSICS_RESOLUTION_MISMATCH`). The API docs accept any size with long ≤1920 and short ≥360. Per D-04 the docs win, so our validator uses docs rules and the 640×480 fixture is valid for the mock. **Risk for Phase 6:** a first paid run on a 640×480 TUM bundle might be rejected (free, `FAILED` with 0 credits) if the server matches the prototype validator. See Open Questions.

### Free endpoints the mock imitates [CITED]
- `GET /v1/captures/limits` → `{ "min_frames": 1, "max_frames": 5000, "can_edit_max_frames": false, "max_frames_ceiling": 5000 }`
- `GET /v1/captures/process-quote?model=echo-3&frame_count=N` → `{ "model":"echo-3", "required_credits": 900+N, "available_credits", "has_enough", "estimated_duration_seconds" }`. Over max → `400 CAPTURE_FRAME_LIMIT_EXCEEDED` (`error.details.max_frames`).

### `POST /v1/worlds` (spends) [CITED]
```json
{ "model": "echo-3", "title": "…", "output_format": "spz",
  "input": { "type": "capture_bundle", "zip": { "type": "url", "zip_url": "https://…presigned…" } },
  "webhook": { "url": "https://…/v1/webhooks/spaitial" } }
```
- Header `Idempotency-Key: <uuid>`. Same key + identical body replays the original 202. Same key + different body → `409 IDEMPOTENCY_KEY_REUSED`. After a `FAILED` job, retry with a new key.
- `202` → `{ request_id: "req_…", status_url, response_url, cancel_url }`.
- ZIP URL: `https://`, unauthenticated GET, **`Accept-Ranges: bytes` required**, valid and immutable ≥2.5 h or until terminal.
- `webhook.url` must be `https://` and a public IP. Loopback/private → `400 INVALID_WEBHOOK_URL` (Phase 6: omit `webhook` when `PUBLIC_BASE_URL` is not https).

### Status / result [CITED]
- `GET /v1/worlds/requests/{id}/status` → `{ request_id, status, progress (0..1 or null; never treat null as 0), estimated_duration_seconds, error }`, cached ~3 s.
- Status values seen in docs: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, plus cancellation (`world.cancelled` event; cancel works on PENDING/PROCESSING). Treat the enum as **open**: an unknown value means keep polling and log.
- `GET /v1/worlds/requests/{id}` → full envelope incl. `world.splat_url`, `world.cameras_url`, `validation: { passed, issues[] }`, `error: { code, message }`. Async ZIP validation failures → `FAILED` with **0 credits** and `validation.issues[].code` (codes `ZIP_*`, `IMAGE_*`, `EXIF_*`, `TRAJECTORY_*`, `MATRIX_*`, `ROTATION_*`, `PER_FRAME_INTRINSICS_*`, `INTRINSICS_*`, `CAMERA_FILE_INVALID_JSON`, …).
- `POST …/cancel` (safe to retry; `409 REQUEST_NOT_CANCELLABLE` once terminal). `DELETE …` (`409 RESOURCE_NOT_DELETABLE` while active).

### Outputs [CITED: exports.md, capture-worlds.md]
| Artifact | Route | Our R2 name |
|---|---|---|
| Splat | `GET …/splat` → 302 (`spz` default; raw SPZ is OpenCV RDF, y-down) | `splat.spz` |
| Collider | `POST …/exports/mesh-simplified` (202 PROCESSING / 200 READY; builds `mesh` too), poll `GET …/exports/mesh-simplified`, download `?download=1` → 302 | `collider.ply` |
| Floor plan | **Auto-started** for Echo-3: `GET …/exports/floorplan` until `READY`; `?download=1` (styled), `&variant=raw` (raw; `409 RESOURCE_NOT_READY` if `raw_image` null) | `floorplan.png`, `floorplan_raw.png`, `floorplan.json` (the `floorplan` meta block → also `floorplan_meta` jsonb) |
| Cameras | `GET …/cameras` → 302 to `cameras.json` | `cameras.json` |

- Every download route 302s to a ~5-minute signed URL. Store the API URL and resolve it fresh right before each stream.
- Floorplan meta block: `{ version:1, coordinate_system:"spaitial-world-v1", projection, origin_xz, image_x_axis_xz, image_y_axis_xz, extent_m, cut_height_y, scene_bounds{min,max}, image{ width_px,height_px,meters_per_pixel, world_xz_from_pixel[3][3], pixel_from_world_xz[3][3], download_url }, raw_image{…}|null, generated_at }`.
- `cameras.json`: `{ schema_version:"spaitial.capture_cameras.v1", capture_id, splat:"splat.spz", coordinate_system:"opencv", width_px, height_px, source_frame_count, frames:[{ source_index, image, camera_from_splat[4][4], fx_px, fy_px, cx_px, cy_px }], input_alignment?{ input_world_from_splat[4][4], scale, rmse_m, rotation_rmse_deg, inlier_frames, aligned_frames } }`.

### Webhooks [CITED: docs.spaitial.ai/api/webhooks.md]
- Headers: `Content-Type: application/json`, `User-Agent: SpaitialWebhook/1.0`, **`X-Spaitial-Event`**, **`X-Spaitial-Request-ID`**, **`X-Spaitial-Delivery-ID`** (`wd_<uuid>`, constant across retries), `X-Spaitial-Delivery-Attempt`, **`X-Spaitial-Signature: sha256=<hex>`**.
- Events: `world.completed`, `world.failed`, `world.cancelled`, `world.export.completed`, `world.export.failed`. **Export events also arrive**, so they nudge `track` too (floorplan/mesh readiness).
- Body: `{ event, delivery_id, timestamp, request_id, status, created_at, updated_at, completed_at, validation, data, error?, export? }`.
- HMAC-SHA256 over the **exact raw bytes**; 2xx within 30 s; ≤5 retries with backoff; at-least-once; dedupe on `delivery_id`. No signed timestamp, so replay is possible. Dedupe + nudge-only makes replay harmless.

### Errors / retry [CITED: errors.md, rate-limits.md]
| HTTP | `error.code` | Our handling (submit job) |
|---|---|---|
| 400 | `INVALID_INPUT`, `INVALID_WEBHOOK_URL`, `CAPTURE_FRAME_LIMIT_EXCEEDED` | release; `failed/submit`; park dead |
| 402 | `INSUFFICIENT_CREDITS` (`details.required_credits/available_credits`) | release; `failed/submit` |
| 403 | `MODEL_FORBIDDEN`, `FORBIDDEN` | release; `failed/submit` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | **park dead + loud log; no new key; do NOT release** (ambiguous) |
| 429 | `RATE_LIMIT_EXCEEDED` (`Retry-After` s) or `WORLD_USER_LIMIT` | not submitted; retry same key+body after `Retry-After` + 0–1 s jitter |
| 503 | `WORLD_INTAKE_PAUSED/UNAVAILABLE`, `MODEL_UNAVAILABLE` | not submitted; retry same key+body with backoff |
| 500/502/504, timeout | `INTERNAL_ERROR` | **ambiguous**; retry same key+body; on exhaustion keep reservation, `failed/submit` `SUBMIT_UNCERTAIN` |

Error envelope: `{ error: { code, message, request_id, details } }`. Rate limits: General 60/min, World-create 10/min, Downloads 120/min (the 302 routes).

## Standard Stack

### Core (new deps; only two runtime additions)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `yazl` | 3.3.1 (MIT, since 2014, single dep `buffer-crc32`) | Streaming store-only ZIP writer | Prescribed in CLAUDE.md; `compress:false`+`size` gives exact `calculatedTotalSize`; ZIP64 automatic [VERIFIED: npm registry + local run] |
| `@aws-sdk/lib-storage` | **3.1134.0** (pin; peer `@aws-sdk/client-s3 ^3.1134.0`) | Multipart `Upload` of the ZIP stream (and imported artifacts) to R2 | Handles part sizing/retries/abort. Pinning to the installed client-s3 avoids bumping the SDK mid-phase [VERIFIED: npm registry] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/yazl` | 3.3.1 (dev) | Types | Always with yazl |
| `node:crypto` | built-in | HMAC-SHA256, `randomUUID` | Webhook verify / mock signing |
| `ffmpeg` | 8.1.2 (local, **not** an npm dep) | PNG→JPEG in the one-off fixture script | Fixture creation only; output is committed |
| Existing: `zod` 4, `drizzle-orm` 0.45, `pg`, `fastify` 5.12.8, `@fastify/rate-limit` 10, `vitest` 2.1 | installed | — | Reuse |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand EXIF writer (≈30 lines, verified) | `piexifjs` / `exifr` (read-only) | No gain. The writer is byte-identical to Pillow's output already |
| `exifr` dev dep for test reads | Vendor SpAItial's `readCaptureExif` (MIT-0, ~100 lines) into `test/helpers/` | Vendoring gives the *same parser Echo-3's team ships*. Prefer it |
| `sharp` for PNG→JPEG | `ffmpeg` already on the dev machine (or Pillow) | `sharp` is a native ~30 MB dep for a one-off. ffmpeg is installed |
| lib-storage multipart | Single `PutObject` with `ContentLength = calculatedTotalSize` | Works <5 GiB with no dep, but D-07 locks lib-storage |
| advisory-lock ledger | conditional UPDATE on a `budgets` row per day/month | Needs 2 rows + window rollover logic. The existing lock + SUM is correct and already tested. Keep it |

**Installation:**
```bash
cd backend
npm install yazl@3.3.1 @aws-sdk/lib-storage@3.1134.0
npm install -D @types/yazl@3.3.1
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| yazl | npm | 12 yrs (created 2014-09-15) | high (mature) | github.com/thejoshwolfe/yazl | [OK] | Approved |
| @types/yazl | npm | DefinitelyTyped | high | github.com/DefinitelyTyped | [OK] | Approved |
| @aws-sdk/lib-storage | npm | AWS SDK v3 | very high | github.com/aws/aws-sdk-js-v3 | [OK] | Approved (pin 3.1134.0) |

No `postinstall`/`install` scripts on any of them (`npm view … scripts.postinstall` empty, including `buffer-crc32`).
**Packages removed due to slopcheck [SLOP]:** none. **Flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram
```
 test / fixture:e2e seeds ──▶ Storage captures/{cid}/{session.json, frames.jsonl, frames/000001.jpg…}
                               world(status=packing, approved_max_credits) + capture + job(pack)
                                     │
 [pack job] list(prefix) ─▶ zod manifest ─▶ validate (D-06) ──fail──▶ world failed/validate (0 credits)
      │ ok
      ├─ cameras/per_frame_intrinsics.json + camera_trajectory.json (arkitToOpenCV per frame)
      ├─ per frame: getObject ─▶ withExif(wallMs,tz) ─▶ yazl.addReadStreamLazy(compress:false,size)
      └─ yazl.outputStream ─▶ storage.putStream (lib-storage Upload 16 MiB parts | fs pipeline)
            ─▶ bundles/{cid}/capture_bundle.zip ; tx{capture.bundle_key/bytes; world→submitting; enqueue submit}
                                     │
 [submit job] provider_request_id set? ─yes─▶ ensure track, done
      │ no
      ├─ submission_key (set-if-null) ─▶ quote ≤ approved_max? ─no─▶ failed/submit QUOTE_ABOVE_APPROVAL
      ├─ reserveCredits(key, quote, mode) ─over cap─▶ failed/submit BUDGET_EXCEEDED (0 provider calls)
      ├─ submit_body null? presign(24h) ─▶ Range preflight 206 ─▶ PERSIST submit_body
      ├─ provider.submit(JSON.stringify(submit_body as READ FROM DB), key)
      │     202 ─▶ tx{provider_request_id, status=processing, enqueue track}
      │     429/503/5xx ─▶ retry same key+body (failJob delay = Retry-After | backoff ≤15 min, ≤4 attempts)
      │     400/402/403 ─▶ release + failed/submit      409 ─▶ park dead, loud log (no release)
                                     │
 Mock/Echo-3 ──webhook POST──▶ /v1/webhooks/spaitial: raw buffer ─▶ HMAC verify (secretEquals)
                                 ─▶ INSERT webhook_deliveries ON CONFLICT DO NOTHING ─▶ dup? 200
                                 ─▶ UPDATE jobs SET run_after=now() WHERE kind='track' AND phase='queued'
                                                                   AND world by provider_request_id ─▶ 200
                                     │ (nudge only)
 [track job] status(req) ─ PENDING/PROCESSING ─▶ snoozeJob(TRACK_POLL_SECONDS)
      ├─ FAILED ─▶ failed/processing, charged=false, release, store issues
      ├─ CANCELLED ─▶ cancelled, release
      └─ COMPLETED ─▶ status=importing; ensureExport(mesh-simplified), floorplan READY? else snooze
            for each artifact not yet at worlds/{wid}/v{n}/<name>: open() ─▶ putStream
            single UPDATE: all *_key + floorplan_meta + status=ready + charged=true
```

### Recommended Project Structure
```
backend/
├── src/bundle/
│   ├── manifest.ts   # zod: SessionV1, FrameLineV1, parseFramesJsonl()
│   ├── convert.ts    # arkitToOpenCV, cameraCentre, rotation checks
│   ├── exif.ts       # exifApp1(), withExif(), jpegSize() (SOF scan)
│   ├── validate.ts   # D-06 rules (named constants) -> {code,message}[]
│   ├── zipread.ts    # readCentralDirectory(readRange) — used by mock + tests
│   └── pack.ts       # packCapture(deps, captureId) -> {bundleKey, bundleBytes}
├── src/provider/{types,mock,index}.ts   # ReconProvider + scripted mock
├── src/routes/webhooks.ts               # scoped raw parser, verify, dedupe, nudge
├── src/jobs/{pack,submit,track}.ts      # or inline in worker.ts. Planner's call
├── scripts/make-tiny-session.ts         # one-off TUM -> session converter (tsx)
├── scripts/fixture-e2e.ts               # D-23, virtumetry-dev only
└── test/
    ├── fixtures/tiny-session/{session.json,frames.jsonl,frames/*.jpg,README.md}
    ├── fixtures/mock-outputs/{splat.ply|spz, collider.ply, floorplan.png, floorplan.json, cameras.json}
    ├── helpers/{capture-exif.ts (vendored MIT-0 reader), pg-schema.ts}
    └── integration/{pipeline,budget,webhooks}.pg.test.ts, r2-range.s3.test.ts
```

### Pattern 1: Persist-before-spend, send what the DB holds
`submit_body` is `jsonb` (D-15). **jsonb does not preserve key order or whitespace**, so `JSON.stringify(inMemoryObject)` on the first attempt and `JSON.stringify(rowFromDb)` on a retry can differ byte-for-byte. If Echo-3 compares bytes, that is a self-inflicted `409`. Rule: persist `submit_body` with a conditional `UPDATE … WHERE submit_body IS NULL`, **re-read the row**, and always send `JSON.stringify(world.submitBody)` from the DB value, including on the first send. (Alternative: a `text` column. It is equally simple, but deviates from D-15.)

### Pattern 2: Snooze, don't sleep (D-16)
```ts
// queue.ts — reschedule without consuming an attempt (claimNextJob already did attempts+1)
export async function snoozeJob(db: Db, jobId: string, seconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET phase='queued', locked_at=NULL, locked_by=NULL,
      attempts = GREATEST(attempts - 1, 0),
      run_after = now() + (${seconds} * interval '1 second'), updated_at = now()
    WHERE id = ${jobId}`);
}
```
For submit retries with `Retry-After`, add an optional `delaySeconds` param to the existing `failJob` (consumes an attempt; the submit handler parks itself after 4). Don't add a new function.

### Pattern 3: Conditional single-statement flips (existing R20/R27 pattern)
Every status transition is `UPDATE worlds SET status=$next, … WHERE id=$1 AND status=$expected RETURNING id`. Zero rows means another worker already moved it, so `completeJob` and stop. The pack→submit and submit→track hand-offs do the flip + `enqueue(tx, …)` in one `db.transaction`.

### Pattern 4: Scoped raw-body webhook route
`removeAllContentTypeParsers()` + `addContentTypeParser('*', {parseAs:'buffer', bodyLimit})` **inside a child `register` scope**. Fastify parsers are encapsulated, so the rest of the API keeps JSON parsing. [CITED: fastify 5.12.8 docs/Reference/ContentTypeParser.md]

### Pattern 5: Test DB = real migrations in a throwaway schema
The existing `*.pg.test.ts` files hand-mirror DDL, which drifts. The generated SQL hard-codes `REFERENCES "public"."worlds"`. Add a helper that reads `drizzle/*.sql` in journal order, replaces `"public".` with `"<schema>".`, splits on `--> statement-breakpoint`, and runs inside a fresh schema with the `search_path` connect-hook already used. That's ~20 lines, and the integration tests then run the *actual* 0000+0001 DDL.

### Anti-Patterns to Avoid
- **Re-presigning on retry.** It changes the body and causes `409 IDEMPOTENCY_KEY_REUSED`. The tempting fix (a new key) is how you double-charge.
- **Webhook handler that touches `worlds`.** Two writers race. Only `track` writes state.
- **Parsing JSON before HMAC.** Re-serialized ≠ signed bytes. The scoped parser hands over a `Buffer`.
- **`===` on signatures.** SpAItial's own Node sample uses `timingSafeEqual` on equal-length buffers. Ours uses `secretEquals` (SHA-256 both sides then `timingSafeEqual`), which is also length-safe.
- **Holding a lease across polls.** Use `snoozeJob`.
- **Buffering artifacts or the ZIP.** Stream through `putStream`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ZIP writing (CRC32, data descriptors, ZIP64, UTF-8 flag) | own ZIP writer | `yazl` | ZIP64 at >4 GiB/65,535 entries; descriptor quirks |
| S3/R2 multipart (part sizing, abort on error, retries) | own `CreateMultipartUpload` loop | `@aws-sdk/lib-storage` `Upload` | R2 needs equal part sizes; leftover parts cost storage |
| HMAC / constant-time compare | custom compare | `node:crypto` `createHmac` + existing `secretEquals` | Timing leaks |
| Serializing budget checks | app-level mutex | `pg_advisory_xact_lock` (existing) | Multi-worker |
| Presigning | manual SigV4 | existing `getSignedUrl` in `s3.ts` | Already correct |

**Fine to hand-roll (tiny, fully specified, verified here):** the EXIF APP1 writer (fixed 106 bytes), the JPEG SOF size reader, the mock's central-directory reader (non-ZIP64), and the 4×4 rigid inverse. Each is ≤40 lines, and a dependency would be larger than the code.

## Runtime State Inventory

> Phase 2 replaces the World Labs status set, provider interface and asset columns, so this inventory applies.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Neon **dev** `worlds` rows may carry Phase 1 statuses (`capturing/uploading/uploaded/complete/failed_upload`) and `spz_*_url`/`collider_glb_url` values from Phase 1 tests. `jobs.provider_operation_id` column. `credit_events` rows without `submission_key/kind/provider_mode`. Prod Neon: no worlds yet (no app has shipped). | Code edit (new statuses). Dropping columns loses only dev test data. Give the new `credit_events` columns defaults (`kind 'reserve'`, `provider_mode 'mock'`) so 0001 applies on non-empty tables. No data migration needed beyond that |
| Live service config | None. Webhook URL is not registered anywhere yet; SpAItial dev portal untouched (Phase 6). | None |
| OS-registered state | None. Railway services use the `SERVICE_ENTRY` env (unchanged). | None |
| Secrets/env vars | `SPAITIAL_WEBHOOK_SECRET` already in config/.env (name unchanged). New: `MONTHLY_CREDIT_BUDGET`, `MOCK_SCENARIO`, `MOCK_PROCESSING_SECONDS`, `TRACK_POLL_SECONDS`, `BUNDLE_URL_TTL_SECONDS` (default 86400). `SPAITIAL_API_KEY` exists in `.env`, and **nothing in Phase 2 may read it**. | Add to zod `config.ts` + README env table. Railway env added in a later deploy |
| Build artifacts | `backend/data/` (local storage dir) is **not gitignored**. | Tests use `fs.mkdtemp(os.tmpdir())` for `LOCAL_STORAGE_DIR`. Optionally add `backend/data/` to `.gitignore` |

## Common Pitfalls

### Pitfall 1: Transposed / right-multiplied trajectory
**What goes wrong:** JSON written column-major, or `inv(T)·D` instead of `D·inv(T)`. Both are orthonormal, so structural validation passes and the result reconstructs badly (billed).
**How to avoid:** Use the verified `arkitToOpenCV` (reads `T[c*4+r]`, flips rows 1–2). Golden test against SpAItial's sample trajectory (below), plus a reprojection test: world point → `M·P` → `(fx·x/z+cx, fy·y/z+cy)` equals the known pixel.
**Warning sign:** `MATRIX_FINAL_ROW` (translation ended up in the last row) means you transposed.

### Pitfall 2: Trajectory written flat
**What goes wrong:** `[[16 floats], …]` instead of `[N][4][4]` → `MATRIX_*`/`CAMERA_FILE_INVALID_JSON`. D-03 says "rowMajor16", but the file needs nested arrays.
**How to avoid:** `arkitToOpenCV` returns `number[][]` (4×4), and pack writes `JSON.stringify(matrices)` directly.

### Pitfall 3: EXIF date math in the server's zone
**What goes wrong:** `new Date(wallMs).getHours()` uses the worker's TZ.
**How to avoid:** Shift by the offset and read `getUTC*` (verified snippet). Contract: `session.tzOffset` is a **string `±HH:MM`**. D-01 leaves the type open, so the planner should lock it in the zod schema.

### Pitfall 4: Presigned Range quirks
**What goes wrong:** R2 presigned URLs don't work on custom domains. Range on presigned GETs is unsigned and should work, but R2 docs don't say so explicitly (MEDIUM).
**How to avoid:** Use the S3 endpoint from `S3_ENDPOINT`. Preflight `Range: bytes=0-15` → expect `206`, `Content-Range: bytes 0-15/<total>`, and body starting `PK\x03\x04`. The gated R2 test is the proof. Presign max 7 days; we use 24 h. [CITED: developers.cloudflare.com/r2/api/s3/presigned-urls]

### Pitfall 5: AWS SDK default CRC32 checksums vs R2
**What goes wrong:** SDK ≥3.729 sends `x-amz-checksum-crc32` by default. R2 returned `501 NotImplemented` for some operations (aws-sdk-js-v3 #6810). Whether today's R2 accepts it on multipart parts is unverified.
**How to avoid:** If the gated R2 test fails with 501/NotImplemented, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on the `S3Client` in `s3.ts` (one line each). Don't add it pre-emptively without the failing test. [MEDIUM]

### Pitfall 6: Cross-day compensating release lets a day overspend (existing bug)
**What goes wrong:** Day 1 reserves 1,500. Echo-3 `FAILED` arrives after UTC midnight, and the `-1500` release row is dated day 2. Day 2's SUM is now −1,500, so day 2 can reserve cap + 1,500. The monthly window has the same issue at month boundaries.
**How to avoid:** Write the release as `INSERT … SELECT -amount, …, created_at FROM credit_events WHERE submission_key=$1 AND kind='reserve' ON CONFLICT DO NOTHING`. The release inherits the reservation's timestamp, which nets it out of the window that was charged, keeps the ledger append-only, and makes the release idempotent through `unique(submission_key, kind)`.

### Pitfall 7: Release on ambiguous outcomes
**What goes wrong:** Releasing after a timeout, 5xx, or 409 when the job may actually exist, so the ledger under-counts real spend.
**How to avoid:** Release **only** on known-not-charged outcomes: 400/402/403, mock/Echo-3 `FAILED` or `CANCELLED` (docs: 0 credits), and 429/503 when retries are exhausted ("not submitted"). Keep the reservation on 5xx/timeout exhaustion and on 409.

### Pitfall 8: Webhook route and global parsers/limits
**What goes wrong:** In local mode the dev-storage route adds a root `'*'` buffer parser. Adding parsers without `removeAllContentTypeParsers()` in the child scope throws `FST_ERR_CTP_ALREADY_PRESENT`. Global rate limiting runs in `preHandler`, keyed by user, so the webhook needs its own `config.rateLimit`.
**How to avoid:** Use Code Example 6. Register the route outside the authed scope. Missing `SPAITIAL_WEBHOOK_SECRET` → 401 for every request (fail closed).

### Pitfall 9: `drizzle-kit generate` is interactive on column add+drop in one table
**What goes wrong:** Dropping `spz_*_url` and adding `splat_key` in the same generate triggers the "created or renamed from another column?" prompt (string present in drizzle-kit 0.31 `bin.cjs`). A non-TTY agent hangs.
**How to avoid:** Two schema edits and two generates. **0001** adds all new columns/tables and indexes. **0002** drops `spz_100k_url, spz_500k_url, spz_full_url, collider_glb_url, jobs.provider_operation_id`. Or make the drop edit first. Either way, never mix add and drop in one table per generate.

### Pitfall 10: yazl lazy-stream errors hang the upload
**What goes wrong:** An error inside an `addReadStreamLazy` callback is *emitted on the ZipFile*. `outputStream` never ends, and `Upload.done()` waits forever.
**How to avoid:** `zip.on('error', e => upload.abort())` (local: `out.destroy(e)`), then reject. Also wire the pack job's heartbeat (bundles of 1,000 frames take minutes; LEASE_SECONDS=600).

### Pitfall 11: Echo-3 resolution allowlist (prototype) vs docs
Covered above. Our validator follows the docs. The fixture is 640×480. Flag it for Phase 6.

### Pitfall 12: Node version drift
The dev machine runs **Node v22.21.1**, but `engines: >=24` and CI uses 24. Everything here (global `fetch`, `Readable.fromWeb`, `stream/promises`) exists in 22. Don't use Node-24-only APIs, or test on 24.

## Code Examples

### 1. `arkitToOpenCV` (VERIFIED: reproduces SpAItial's `samples/minimal-bundle/cameras/camera_trajectory.json` exactly)
```ts
// backend/src/bundle/convert.ts
/** ARKit world_from_camera (16 floats, column-major simd layout) -> OpenCV camera_from_world, row-major [4][4]. */
export function arkitToOpenCV(T: readonly number[]): number[][] {
  if (T.length !== 16) throw new Error('T_arkit must have 16 values');
  const R = (r: number, c: number) => T[c * 4 + r]!;          // column-major read
  const t = [T[12]!, T[13]!, T[14]!];
  const out: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const s = r === 0 ? 1 : -1;                                 // D = diag(1,-1,-1,1) on the LEFT
    const row = [R(0, r), R(1, r), R(2, r)];                    // row r of R^T
    const tr = -(row[0]! * t[0]! + row[1]! * t[1]! + row[2]! * t[2]!); // (-R^T t)_r
    out.push([s * row[0]!, s * row[1]!, s * row[2]!, s * tr]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}
// Golden: cam X->(0,-1,0), Y->(1,0,0), Z->(0,0,1), pos (0.1i,1.4,0) ⇒ [[0,-1,0,1.4],[-1,0,0,0.1i],[0,0,-1,0],[0,0,0,1]]
// D-03 case: identity at (0,1.5,0) ⇒ [[1,0,0,0],[0,-1,0,1.5],[0,0,-1,0],[0,0,0,1]]
```
The rigid inverse assumes orthonormal R, so validate R (columns unit, orthogonal ≤1e-4, det +1 ≤1e-4) **before** converting. That is the D-06 "valid 4x4" check, run on `T_arkit`. Use −0-safe comparisons in tests (`toBeCloseTo`).

### 2. EXIF APP1 writer (VERIFIED: byte-identical to the Pillow APP1 in SpAItial's sample JPEG; read back by SpAItial's `readCaptureExif` → `1341847980.722` for `wallMs=1341847980722, "+02:00"`)
```ts
// backend/src/bundle/exif.ts
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Fixed 106-byte APP1: IFD0{ExifIFD ptr} → ExifIFD{DateTimeOriginal, OffsetTimeOriginal, SubSecTimeOriginal}. */
export function exifApp1(wallMs: number, tzOffset: string): Buffer {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tzOffset);
  if (!m) throw new Error(`bad tzOffset ${tzOffset}`);
  const offMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const d = new Date(wallMs + offMin * 60_000); // local wall time, read with getUTC*
  const dto = `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}\0`; // 20 B
  const sub = `${String(((wallMs % 1000) + 1000) % 1000).padStart(3, '0')}\0`; // 4 B → inline value
  const t = Buffer.alloc(96); // big-endian TIFF block
  t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);                                                   // IFD0: 1 entry
  t.writeUInt16BE(0x8769, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(26, 18);
  t.writeUInt32BE(0, 22);                                                  // no IFD1
  t.writeUInt16BE(3, 26);                                                  // ExifIFD: 3 entries, ascending tags
  const ent = (o: number, tag: number, count: number) => { t.writeUInt16BE(tag, o); t.writeUInt16BE(2, o + 2); t.writeUInt32BE(count, o + 4); };
  ent(28, 0x9003, 20); t.writeUInt32BE(68, 36);                            // DateTimeOriginal -> @68
  ent(40, 0x9011, 7);  t.writeUInt32BE(88, 48);                            // OffsetTimeOriginal -> @88
  ent(52, 0x9291, 4);  t.write(sub, 60, 'latin1');                         // SubSecTimeOriginal inline
  t.writeUInt32BE(0, 64);
  t.write(dto, 68, 'latin1'); t.write(`${tzOffset}\0`, 88, 'latin1');
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(2 + 6 + t.length, 2); head.write('Exif\0\0', 4, 'latin1');
  return Buffer.concat([head, t]);
}

/** D-05: APP1 right after SOI. Frames arrive without EXIF by contract (validate rejects an existing Exif APP1). */
export function withExif(jpeg: Buffer, wallMs: number, tzOffset: string): Buffer {
  if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
  return Buffer.concat([jpeg.subarray(0, 2), exifApp1(wallMs, tzOffset), jpeg.subarray(2)]);
}
```
Output size per frame = `original + 106`, known before reading. That lets pack pass yazl `size` from the listing.

JPEG size for validation (SOF scan, ~15 lines):
```ts
export function jpegSize(b: Buffer): { w: number; h: number } {
  let p = 2;
  while (p + 9 < b.length && b[p] === 0xff) {
    const mk = b[p + 1]!, len = b.readUInt16BE(p + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc)
      return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  throw new Error('no SOF marker');
}
```
For tests, vendor SpAItial's `tools/validate-bundle/src/exif.ts` (`readCaptureExif`, `captureExifTimestampSeconds`; MIT-0, no deps) into `test/helpers/capture-exif.ts` with a header noting origin and licence.

### 3. Pack pipeline (yazl → putStream)
```ts
// backend/src/bundle/pack.ts (sketch)
import yazl from 'yazl';
import { Readable } from 'node:stream';

const zip = new yazl.ZipFile();
zip.addBuffer(Buffer.from(JSON.stringify(intrinsics)), 'cameras/per_frame_intrinsics.json', { compress: false });
zip.addBuffer(Buffer.from(JSON.stringify(trajectory)), 'cameras/camera_trajectory.json', { compress: false });
for (const f of frames) {                        // sizes from storage.list(prefix)
  const name = `images/Image_${String(f.i).padStart(6, '0')}.jpg`;
  zip.addReadStreamLazy(name, { compress: false, size: f.bytes + 106 }, (cb) => {
    storage.getObject(f.key)
      .then((jpg) => cb(null, Readable.from([withExif(jpg, f.wallMs, session.tzOffset)])))
      .catch((e) => cb(e));
  });
}
let bundleBytes = -1;
zip.end((n: number) => { bundleBytes = n; });   // exact when every entry is stored + sized (verified)
const upload = storage.putStream(bundleKey, zip.outputStream, 'application/zip');
zip.on('error', (e) => upload.abort(e));
await upload.done;
```
`StorageDriver` gains `putStream(key, body, contentType): { done: Promise<void>; abort(e): void }`, `getStream(key): Promise<Readable>` (import + mock fixture), and `list(prefix): Promise<{ key: string; size: number }[]>` (also used by Phase 3/4 `uploads:missing`). S3: `new Upload({ client, params: { Bucket, Key, Body, ContentType }, partSize: 16 * 1024 * 1024, queueSize: 4, leavePartsOnError: false })`. List: `ListObjectsV2Command` with continuation. Local: `stream/promises.pipeline(body, fs.createWriteStream(path))`, `fs.readdir(recursive)` + `stat`. Bit 3 (data descriptor) is set on lazy entries. That is fine: Echo-3 and the reference reader use the central directory.

### 4. Central-directory reader over Range (VERIFIED against a yazl store-only output)
```ts
// backend/src/bundle/zipread.ts — mock + tests. ponytail: no ZIP64 (bundles < 4 GiB / 65,535 entries); add when real bundles exceed that.
export type ReadRange = (start: number, endInclusive: number) => Promise<Buffer>;
export interface ZipEntry { name: string; method: number; csize: number; usize: number; lho: number }

export async function readCentralDirectory(total: number, read: ReadRange): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, total - 65_557);
  const tail = await read(tailStart, total - 1);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    const count = tail.readUInt16LE(i + 10), size = tail.readUInt32LE(i + 12), off = tail.readUInt32LE(i + 16);
    if (count === 0xffff || size === 0xffffffff || off === 0xffffffff) throw new Error('ZIP64 not supported');
    const cd = await read(off, off + size - 1);
    const out: ZipEntry[] = [];
    for (let p = 0, k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
      const n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + n), method: cd.readUInt16LE(p + 10),
                 csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), lho: cd.readUInt32LE(p + 42) });
      p += 46 + n + m + c;
    }
    return out;
  }
  throw new Error('EOCD not found');
}
export async function readEntry(e: ZipEntry, read: ReadRange, max = e.csize): Promise<Buffer> {
  const lh = await read(e.lho, e.lho + 29);
  const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return read(start, start + Math.min(max, e.csize) - 1);   // max = 65536 for EXIF heads
}
// HTTP ReadRange: fetch(url, { headers: { Range: `bytes=${a}-${b}` } }) → expect 206.
// total comes from the preflight's Content-Range "bytes 0-15/<total>".
```

### 5. Mock provider shape
```ts
createMockProvider({
  scenario,                 // 'happy'|'failed'|'402'|'409'|'429'|'503'|'duplicate_webhooks'|'webhook_dropped'
  processingSeconds = 0, now = Date.now,
  webhookSecret, deliver,   // deliver(raw: Buffer, headers) — tests: app.inject; dev: fetch(PUBLIC_BASE_URL)
  outputsDir,               // test/fixtures/mock-outputs
})
// state: Map<key, {body: string, requestId}> → real idempotency: same key+same body ⇒ same requestId;
//        same key+different body ⇒ throw ProviderError(409,'IDEMPOTENCY_KEY_REUSED').  calls: { submit: [...] }
// submit: scripted error first (429/503 once, with retryAfterS=1; 402/409 always), else Range-read the
//         ZIP via zip_url and run the bundle checks; a bad bundle still returns 202 and then reports FAILED
//         with validation.issues (mirrors Echo-3's async validation, 0 credits).
// status: PROCESSING until submittedAt+processingSeconds, then COMPLETED | FAILED(WORLD_GENERATION_FAILED).
// ensureExport('mesh-simplified'): 'pending' on first call, then 'ready'; floorplan: 'ready'.
// artifacts(): splat, collider, floorplan(+raw), floorplan meta, cameras; open(a) → fs.createReadStream(outputsDir/…).
// on terminal transition: deliver signed world.completed/failed (twice for duplicate_webhooks, never for webhook_dropped).
```
`quote(n) = { credits: 900 + n, available: Infinity }`; `limits() = { minFrames: 1, maxFrames: 5000 }`.

### 6. Webhook route (Fastify 5, scoped raw parser, reuse `secretEquals`)
```ts
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { secretEquals } from '../auth.js';

export async function webhookRoutes(app: FastifyInstance, { config }: RouteDeps): Promise<void> {
  await app.register(async (s) => {
    s.removeAllContentTypeParsers();
    s.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_r, body, done) => done(null, body));
    s.post('/v1/webhooks/spaitial', {
      config: { rateLimit: { max: 120, timeWindow: 60_000, keyGenerator: (r: FastifyRequest) => `wh:${r.ip}` } },
    }, async (req, reply) => {
      const raw = req.body as Buffer;
      const sig = req.headers['x-spaitial-signature'];
      const secret = config.SPAITIAL_WEBHOOK_SECRET;
      if (!secret || typeof sig !== 'string' || !Buffer.isBuffer(raw)) return reply.code(401).send({ error: 'invalid_signature' });
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      if (!secretEquals(sig, expected)) return reply.code(401).send({ error: 'invalid_signature' });
      const h = (k: string) => { const v = req.headers[k]; return typeof v === 'string' ? v : undefined; };
      const deliveryId = h('x-spaitial-delivery-id'), requestId = h('x-spaitial-request-id'), event = h('x-spaitial-event');
      if (!deliveryId || !requestId) return reply.code(400).send({ error: 'missing_headers' });
      const db = getDb();
      const ins = await db.insert(webhookDeliveries).values({ deliveryId, requestId, event: event ?? null })
        .onConflictDoNothing().returning({ id: webhookDeliveries.deliveryId });
      if (ins.length === 0) return reply.code(200).send({ ok: true, duplicate: true });
      await db.execute(sql`UPDATE jobs SET run_after = now(), updated_at = now()
        WHERE kind = 'track' AND phase = 'queued'
          AND world_id IN (SELECT id FROM worlds WHERE provider_request_id = ${requestId})`);
      return reply.code(200).send({ ok: true });
    });
  });
}
```
`ReconProvider.verifyWebhook` (D-11) can be just this HMAC check, shared by mock and echo3. The route doesn't need provider-specific parsing because every field it uses is in headers.

### 7. Budget reservation (extend existing `budget.ts`)
```ts
// credit_events += submission_key uuid, kind text ('reserve'|'release') default 'reserve',
//                 provider_mode text default 'mock'; uniqueIndex(submission_key, kind)
export async function reserveCredits(db: Db, a: { key: string; amount: number; mode: 'mock'|'live';
  worldId: string; daily: number; monthly: number }): Promise<'reserved' | 'already'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const prior = rowsOf(await tx.execute(sql`SELECT 1 FROM credit_events WHERE submission_key=${a.key} AND kind='reserve'`));
    if (prior.length) return 'already';                         // resumed submit: never re-check, never double-reserve
    const [s] = rowsOf<{ day: string; month: string }>(await tx.execute(sql`
      SELECT COALESCE(SUM(amount) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')), 0) AS day,
             COALESCE(SUM(amount), 0) AS month
      FROM credit_events
      WHERE provider_mode = ${a.mode}
        AND created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`));
    if (Number(s!.day) + a.amount > a.daily) throw new BudgetExceededError('daily', a.amount, Number(s!.day), a.daily);
    if (Number(s!.month) + a.amount > a.monthly) throw new BudgetExceededError('monthly', a.amount, Number(s!.month), a.monthly);
    await tx.insert(creditEvents).values({ amount: a.amount, worldId: a.worldId, submissionKey: a.key,
      kind: 'reserve', providerMode: a.mode }).onConflictDoNothing();
    return 'reserved';
  });
}
// release: idempotent, dated like its reservation (Pitfall 6)
await db.execute(sql`INSERT INTO credit_events (amount, world_id, submission_key, kind, provider_mode, created_at)
  SELECT -amount, world_id, submission_key, 'release', provider_mode, created_at
  FROM credit_events WHERE submission_key = ${key} AND kind = 'reserve'
  ON CONFLICT DO NOTHING`);
```
The unique `(submission_key, kind)` index makes a second release a no-op. Remove `creditsForModel`/`budgetFits` (World Labs) and their tests. `MONTHLY_CREDIT_BUDGET` default: see Assumptions.

### 8. Fixture conversion (TUM RGB-D → session schema 1)
- **Dataset:** TUM RGB-D **fr3/long_office_household** (office loop, 87 s, 21 m). URL: `https://cvg.cit.tum.de/rgbd/dataset/freiburg3/rgbd_dataset_freiburg3_long_office_household.tgz` (302 → `webshare.cvg.cit.tum.de`, 1,483,556,251 bytes, `Accept-Ranges: bytes`). Smaller fallback: `…freiburg3_large_cabinet.tgz` (0.48 GB). [VERIFIED: HEAD request + download page]
- **Licence:** "Unless stated otherwise, all data in the TUM RGB-D benchmark is licensed under a Creative Commons 4.0 Attribution License (CC BY 4.0)" [VERIFIED: cvg.cit.tum.de/data/datasets/rgbd-dataset]. README must credit: Sturm et al., "A Benchmark for the Evaluation of RGB-D SLAM Systems", IROS 2012; sequence, frame range; modifications (PNG→JPEG, poses converted to ARKit convention, EXIF-free).
- **Why fr3:** "both the color and IR images of the Freiburg 3 sequences have already been undistorted", so it is a true pinhole: `fx=535.4, fy=539.2, cx=320.1, cy=247.6`, 640×480. fr1/fr2 have strong radial distortion, which is wrong for Echo-3's pinhole model. [CITED: TUM file_formats page]
- **Groundtruth:** `timestamp tx ty tz qx qy qz qw` = pose of the colour camera's optical centre in the mocap world (`world_from_camera`, OpenCV optical axes x-right/y-down/z-forward [ASSUMED: standard for TUM; implied by its pinhole tools]). Timestamps are Unix seconds, so `wallMs = round(t*1000)`, `t_session = t - t0`.
- **Transform to raw ARKit:** `T_arkit = W · T_tum · F`, with `F = diag(1,-1,-1,1)` (OpenCV cam → ARKit cam axes) and `W` a world rotation taking the estimated up (`−mean_k R_tum[:,1]` over all groundtruth rows, since a handheld camera's image-down ≈ gravity) to +Y. Then `arkitToOpenCV(T_arkit) = inv(T_tum) · Wᵀ`. With `W = I` that is exactly `inv(T_tum)`, which gives an end-to-end assertion. Serialize column-major: `a[c*4+r] = M[r][c]`. *(ponytail: `W` approximates gravity from the trajectory. Fine for a fixture; skip if not wanted, since nothing in Phase 2 depends on world up.)*
- **Selection:** nearest groundtruth row within 20 ms of each RGB stamp. Take 30 frames ≥0.25 s apart from a moving stretch (≈7 cm/frame at 0.25 m/s), which stays within D-06's 0.5 m jump. `tracking:"normal"`, `tzOffset:"+02:00"` (Freiburg CEST at capture), `imageWidth/Height 640/480`.
- **Windows/Git Bash feasibility:** download with `curl -L -o` into the scratch dir (outside the repo). Extract only what's needed with GNU tar 1.35 (present): `tar -xzf X.tgz --wildcards '*/groundtruth.txt' '*/rgb.txt' '*/rgb/*.png'`. PNG→JPEG: `execFileSync('ffmpeg', ['-loglevel','error','-y','-i',png,'-q:v','3','-bitexact',jpg])` (ffmpeg 8.1.2 present; `-bitexact` drops the encoder comment; output has a JFIF APP0, no EXIF). At ~40–60 KB per frame, 30 frames come to ~1.5 MB. No Python, no new npm dep; the script runs via the existing `tsx`.
- `mock-outputs/cameras.json`: the same script emits a `spaitial.capture_cameras.v1` file using `camera_from_splat = arkitToOpenCV(T_arkit)` per frame (committing is simpler than generating at mock time).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| World Labs `generateWorld` + pending marker + display-name reconcile | `Idempotency-Key` + persisted body, retry same key | Phase 2 | Ambiguous failures become retryable |
| `downloadAsset(): Buffer` | `open(): Readable` → multipart stream | Phase 2 | Bounded memory for large meshes |
| ARCHITECTURE "presign 6 h" | **24 h** (D-08) | CONTEXT 2026-11-23 | Above Echo-3's 2.5 h; R2 max 7 d |
| `orientation.json` "research flag" | Omit it. Reference app writes none; Echo-3 derives the hold from the trajectory | prototype docs 2026-11 | Removes P21's Phase 2 blocker |

**Deprecated/outdated:** `MODEL_CREDITS`, `creditsForModel`, `budgetFits`, `findWorldByDisplayName`, `setProviderOperationId`/`clearProviderOperationId`, `jobs.provider_operation_id`, World Labs asset columns, `frame_{i}.heic` purge keys (purge must switch to `list(prefix)` deletes for `captures/{cid}/`, `bundles/{cid}/`, `worlds/{wid}/`).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | TUM groundtruth camera frame uses OpenCV optical axes (x right, y down, z forward) | Fixture | Converted fixture poses flipped. The mock wouldn't notice; Phase 6 paid run reconstructs badly. Mitigation: reprojection sanity check with a TUM depth frame, or confirm from TUM tools |
| A2 | `session.tzOffset` is a string `±HH:MM` | Pitfall 3 / manifest | Contract mismatch with Phase 3/4 app. Planner locks it in zod |
| A3 | Echo-3 compares idempotent bodies byte-for-byte (vs semantically) | Pattern 1 | If semantic, the read-back rule is merely harmless |
| A4 | `MONTHLY_CREDIT_BUDGET` default (suggest 10,000 ≈ $100; daily stays 2,000) | Budget | Money policy. **Owner must confirm before Phase 6** |
| A5 | R2 accepts default SDK CRC32 checksums on multipart parts today | Pitfall 5 | Upload 501. One-line client fix, gated R2 test catches it |
| A6 | R2 honours `Range` on presigned GETs (unsigned header) | Pitfall 4 | Bundle unusable. Gated preflight test proves it |
| A7 | Echo-3 status value for cancelled jobs is `CANCELLED` | Status | Treat unknown statuses as non-terminal, so the effect is only delayed handling |
| A8 | Echo-3 accepts 640×480 bundles (docs) despite the reference validator's 1920 allowlist | Contract | Phase 6 first run fails validation (free, wastes a cycle) |

## Open Questions (RESOLVED)

1. **Resolution allowlist (A8).** DEFERRED to Phase 6 (tracked in plan 02-07 README owner items). Docs say long ≤1920 / short ≥360, but the MIT-0 validator only accepts 1920×1440 or 1920×1080. Recommendation: Phase 2 follows the docs (D-04). Before Phase 6, ask SpAItial support, or have the fixture script also emit an **upscaled 1920×1440 variant** (intrinsics ×3) into dev R2 `fixtures/` (not git) for the first paid run.
2. **Idempotency retention window.** DEFERRED to Phase 6 (STATE.md blocker). Undocumented. Phase 2 caps submit retries at 4 / ≤15 min (D-17). Confirm before Phase 6.
3. **`/v1/worlds` routes in Phase 2 (discretion).** RESOLVED: minimal change, plan 02-02. Recommendation: minimal. Update status literals so `tsc` passes, make `frames:done` enqueue nothing new (or flip to `packing` + enqueue `pack` if trivial), and leave reshaping to Phase 3/4. Budget a task for adjusting the ~10 affected test files (`frames-done`, `worlds.list`, `worker.progress`, `budget`, `quota.charge`, …). Deleting obsolete World Labs tests is legitimate. Keep the "229 green" bar for *surviving* behaviour, and state the new count.
4. **`approved_max_credits` source.** RESOLVED: null → NOT_APPROVED, plan 02-05. No app yet. Tests and `fixture:e2e` seed it. A null value → `failed/submit` `NOT_APPROVED` (never submit unapproved).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | backend, tests | ✓ | **v22.21.1** (engines/CI: 24) | CI runs 24. Avoid 24-only APIs |
| npm registry | new deps | ✓ | — | — |
| GNU tar (Git Bash) | fixture extraction | ✓ | 1.35 | `C:\Windows\System32\tar.exe` |
| ffmpeg | fixture PNG→JPEG | ✓ | 8.1.2 | Pillow 11.3 (Python 3.13 present) |
| curl | dataset download | ✓ | — | browser download |
| Neon dev direct host | `*.pg.test.ts`, migrate | ✓ (via `MIGRATE_DATABASE_URL` in `.env`; `TEST_DATABASE_URL` **not** set in `.env`) | — | tests skip |
| R2 `virtumetry-dev` + S3 creds | Range preflight test, `fixture:e2e` | ✓ (keys present in `.env`) | — | test skips |
| GitHub Actions | CI | ✗ (billing hold per Phase 1) | — | run locally, record counts |

**Missing with no fallback:** none. **Note:** run pg tests with a tiny wrapper that sets `TEST_DATABASE_URL` from `MIGRATE_DATABASE_URL` in-process after asserting the host contains `ep-mute-fog-arwonnkz` and not `-pooler`, then spawns vitest. Never echo the value.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.1 (node env), `test/**/*.test.ts` |
| Config file | `backend/vitest.config.ts` |
| Quick run command | `cd backend && npx vitest run test/bundle test/provider test/webhooks.test.ts` |
| Full suite command | `cd backend && npx tsc --noEmit && npx vitest run` |
| PG integration | `cd backend && node --env-file=.env scripts/test-pg.mjs` (sets `TEST_DATABASE_URL` from the asserted dev direct URL, runs `vitest run test/integration`) |
| R2 gated | `cd backend && node --env-file=.env scripts/test-r2.mjs` (asserts `S3_BUCKET==='virtumetry-dev'`, runs `vitest run test/integration/r2-range.s3.test.ts`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROC-04 | `arkitToOpenCV`: SpAItial golden trajectory, D-03 identity-at-(0,1.5,0), det=+1, bottom row, round-trip `inv(D·M)`, reprojection pixel | unit | `npx vitest run test/bundle/convert.test.ts` | ❌ Wave 0 |
| PROC-04 | EXIF writer: 106 B, read back by vendored `readCaptureExif`, tz shift, strictly increasing over fixture | unit | `npx vitest run test/bundle/exif.test.ts` | ❌ Wave 0 |
| PROC-04 | Validator rules D-06 (each rule a failing case + fixture passes) | unit | `npx vitest run test/bundle/validate.test.ts` | ❌ Wave 0 |
| PROC-04 | Pack fixture (local driver) → ZIP: exact entry names, method 0, intrinsics/trajectory shape, EXIF of every image ≤64 KiB and increasing, `bundle_bytes == calculatedTotalSize == file size` | unit (fs) | `npx vitest run test/bundle/pack.test.ts` | ❌ Wave 0 |
| PROC-04 | Presigned bundle on `virtumetry-dev`: `Range: bytes=0-15` → 206 + `PK\x03\x04`; CD read via Range; URL TTL 86400 in `X-Amz-Expires` | integration (gated S3) | `node --env-file=.env scripts/test-r2.mjs` | ❌ Wave 0 |
| PROC-07 | pack→submit→track→importing→ready with mock; all artifact keys exist in storage; single ready UPDATE; `charged=true` | integration (pg + local + Range via `app.listen(0)`) | `scripts/test-pg.mjs` → `pipeline.pg.test.ts` | ❌ Wave 0 |
| PROC-06 | Webhook valid → 200 + row + track `run_after` pulled in; invalid sig → 401, no row; duplicate → 200, 1 row; missing secret → 401 | integration (pg + inject) | `pipeline.pg.test.ts` / `webhooks.pg.test.ts` | ❌ Wave 0 |
| PROC-06 | `webhook_dropped`: polling alone reaches ready | integration | `pipeline.pg.test.ts -t webhook_dropped` | ❌ Wave 0 |
| PROC-10 | Scenarios FAILED/402/409/429/503/duplicate_webhooks: final status+stage+code, `charged`, ledger net, mock `submit` call count (1 key; 429/503 → 2 calls same key+identical body) | integration | `pipeline.pg.test.ts -t scenario` | ❌ Wave 0 |
| PROC-10 | `PROVIDER_MODE` default mock; live refused without `ALLOW_PAID_PROVIDER=1`; live still throws "Phase 6" | unit | `npx vitest run test/config.test.ts` | ✅ (extend) |
| PROC-08 | Two concurrent reservations exceeding daily cap → exactly one `reserved`; same for monthly; resumed key → `already`; release idempotent + dated at reservation; mock vs live mode isolation | integration (pg, pool max ≥2) | `budget.pg.test.ts` | ❌ Wave 0 |
| PROC-08 | Over-budget submit → `failed/submit BUDGET_EXCEEDED`, mock `submit` calls = 0 | integration | `pipeline.pg.test.ts -t budget` | ❌ Wave 0 |
| — | `snoozeJob` does not consume attempts; claimable after delay | integration (pg) | `queue.pg.test.ts` (extend) | ✅ (extend) |

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit && npx vitest run <touched test files>`
- **Per wave merge:** full suite + `scripts/test-pg.mjs`
- **Phase gate:** full suite + pg + gated R2 test green, plus a `fixture:e2e` run log, before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/fixtures/tiny-session/` (+ README licence) via `scripts/make-tiny-session.ts`
- [ ] `test/fixtures/mock-outputs/*`
- [ ] `test/helpers/capture-exif.ts` (vendored MIT-0 reader)
- [ ] `test/helpers/pg-schema.ts` (apply real migrations into a throwaway schema)
- [ ] `scripts/test-pg.mjs`, `scripts/test-r2.mjs` (env assertion wrappers)
- No framework install needed

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (webhook caller) | HMAC-SHA256 over raw body, `secretEquals`; fail closed if secret unset |
| V3 Session Management | no | — |
| V4 Access Control | yes | Webhook route outside auth scope but can only nudge; R2 objects private, presigned GET scoped to one key/24 h |
| V5 Input Validation | yes | zod for `session.json`/`frames.jsonl`; bounded `bodyLimit` on webhook; ZIP entry names generated server-side (no user paths); `safeJoin` in local driver |
| V6 Cryptography | yes | `node:crypto` only; no custom crypto |
| V7 Logging | yes | Never log secrets, presigned URLs (they are bearer credentials for 24 h), or `.env` values. Log keys/ids only |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged webhook | Spoofing | HMAC verify before any DB write |
| Replayed webhook (no timestamp in signature) | Tampering/Replay | `delivery_id` dedupe + nudge-only (replay can at most trigger a free status poll) |
| Webhook flood | DoS | Per-IP route rate limit, 256 KiB body limit, O(1) handler |
| Double charge via retry | Tampering (self) | Persisted key + body, read-back send, no auto new key |
| Budget race | Elevation (spend) | Advisory-locked txn, unique `(submission_key, kind)` |
| Leaked presigned bundle URL | Info disclosure | 24 h TTL, private bucket, not logged; Phase 9 lifecycle purge |
| Path traversal via manifest `file` | Tampering | Validate `file === frames/${pad6(i)}.jpg` exactly; never use it as a key verbatim |
| Accidental paid call | Financial | `PROVIDER_MODE` default mock, `ALLOW_PAID_PROVIDER` guard, live throws in Phase 2, `SPAITIAL_API_KEY` unread |

## Sources

### Primary (HIGH confidence)
- docs.spaitial.ai (markdown endpoints): `/api/capture-worlds.md`, `/api/webhooks.md`, `/api/exports.md`, `/api/worlds.md`, `/api/errors.md`, `/api/rate-limits.md`, `/api/reference/v-1-worlds-get-job-status.md`, `…-get-export.md`, `…-create-export.md`, `llms.txt`. Fetched 2026-11-23, read-only; no API calls
- github.com/spaitial-ai/spaitial-capture-prototype (MIT-0, pushed 2026-11-10): `docs/bundle-format.md`, `docs/coordinate-conventions.md`, `samples/minimal-bundle/*`, `samples/make_minimal_bundle.py`, `tools/validate-bundle/src/{exif,zip,validation}.ts`, `README`s
- Local verification runs (scratchpad): EXIF writer byte-identical to the sample APP1 and read back by SpAItial's reader; `arkitToOpenCV` reproduces the sample trajectory; yazl 3.3.1 store-only `calculatedTotalSize` exact and CD reader parses it
- npm registry (`npm view`, 2026-11-23): yazl 3.3.1, @types/yazl 3.3.1, @aws-sdk/lib-storage 3.1175.0 latest / 3.1134.0 peer `^3.1134.0`; no install scripts. slopcheck 0.6.1: all OK
- yazl README (github.com/thejoshwolfe/yazl): `addReadStreamLazy`, `size`, `calculatedTotalSize`, bit 3, ZIP64
- @aws-sdk/lib-storage 3.1134.0 README (unpkg): `Upload` options
- Fastify 5.12.8 `docs/Reference/ContentTypeParser.md` (installed): encapsulation, `removeAllContentTypeParsers`, `parseAs`, `bodyLimit`. @fastify/rate-limit README: per-route `config.rateLimit`
- Cloudflare R2 presigned URLs doc: 7-day max, no custom domains, signed headers
- TUM RGB-D: dataset page licence (CC BY 4.0), file_formats (groundtruth format, fr3 undistorted, intrinsics), download page (fr3 sizes); HEAD on the tgz URL
- Codebase: `backend/src/{budget,queue,worker,config,auth,server}.ts`, `storage/*`, `provider/*`, `db/schema.ts`, `drizzle/0000_init.sql`, `test/integration/*.pg.test.ts`, `.github/workflows/backend.yml`, drizzle-kit 0.31 `bin.cjs` (rename prompt string)

### Secondary (MEDIUM confidence)
- aws-sdk-js-v3 issue #6810 (via search mirror): R2 501 on default CRC32 checksums; `WHEN_REQUIRED` workaround
- `.planning/research/{ARCHITECTURE,PITFALLS,SUMMARY}.md`: consistent with the docs except the items flagged (trajectory nesting, orientation.json, 6 h → 24 h)

### Tertiary (LOW confidence)
- TUM camera optical-frame axis convention (A1): standard usage, not stated on the file_formats page

## Metadata

**Confidence breakdown:**
- Echo-3 format/contract: HIGH. Official docs plus the vendor's MIT-0 reference, with the sample reproduced locally
- Standard stack: HIGH. Registry and slopcheck verified, yazl behaviour run locally
- Architecture/state machine: HIGH. Follows the locked decisions and existing code patterns
- Pitfalls: HIGH for format/budget/drizzle; MEDIUM for R2 checksum/Range (gated tests settle them)
- Fixture: MEDIUM-HIGH. Licence and intrinsics verified; axis convention assumed (A1)

**Research date:** 2026-11-23
**Valid until:** 2026-12-23 (Echo-3 docs are monthly-release; recheck capture-worlds/webhooks before Phase 6)
