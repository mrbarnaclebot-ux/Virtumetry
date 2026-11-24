# Phase 4: $0 Capture-to-World Loop - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** --auto (recommended options selected by Claude; owner tests on iPhone 17 Pro in Expo Go)

<domain>
## Phase Boundary

In **Expo Go**, at zero cost, the owner runs the whole loop with a **fixture capture source**:
prep checklist + camera-permission priming → scan (fixture replay through the `CaptureSource` interface, live readiness meter, live cost meter, top-down coverage mini-map) → review (frames, duration, cost, readiness; saved on phone first; upload or discard) → checks (device rules + backend semantic validator block bad scans with a reason, before any credit) → quote → explicit approve → resumable upload (server-reconciled after force-quit, manifest last) → mock processing → "ready" in the library.

Requirements: CAP-01, CAP-05, CAP-06, CAP-07, CAP-09, CAP-10, PROC-01, PROC-02, PROC-03.

Not in this phase: native ARKit module, live coaching prompts, tracking-loss pause, frame-limit/heat/storage warnings (CAP-02/03/04/08 → Phase 8), viewer (Phase 5), live Echo-3 (Phase 6), retry (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Capture interface + fixture source (CAP-10)
- **D-01:** TS `CaptureSource` interface in `virtumetry/src/capture/types.ts`, shaped after ARCHITECTURE.md §"Capture module TS surface": `isAvailable()`, `start(gateConfig) → { sessionId }`, `stop() → { sessionId, frameCount, dir }`, `cancel()`, `addListener('pose'|'keyframe'|'tracking'|'thermal', cb) → { remove() }`. Event payloads use the **raw ARKit session-format fields** (`T_arkit` 16 floats column-major, `K`, `tracking`, `t`, `blurPx?`) so the Phase 8 native module can emit the same events. Coverage/readiness/cost logic consumes only these events — never fixture internals.
- **D-02:** `getCaptureSource()` = `requireOptionalNativeModule('VmCapture')` → native wrapper (not built in this phase; returns null in Expo Go) else `FixtureCaptureSource`. No native code in Phase 4.
- **D-03:** `FixtureCaptureSource` writes a real session directory on the phone in **session format schema 1** (`Paths.document/sessions/<sessionId>/session.json`, `frames.jsonl`, `frames/000001.jpg …`) using `expo-file-system` (SDK 58 `File`/`Directory`/`Paths` API), emitting `pose`/`keyframe`/`tracking` events on a timer that follows the fixture's `t` deltas (optionally sped up). The session directory it produces is exactly what the upload manager uploads — identical to what the native module will produce.
- **D-04:** Fixture assets: bundle the existing TUM fr3 tiny session (30 JPEGs, 640x480, ~1.65 MB, CC BY 4.0) in the app (`virtumetry/assets/fixtures/tiny-session/`, frames as `require()`d assets resolved via `expo-asset` and copied into the session dir; `frames.jsonl` as a TS/JSON module). Licence README copied alongside. No download step. New `sessionId` (UUID) per replay; `wallMs` re-based to "now" so EXIF timestamps are fresh and strictly increasing.
- **D-05:** Fixture **scenarios** selectable on the scan screen in dev (small segmented control, visible only when the fixture source is active): `good` (all 30 frames, normal tracking), `too-few` (stops after a handful of frames), `tracking-gap` (marks a run of frames `limited`/`notAvailable`), `pose-jump` (injects a >0.5 m camera-centre jump — passes device checks, blocked by the backend semantic validator). These double as deliberately broken fixtures for tests (success criterion 3).

### Readiness, cost, coverage (CAP-05/06/07)
- **D-06:** Pure TS modules in `virtumetry/src/capture/`: `readiness.ts`, `cost.ts`, `coverage.ts`, `precheck.ts`, each unit-tested with jest. HUD components render their outputs.
- **D-07:** Readiness = worst-of signals (frame count, coverage sectors, blur share, tracking-gap share) → `green | amber | red` + the single most important reason ("Keep going — 12 more frames", "Look around the rest of the room"). Thresholds are a `ReadinessConfig` object.
- **D-08:** **Remote tuning without an app build:** backend `GET /v1/capture/config` (authenticated) returns `{ readiness, precheck, pricing: { baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 }, limits: { minFrames, maxFrames } }`. Readiness/precheck thresholds come from a validated `CAPTURE_CONFIG_JSON` env (zod, merged over code defaults); limits from `provider.limits()`. App fetches on scan-screen mount via react-query, falls back to bundled defaults offline. Code defaults are realistic for real rooms; the **Railway dev** env sets `CAPTURE_CONFIG_JSON` so the 30-frame fixture can reach green (e.g. `minFramesGreen ≤ 25`). Production keeps defaults.
- **D-09:** Cost meter: `credits = baseCredits + perFrameCredits × frames`, shown as `$` (`credits × usdPerCredit`, 2 decimals) with credits in secondary text, updated per keyframe. Same function used on review and quote screens.
- **D-10:** Coverage mini-map: camera centres from `T_arkit` projected top-down onto the floor plane (ARKit world is y-up → use x/z), path polyline + short heading ticks for look direction, plus 12 × 30° yaw sectors counted as "seen". Rendered with `react-native-svg` (in Expo Go; `npx expo install react-native-svg`). Auto-fit bounds. The TUM fixture's world up is +Z (Phase 2 note) but the converted `T_arkit` is already ARKit y-up — verify in tests that the fixture path is non-degenerate top-down.

### Prep + permission priming (CAP-01)
- **D-11:** "New scan" entry point on the Library screen (header button + empty-state button) → `capture/prep` screen: 3–4 checklist items (lights on, doors open, avoid mirrors/windows glare, walk slowly) and a camera-permission priming card explaining why, then the system prompt via `expo-camera`'s `useCameraPermissions` (works in Expo Go). Shown before the **first** scan; later scans show a compact version with "Don't show again" persisted (AsyncStorage or SecureStore—whatever is already installed; prefer `expo-secure-store`/`expo-file-system` over adding a new dep). Permission denial → explanatory state with "Open Settings" (`Linking.openSettings()`). The fixture source does not need the camera, but priming still runs so the flow is real.
- **D-12:** Capture routes live under `virtumetry/src/app/capture/` as a stack outside the tabs: `prep`, `scan`, `review`, `[id]/quote` (or combined review+quote), presented modally/full-screen.

### Saved on phone + review (CAP-09)
- **D-13:** On stop, the session is registered in a **persisted local scan store** (replaces the in-memory `local-scans.ts` store; JSON index file in `Paths.document/sessions/index.json` via `expo-file-system`) with `{ id, sessionId, dir, createdAt, frameCount, durationS, readiness, precheck, serverWorldId?, uploadState }`. It shows in the Library as `saved_on_phone` (existing display state) and survives force-quit.
- **D-14:** Review screen: frame count, duration, cost ($ + credits), readiness badge, precheck result, thumbnail strip of a few frames. Actions: **Upload** (goes to checks → quote → approve) and **Discard** (confirm, deletes the session dir + index entry). A session is deleted from the phone only after the server reports `packing` or later (ARCHITECTURE upload rule 4).

### Checks before credit (PROC-01)
- **D-15:** Device precheck (`precheck.ts`, pure): frame count ≥ min (from config/limits) and ≤ max, blur share ≤ threshold (frames with `blurPx` > 64), tracking-gap share ≤ threshold (non-`normal` frames), coverage sectors ≥ threshold. Failing precheck disables Upload and shows the reason(s). Thresholds from `/v1/capture/config`.
- **D-16:** Backend re-runs the same rules plus semantic checks **before any credit**: extend `backend/src/bundle/validate.ts` with (a) the device rules (count, tracking — already partly there), (b) pose continuity (existing `MAX_CENTRE_JUMP_M`), (c) **forward vector vs motion** (camera −Z forward should not be consistently opposite the direction of travel; flag when the median angle between forward and motion for moving segments > ~120°, named constant), (d) **intrinsics vs image size** (`cx,cy` near centre ±25 %, `fx/fy` ratio ~1, already bounds-checked). The shared rule constants are mirrored in the app (hand-copied like the session type; a test in each side pins the numbers).
- **D-17:** Backend check runs at `:complete` time synchronously on `session.json` + `frames.jsonl` (cheap, no JPEG download) — failure → world `failed`, `failure_stage=validate`, `charged=false`, human `failure_message`, and the app shows the reason on the upload screen / library row. The pack job keeps its existing validation as a second line. No credits are reserved before validation passes.

### Quote + approval (PROC-02)
- **D-18:** `GET /v1/quote?frames=N` → `provider.quote(N)` (mock: `900 + N`) + remaining daily/monthly budget → `{ credits, usd, budgetRemaining, withinBudget }`. Quote screen shows "This scan will use ~N credits ≈ $X" and an explicit **Approve & process** button (disabled when over budget, with reason). No processing without that tap.
- **D-19:** Approval is stored at scan create: `POST /v1/scans` body includes `approved_max_credits` (= quoted credits); the submit job refuses `quote > approved_max_credits` (existing pipeline logic per ARCHITECTURE §state machine). The approval timestamp is recorded.

### Session-format upload routes + resumable upload (PROC-03)
- **D-20:** New app-facing routes (new file `backend/src/routes/scans.ts`), all owner-scoped via `findOwnedWorld` (404 for others):
  - `POST /v1/scans` (Idempotency-Key = local sessionId UUID; body `{ title?, frame_count, image_w, image_h, approved_max_credits }`) → world `uploading` + capture row; replays same world on retry; charges scan quota once.
  - `POST /v1/scans/:id/uploads` `{ files: ["frames/000001.jpg", …, "frames.jsonl", "session.json"] }` → batched presigned PUTs (`.jpg` `image/jpeg`, JSON `application/json`), TTL ~6 h, max batch size (e.g. 200).
  - `GET /v1/scans/:id/uploads:missing` → ListObjectsV2 on `captures/{cid}/` via new `StorageDriver.listKeys(prefix)` (S3 + local drivers) → `{ missingFrames: [...], manifestPresent: bool }`. R2 is the source of truth.
  - `POST /v1/scans/:id:complete` → verifies `session.json` + `frames.jsonl` exist, parses with the Phase 2 zod schema, every listed frame exists, runs D-16 checks, then flips `uploading → packing` in one conditional statement and enqueues `pack` (replay-safe: repeat calls return current state).
  - Old `/v1/worlds` POST + `uploads:refresh` + `frames:done` (`.heic`) are **removed** with their tests (nothing in the app uses them); `GET/PATCH/DELETE /v1/worlds` library routes stay.
- **D-21:** App upload manager (`virtumetry/src/upload/manager.ts`), app-scoped singleton started from the root layout (not tied to a screen): for each local scan in `uploading`/`approved` state → ensure server scan (idempotent create) → `uploads:missing` → presign batch → enqueue **all** missing frame PUTs at once with `expo-file-system` `File.createUploadTask(url, { httpMethod: 'PUT', headers, sessionType: background default })` (fall back to `File.upload`/`fetch` if the task API misbehaves in Expo Go — researcher verifies the exact SDK 58 API), limited concurrency (~4) in-JS; when no frames missing → PUT `frames.jsonl` then `session.json` **last** → `:complete`. Runs on app launch and on `AppState` → `active`. Progress = uploaded/total from the reconcile result plus live task progress. 403 on PUT → re-presign. No client-side completion bookkeeping is trusted.
- **D-22:** Upload-manager logic is a pure-ish reconciler with injected `api` + `uploader` so jest can simulate a force-quit (half the frames uploaded, process "restarts", reconcile requests only the missing ones, manifest PUT happens after all frames, `:complete` once).

### End-to-end to ready (success criterion 4)
- **D-23:** After `:complete` the existing Phase 2 pipeline runs unchanged on dev: pack → submit (mock, budget reservation, approved_max check) → track → import → `ready`. Library polling (Phase 3, 5 s while non-terminal) shows progress. Backend e2e test (vitest, local storage driver + Neon dev): create scan → presign → PUT fixture files → missing → complete → run worker jobs → `ready`, plus broken-fixture cases (`pose-jump`, `too-few`, `tracking-gap`) end `failed/validate` with **zero** ledger rows.

### Dev budget for owner testing
- **D-24:** Raise `DAILY_CREDIT_BUDGET` (e.g. 10000) and `MONTHLY_CREDIT_BUDGET` (e.g. 100000) and `DAILY_SCAN_QUOTA` (e.g. 30) **on the Railway dev environment only** (mock spends only; ledger rows are mode-tagged so they never count against live). Production values untouched. Also add a guarded `npm run budget:reset-dev` script (dev-guard refuses prod) that deletes today's mock ledger rows for the owner — optional convenience.

### Testing
- **D-25:** App (jest-expo + RNTL, bounded `npx jest --ci`): readiness/cost/coverage/precheck unit tests; fixture source emits events and writes a schema-1 session dir (mock `expo-file-system`); review screen RNTL (shows count/duration/cost/readiness, Upload/Discard); quote screen requires explicit approve; upload-manager reconciliation + force-quit simulation; prep screen first-run vs later. `npm run lint` + `npx tsc --noEmit` clean.
- **D-26:** Backend (vitest, Neon dev via `TEST_DATABASE_URL`): scans routes (idempotent create, ownership 404, presign batch, missing, complete replay), new validator rules with broken fixtures generated in-test from the tiny session, quote route, capture config env parsing, e2e to ready, zero credits on validation failure. Existing suites green; `tsc --noEmit` clean.

### Claude's Discretion
- File layout under `virtumetry/src/capture/` and `src/upload/`, HUD visuals (governed by the UI-SPEC), replay speed, exact default threshold numbers, batch sizes, plan/wave split.
- Whether review and quote are one screen or two (prefer one scrolling screen with an explicit approve step if simpler).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope
- `.planning/ROADMAP.md` §"Phase 4" — goal + 5 success criteria
- `.planning/REQUIREMENTS.md` — CAP-01/05/06/07/09/10, PROC-01/02/03
- `.planning/PROJECT.md` — Echo-3 facts (cost 900+frames, 1 credit = $0.01), constraints
- `CLAUDE.md`, `virtumetry/AGENTS.md` — Expo rules (`npx expo install`, versioned docs, lint+tsc), EAS quota rules (never `eas build`)

### Architecture / research
- `.planning/research/ARCHITECTURE.md` — CaptureSource surface, FixtureCaptureSource, upload manager, per-frame presigned PUTs, `uploads:missing`, `:complete`, background uploads on SDK 58 (server-reconciled), data flow, state machine
- `.planning/research/STACK.md` — expo-file-system SDK 58 `File.upload`/`createUploadTask` (background session; JS task not restored after termination)
- `.planning/research/PITFALLS.md` — upload ledger server-authoritative, fake capture source in Expo Go, pre-upload gate
- `.planning/research/FEATURES.md` — readiness meter, coverage mini-map, cost quote UX

### Prior phases
- `.planning/phases/02-bundle-pipeline-mock-provider/02-CONTEXT.md` — session format schema 1 (D-01/D-02), validator (D-06), mock quote/scenarios (D-12/13), state machine (D-15), budget (D-18)
- `.planning/phases/03-owner-account-scan-library/03-CONTEXT.md` — auth (cookie via `getCookie()`), library display states incl. `saved_on_phone`, react-query polling, Railway dev env
- `.planning/phases/03-owner-account-scan-library/03-UI-SPEC.md` — tokens, branding, components to reuse
- `.planning/phases/03-owner-account-scan-library/03-HUMAN-UAT.md` — how the owner tests on the phone

### Code
- `backend/src/bundle/manifest.ts` — zod schema (source of truth for session format)
- `backend/src/bundle/validate.ts` — existing rules + constants to extend
- `backend/test/fixtures/tiny-session/` — fixture (README = licence)
- `backend/src/routes/worlds.ts` — current create/presign/frames:done routes to replace; library routes to keep
- `backend/src/storage/{index,s3,local}.ts` — add `listKeys`
- `backend/src/pipeline.ts`, `backend/src/budget.ts`, `backend/src/provider/mock.ts`
- `virtumetry/src/library/{local-scans,display-state}.ts`, `virtumetry/src/lib/api.ts`, `virtumetry/src/app/(tabs)/index.tsx`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `virtumetry/src/lib/api.ts` — authenticated fetch (Better Auth cookie) → extend with scans/quote/config calls
- `virtumetry/src/library/display-state.ts` — already has `saved_on_phone`; `local-scans.ts` in-memory store → make persistent
- `virtumetry/src/components/library-row.tsx`, `themed-*`, `constants/theme.ts` — UI building blocks
- `backend/src/bundle/manifest.ts` (zod session schema), `validate.ts` (rules), `convert.ts`
- Existing idempotent-create pattern (`client_request_id`, unique violation replay, quota charge/release) in `routes/worlds.ts`
- Presign helpers + `frameSizeMap` (exact Content-Length binding) in `routes/worlds.ts` / `storage/s3.ts`
- `findOwnedWorld` ownership helper (404)

### Established Patterns
- Backend: Fastify routes take `RouteDeps`, zod body parsing, per-route rate-limit buckets; tests in vitest against Neon dev, local storage driver
- App: Expo Router under `src/app/`, non-route code outside, react-query, jest-expo + RNTL tests in `src/__tests__/`
- Guarded dev scripts in `backend/scripts/` via `dev-guard.mjs`

### Integration Points
- Library screen gets the "New scan" entry + local saved scans
- Root layout starts the upload manager (after sign-in)
- Pipeline `pack` job is enqueued by `:complete`
- Railway dev env vars: `CAPTURE_CONFIG_JSON`, raised budgets

</code_context>

<specifics>
## Specific Ideas

- Cost meter format: "$9.30 · 930 credits" (900 + 30 frames).
- Readiness wording is directive, one reason at a time.
- Fixture scenario switcher visible only with the fixture source, so the Phase 8 native path shows a real camera preview in the same screen.

</specifics>

<deferred>
## Deferred Ideas

- Live coaching prompts, tracking-loss pause, heat/storage warnings — Phase 8 (CAP-03/04/08)
- Debug UI for tuning readiness thresholds on device — later (env-based tuning covers v1)
- Push notification "your room is ready" — later
- Retry processing — Phase 6
- Background-upload survival verification outside Expo Go — first dev build (Phase 8)

</deferred>

---

*Phase: 04-0-capture-to-world-loop*
*Context gathered: 2026-11-24*
