# Phase 4: $0 Capture-to-World Loop - Research

**Researched:** 2026-11-24
**Domain:** Expo SDK 58 app (fixture capture, HUD logic, file system, background upload) + Fastify/Drizzle backend (session-format upload routes, semantic validator, quote/config routes)
**Confidence:** HIGH for the code facts (read from the repo and probed locally). MEDIUM for Expo Go runtime behaviour (from docs and installed typings, not run on a device).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Capture interface + fixture source (CAP-10)
- **D-01:** TS `CaptureSource` interface in `virtumetry/src/capture/types.ts`, shaped after ARCHITECTURE.md §"Capture module TS surface": `isAvailable()`, `start(gateConfig) → { sessionId }`, `stop() → { sessionId, frameCount, dir }`, `cancel()`, `addListener('pose'|'keyframe'|'tracking'|'thermal', cb) → { remove() }`. Event payloads use the **raw ARKit session-format fields** (`T_arkit` 16 floats column-major, `K`, `tracking`, `t`, `blurPx?`) so the Phase 8 native module can emit the same events. Coverage/readiness/cost logic consumes only these events — never fixture internals.
- **D-02:** `getCaptureSource()` = `requireOptionalNativeModule('VmCapture')` → native wrapper (not built in this phase; returns null in Expo Go) else `FixtureCaptureSource`. No native code in Phase 4.
- **D-03:** `FixtureCaptureSource` writes a real session directory on the phone in **session format schema 1** (`Paths.document/sessions/<sessionId>/session.json`, `frames.jsonl`, `frames/000001.jpg …`) using `expo-file-system` (SDK 58 `File`/`Directory`/`Paths` API), emitting `pose`/`keyframe`/`tracking` events on a timer that follows the fixture's `t` deltas (optionally sped up). The session directory it produces is exactly what the upload manager uploads — identical to what the native module will produce.
- **D-04:** Fixture assets: bundle the existing TUM fr3 tiny session (30 JPEGs, 640x480, ~1.65 MB, CC BY 4.0) in the app (`virtumetry/assets/fixtures/tiny-session/`, frames as `require()`d assets resolved via `expo-asset` and copied into the session dir; `frames.jsonl` as a TS/JSON module). Licence README copied alongside. No download step. New `sessionId` (UUID) per replay; `wallMs` re-based to "now" so EXIF timestamps are fresh and strictly increasing.
- **D-05:** Fixture **scenarios** selectable on the scan screen in dev (small segmented control, visible only when the fixture source is active): `good` (all 30 frames, normal tracking), `too-few` (stops after a handful of frames), `tracking-gap` (marks a run of frames `limited`/`notAvailable`), `pose-jump` (injects a >0.5 m camera-centre jump — passes device checks, blocked by the backend semantic validator). These double as deliberately broken fixtures for tests (success criterion 3).

#### Readiness, cost, coverage (CAP-05/06/07)
- **D-06:** Pure TS modules in `virtumetry/src/capture/`: `readiness.ts`, `cost.ts`, `coverage.ts`, `precheck.ts`, each unit-tested with jest. HUD components render their outputs.
- **D-07:** Readiness = worst-of signals (frame count, coverage sectors, blur share, tracking-gap share) → `green | amber | red` + the single most important reason ("Keep going — 12 more frames", "Look around the rest of the room"). Thresholds are a `ReadinessConfig` object.
- **D-08:** **Remote tuning without an app build:** backend `GET /v1/capture/config` (authenticated) returns `{ readiness, precheck, pricing: { baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 }, limits: { minFrames, maxFrames } }`. Readiness/precheck thresholds come from a validated `CAPTURE_CONFIG_JSON` env (zod, merged over code defaults); limits from `provider.limits()`. App fetches on scan-screen mount via react-query, falls back to bundled defaults offline. Code defaults are realistic for real rooms; the **Railway dev** env sets `CAPTURE_CONFIG_JSON` so the 30-frame fixture can reach green (e.g. `minFramesGreen ≤ 25`). Production keeps defaults.
- **D-09:** Cost meter: `credits = baseCredits + perFrameCredits × frames`, shown as `$` (`credits × usdPerCredit`, 2 decimals) with credits in secondary text, updated per keyframe. Same function used on review and quote screens.
- **D-10:** Coverage mini-map: camera centres from `T_arkit` projected top-down onto the floor plane (ARKit world is y-up → use x/z), path polyline + short heading ticks for look direction, plus 12 × 30° yaw sectors counted as "seen". Rendered with `react-native-svg` (in Expo Go; `npx expo install react-native-svg`). Auto-fit bounds. The TUM fixture's world up is +Z (Phase 2 note) but the converted `T_arkit` is already ARKit y-up — verify in tests that the fixture path is non-degenerate top-down.

#### Prep + permission priming (CAP-01)
- **D-11:** "New scan" entry point on the Library screen (header button + empty-state button) → `capture/prep` screen: 3–4 checklist items (lights on, doors open, avoid mirrors/windows glare, walk slowly) and a camera-permission priming card explaining why, then the system prompt via `expo-camera`'s `useCameraPermissions` (works in Expo Go). Shown before the **first** scan; later scans show a compact version with "Don't show again" persisted (AsyncStorage or SecureStore—whatever is already installed; prefer `expo-secure-store`/`expo-file-system` over adding a new dep). Permission denial → explanatory state with "Open Settings" (`Linking.openSettings()`). The fixture source does not need the camera, but priming still runs so the flow is real.
- **D-12:** Capture routes live under `virtumetry/src/app/capture/` as a stack outside the tabs: `prep`, `scan`, `review`, `[id]/quote` (or combined review+quote), presented modally/full-screen.

#### Saved on phone + review (CAP-09)
- **D-13:** On stop, the session is registered in a **persisted local scan store** (replaces the in-memory `local-scans.ts` store; JSON index file in `Paths.document/sessions/index.json` via `expo-file-system`) with `{ id, sessionId, dir, createdAt, frameCount, durationS, readiness, precheck, serverWorldId?, uploadState }`. It shows in the Library as `saved_on_phone` (existing display state) and survives force-quit.
- **D-14:** Review screen: frame count, duration, cost ($ + credits), readiness badge, precheck result, thumbnail strip of a few frames. Actions: **Upload** (goes to checks → quote → approve) and **Discard** (confirm, deletes the session dir + index entry). A session is deleted from the phone only after the server reports `packing` or later (ARCHITECTURE upload rule 4).

#### Checks before credit (PROC-01)
- **D-15:** Device precheck (`precheck.ts`, pure): frame count ≥ min (from config/limits) and ≤ max, blur share ≤ threshold (frames with `blurPx` > 64), tracking-gap share ≤ threshold (non-`normal` frames), coverage sectors ≥ threshold. Failing precheck disables Upload and shows the reason(s). Thresholds from `/v1/capture/config`.
- **D-16:** Backend re-runs the same rules plus semantic checks **before any credit**: extend `backend/src/bundle/validate.ts` with (a) the device rules (count, tracking — already partly there), (b) pose continuity (existing `MAX_CENTRE_JUMP_M`), (c) **forward vector vs motion** (camera −Z forward should not be consistently opposite the direction of travel; flag when the median angle between forward and motion for moving segments > ~120°, named constant), (d) **intrinsics vs image size** (`cx,cy` near centre ±25 %, `fx/fy` ratio ~1, already bounds-checked). The shared rule constants are mirrored in the app (hand-copied like the session type; a test in each side pins the numbers).
- **D-17:** Backend check runs at `:complete` time synchronously on `session.json` + `frames.jsonl` (cheap, no JPEG download) — failure → world `failed`, `failure_stage=validate`, `charged=false`, human `failure_message`, and the app shows the reason on the upload screen / library row. The pack job keeps its existing validation as a second line. No credits are reserved before validation passes.

#### Quote + approval (PROC-02)
- **D-18:** `GET /v1/quote?frames=N` → `provider.quote(N)` (mock: `900 + N`) + remaining daily/monthly budget → `{ credits, usd, budgetRemaining, withinBudget }`. Quote screen shows "This scan will use ~N credits ≈ $X" and an explicit **Approve & process** button (disabled when over budget, with reason). No processing without that tap.
- **D-19:** Approval is stored at scan create: `POST /v1/scans` body includes `approved_max_credits` (= quoted credits); the submit job refuses `quote > approved_max_credits` (existing pipeline logic per ARCHITECTURE §state machine). The approval timestamp is recorded.

#### Session-format upload routes + resumable upload (PROC-03)
- **D-20:** New app-facing routes (new file `backend/src/routes/scans.ts`), all owner-scoped via `findOwnedWorld` (404 for others):
  - `POST /v1/scans` (Idempotency-Key = local sessionId UUID; body `{ title?, frame_count, image_w, image_h, approved_max_credits }`) → world `uploading` + capture row; replays same world on retry; charges scan quota once.
  - `POST /v1/scans/:id/uploads` `{ files: ["frames/000001.jpg", …, "frames.jsonl", "session.json"] }` → batched presigned PUTs (`.jpg` `image/jpeg`, JSON `application/json`), TTL ~6 h, max batch size (e.g. 200).
  - `GET /v1/scans/:id/uploads:missing` → ListObjectsV2 on `captures/{cid}/` via new `StorageDriver.listKeys(prefix)` (S3 + local drivers) → `{ missingFrames: [...], manifestPresent: bool }`. R2 is the source of truth.
  - `POST /v1/scans/:id:complete` → verifies `session.json` + `frames.jsonl` exist, parses with the Phase 2 zod schema, every listed frame exists, runs D-16 checks, then flips `uploading → packing` in one conditional statement and enqueues `pack` (replay-safe: repeat calls return current state).
  - Old `/v1/worlds` POST + `uploads:refresh` + `frames:done` (`.heic`) are **removed** with their tests (nothing in the app uses them); `GET/PATCH/DELETE /v1/worlds` library routes stay.
- **D-21:** App upload manager (`virtumetry/src/upload/manager.ts`), app-scoped singleton started from the root layout (not tied to a screen): for each local scan in `uploading`/`approved` state → ensure server scan (idempotent create) → `uploads:missing` → presign batch → enqueue **all** missing frame PUTs at once with `expo-file-system` `File.createUploadTask(url, { httpMethod: 'PUT', headers, sessionType: background default })` (fall back to `File.upload`/`fetch` if the task API misbehaves in Expo Go — researcher verifies the exact SDK 58 API), limited concurrency (~4) in-JS; when no frames missing → PUT `frames.jsonl` then `session.json` **last** → `:complete`. Runs on app launch and on `AppState` → `active`. Progress = uploaded/total from the reconcile result plus live task progress. 403 on PUT → re-presign. No client-side completion bookkeeping is trusted.
- **D-22:** Upload-manager logic is a pure-ish reconciler with injected `api` + `uploader` so jest can simulate a force-quit (half the frames uploaded, process "restarts", reconcile requests only the missing ones, manifest PUT happens after all frames, `:complete` once).

#### End-to-end to ready (success criterion 4)
- **D-23:** After `:complete` the existing Phase 2 pipeline runs unchanged on dev: pack → submit (mock, budget reservation, approved_max check) → track → import → `ready`. Library polling (Phase 3, 5 s while non-terminal) shows progress. Backend e2e test (vitest, local storage driver + Neon dev): create scan → presign → PUT fixture files → missing → complete → run worker jobs → `ready`, plus broken-fixture cases (`pose-jump`, `too-few`, `tracking-gap`) end `failed/validate` with **zero** ledger rows.

#### Dev budget for owner testing
- **D-24:** Raise `DAILY_CREDIT_BUDGET` (e.g. 10000) and `MONTHLY_CREDIT_BUDGET` (e.g. 100000) and `DAILY_SCAN_QUOTA` (e.g. 30) **on the Railway dev environment only** (mock spends only; ledger rows are mode-tagged so they never count against live). Production values untouched. Also add a guarded `npm run budget:reset-dev` script (dev-guard refuses prod) that deletes today's mock ledger rows for the owner — optional convenience.

#### Testing
- **D-25:** App (jest-expo + RNTL, bounded `npx jest --ci`): readiness/cost/coverage/precheck unit tests; fixture source emits events and writes a schema-1 session dir (mock `expo-file-system`); review screen RNTL (shows count/duration/cost/readiness, Upload/Discard); quote screen requires explicit approve; upload-manager reconciliation + force-quit simulation; prep screen first-run vs later. `npm run lint` + `npx tsc --noEmit` clean.
- **D-26:** Backend (vitest, Neon dev via `TEST_DATABASE_URL`): scans routes (idempotent create, ownership 404, presign batch, missing, complete replay), new validator rules with broken fixtures generated in-test from the tiny session, quote route, capture config env parsing, e2e to ready, zero credits on validation failure. Existing suites green; `tsc --noEmit` clean.

### Claude's Discretion
- File layout under `virtumetry/src/capture/` and `src/upload/`, HUD visuals (governed by the UI-SPEC), replay speed, exact default threshold numbers, batch sizes, plan/wave split.
- Whether review and quote are one screen or two (prefer one scrolling screen with an explicit approve step if simpler).

### Deferred Ideas (OUT OF SCOPE)
- Live coaching prompts, tracking-loss pause, heat/storage warnings — Phase 8 (CAP-03/04/08)
- Debug UI for tuning readiness thresholds on device — later (env-based tuning covers v1)
- Push notification "your room is ready" — later
- Retry processing — Phase 6
- Background-upload survival verification outside Expo Go — first dev build (Phase 8)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAP-01 | Prep checklist + camera-permission priming before first scan | `expo-camera` `useCameraPermissions` (in Expo Go, returns `granted/status/canAskAgain`), `Linking.openSettings()` from `react-native`, "seen"/"don't show" flags in `expo-secure-store` (installed, already mocked in `jest.setup.ts`). §Standard Stack, §Code Examples |
| CAP-05 | Readiness meter with remotely tunable thresholds | `GET /v1/capture/config` + `CAPTURE_CONFIG_JSON` zod-merged in `config.ts`. Dev values computed from the fixture geometry (§Fixture geometry). |
| CAP-06 | Live cost meter (900 + frames credits in $) | Pure `cost.ts`. Pricing comes from `/v1/capture/config`, and mock `quote()` = `900 + n` (verified in `provider/mock.ts`). |
| CAP-07 | Top-down coverage mini-map | Verified: fixture `T_arkit` is y-up. Height y = 1.88–1.94 m, x/z path is 0.11 m × 2.51 m (non-degenerate but nearly a straight line). `react-native-svg` 15.16.0 is in Expo Go. |
| CAP-09 | Saved on phone first, review, upload/discard | `expo-file-system` `File`/`Directory`/`Paths` (58.0.14 installed transitively), JSON index file. jest-expo ships an in-memory FS mock. |
| CAP-10 | Fixture source through the same interface | `requireOptionalNativeModule` and `uuid` exported from `expo`. 30 frames via `expo-asset` + `File.copy`. Injected asset resolver and clock for jest. |
| PROC-01 | Device prechecks + backend same rules + semantic checks | `validate.ts` extension design. Forward-vs-motion rule checked on the fixture: XZ median 4.7° (good), 175° (reversed poses). Pose-jump yields exactly one `CAMERA_JUMP`. |
| PROC-02 | Quote shown, explicit approval before processing | `approvedMaxCredits` column exists. Submit already refuses `NOT_APPROVED` / `QUOTE_ABOVE_APPROVAL` (verified `pipeline.ts`). Budget-remaining helper extracted from `budget.ts` SQL. |
| PROC-03 | Uploads survive suspension; after force-quit resend only missing frames, manifest last | `File.createUploadTask`/`upload` (PUT, headers, `sessionType:'background'` default; **non-2xx resolves, does not reject**). Server reconcile via the existing `StorageDriver.list(prefix)`. Fastify colon-route escaping verified. |
</phase_requirements>

## Project Constraints (from CLAUDE.md / virtumetry/AGENTS.md)

- **Never run `eas build`** without asking. Phase 4 needs no build: everything runs in Expo Go.
- Install app deps only with `npx expo install <pkg>` (SDK-matched). Fetch versioned SDK 58 docs before touching Expo APIs.
- Run `npx expo lint` + `npx tsc --noEmit` (app) and `npx tsc --noEmit` (backend) before declaring done.
- Routes go in `src/app/` only. Non-route code goes outside (`src/capture/`, `src/upload/`). Import router things from `expo-router`.
- Money: never call the real SpAItial/Echo-3 API. Use `PROVIDER_MODE=mock` everywhere. Budget caps are enforced server-side. Persist before spend.
- Data isolation: Neon dev branch + `virtumetry-dev` R2 only. Never VirtSpace, never prod (`config.ts` guards enforce this).
- Migrations: `drizzle-kit generate` + `scripts/migrate-dev.mjs` (dev guard). Never `push`. **This research recommends no migration for Phase 4** (see D-19 note).
- Tests must only touch rows they create (shared Neon dev branch; Phase 3 D-14).
- No Maestro. App tests run in jest-expo on Windows/CI. Backend tests run in vitest (pg suites skip without `TEST_DATABASE_URL`).
- Keep the logic in TS. No Swift in this phase.

## Summary

Nearly all the infrastructure already exists. The backend has the idempotent-create pattern, quota charge/release, `findOwnedWorld`, presigning with exact-Content-Length binding, a **`StorageDriver.list(prefix)` already implemented for both S3 (ListObjectsV2 with pagination) and local drivers**, the schema-1 zod parser, the validator, and a pipeline whose submit step already refuses `NOT_APPROVED` and `QUOTE_ABOVE_APPROVAL`. The phase is mostly re-plumbing: a new `routes/scans.ts` (create, presign batch, missing, complete), two read routes (`/v1/quote`, `/v1/capture/config`), three or four new validator rules, then deleting the old `/v1/worlds` create, `uploads:refresh` and `frames:done` routes and migrating six test files. D-20's "new `listKeys`" is not needed. Reuse `list()`.

On the app side, everything needed ships in Expo Go: `expo-file-system` 58.0.14 and `expo-asset` 58.0.21 are already in `node_modules` transitively, and `expo-camera` ~58.0.14, `react-native-svg` 15.16.0 and `expo-keep-awake` ~58.0.4 are in Expo's `bundledNativeModules.json`. SDK 58 `File.upload(url, { httpMethod: 'PUT', headers })` / `createUploadTask` do binary-body PUTs from a file on a background `URLSession` by default (iOS native source read). jest-expo ships an in-memory `FileSystem` mock, so the fixture-source and store tests run without hand-written FS mocks.

There are four **blocking findings** the plan must handle: (1) **Fastify `:id:complete` does not route as intended.** `'/v1/scans/:id::complete'` captures `id = "abc:complete"`. Use the regex param `'/v1/scans/:id([0-9a-fA-F-]{36})::complete'` (verified with the installed fastify 5.12.8 / find-my-way 9.10.0). (2) **S3 presigned PUT TTL is hard-coded to 900 s.** Background tasks queued all at once can start after 15 min, so `presignUpload` needs a `ttlSeconds` argument (6 h). (3) **The mock provider's output files are not in the Docker image.** `backend/test` is dockerignored, so on Railway dev the import step fails and the track job snoozes forever. The world never reaches `ready`, which breaks success criterion 4's manual run. The Dockerfile must copy `backend/test/fixtures/mock-outputs` (42 KB). (4) **The new precheck thresholds also flow into the pack job and the existing pipeline tests.** The 30-frame fixture only reaches 1–2 of 12 yaw sectors, so test harnesses and Railway dev must set fixture-friendly `CAPTURE_CONFIG_JSON`, or existing `pipeline.pg` tests break.

**Primary recommendation:** Build the backend first (capture-config + validator rules + scans routes + quote + Dockerfile fix + test migration), then app pure modules (cost/readiness/coverage/precheck/fixture source/store/reconciler), then screens + upload manager wiring, then the owner's Expo Go walkthrough on Railway dev with the dev env vars set.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Fixture replay + session dir writing | Browser/Client (app, `src/capture/fixture-source.ts`) | — | Must produce byte-identical session dir to the future native module |
| Readiness / cost / coverage / precheck math | Client (pure TS) | API (thresholds + pricing via `/v1/capture/config`) | Live HUD needs per-frame local compute; tuning must not need a build |
| Semantic validation (pose jump, forward-vs-motion, intrinsics) | API (`bundle/validate.ts` at `:complete`) | Worker (pack re-validates) | Server is the trust boundary before money; the client can be bypassed |
| Quote + budget remaining | API (`/v1/quote`) | — | Budget ledger lives in Postgres; `withinBudget` is never computed locally (UI-SPEC) |
| Approval ceiling | API/DB (`worlds.approved_max_credits`) | Worker (submit refuses) | Persisted before any spend |
| Upload completion truth | Storage (R2 listing via API `uploads:missing`) | Client (re-enqueue) | JS task callbacks are lost after termination |
| Local saved scans | Client (`Paths.document/sessions/index.json`) | — | Only copy of raw frames until server reaches `packing` |
| Processing → ready | Worker (existing pipeline, mock provider) | — | Unchanged from Phase 2 |

## Standard Stack

### Core (app; all in Expo Go, no build)
| Library | Version (SDK 58) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `expo-file-system` | ~58.0.14 (installed transitively, make it direct) | Session dir, index file, `File.upload`/`createUploadTask` | Official SDK module. Class API `File`/`Directory`/`Paths`. [VERIFIED: node_modules typings + docs.expo.dev/versions/v58.0.0/sdk/filesystem] |
| `expo-asset` | ~58.0.21 (installed transitively, make it direct) | Resolve `require()`d fixture JPEGs to a local file URI | Official. `Asset.loadAsync(module)` → `localUri` [ASSUMED API shape, standard for years. Verify on device] |
| `expo-camera` | ~58.0.14 | `useCameraPermissions` only | "Included in Expo Go". Returns `[PermissionResponse|null, request, get]` with `granted`, `status`, `canAskAgain` [CITED: docs.expo.dev/versions/v58.0.0/sdk/camera] |
| `react-native-svg` | 15.16.0 | Coverage mini-map | "Included in Expo Go" [CITED: docs.expo.dev/versions/v58.0.0/sdk/svg]. Already in the jest `transformIgnorePatterns` allowlist [VERIFIED: package.json] |
| `expo-keep-awake` | ~58.0.4 | Screen on while recording (UI-SPEC default) | In Expo Go. `useKeepAwake()` [ASSUMED API] |
| `expo` (exports) | ~58.0.26 | `requireOptionalNativeModule`, `uuid.v4()`, `isRunningInExpoGo` | Re-exported from expo-modules-core [VERIFIED: node_modules/expo/build/Expo.d.ts] |

Already installed and reused: `@tanstack/react-query` (config/quote queries), `expo-secure-store` (prep flags), `expo-image` (preview + thumbnails), `expo-symbols`.

### Backend: no new dependencies
| Existing | Use |
|---------|-----|
| `zod` 4 | `CAPTURE_CONFIG_JSON` schema, scans bodies |
| `@aws-sdk/client-s3` presigner | presign batch (add TTL arg) |
| `StorageDriver.list(prefix)` | `uploads:missing` and `:complete` (already S3 ListObjectsV2 + local readdir) |
| `bundle/manifest.ts`, `validate.ts`, `convert.ts` | parse + validate at `:complete` |

**UUIDs in the app:** use `uuid.v4()` from `expo`. Do NOT add `expo-crypto` or `uuid`. `crypto.randomUUID` on Hermes is not guaranteed [ASSUMED].

**Installation:**
```bash
cd virtumetry
npx expo install expo-file-system expo-asset expo-camera react-native-svg expo-keep-awake
```
Optionally add `["expo-camera", { "cameraPermission": "..." }]` to `app.json` plugins now. It only affects the next native binary (Phase 7/8), costs nothing today, and Expo Go ignores it.

## Package Legitimacy Audit

slopcheck could not be installed in this environment, so per protocol every package is tagged `[ASSUMED]`. Mitigating evidence: all five are first-party Expo SDK packages, or `react-native-svg`, which Expo pins. Each appears in `node_modules/expo/bundledNativeModules.json` (the authoritative SDK 58 version map), and `npm view` shows no `postinstall` script for any of them.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| expo-file-system | npm 58.0.14 | years | very high | github.com/expo/expo | unavailable | Approved [ASSUMED]: already in node_modules |
| expo-asset | npm 58.0.21 | years | very high | github.com/expo/expo | unavailable | Approved [ASSUMED]: already in node_modules |
| expo-camera | npm 58.0.14 | years | very high | github.com/expo/expo | unavailable | Approved [ASSUMED] |
| react-native-svg | npm 15.16.1 latest; SDK pins 15.16.0 | years | very high | github.com/software-mansion/react-native-svg | unavailable | Approved [ASSUMED]. Let `npx expo install` pick 15.16.0 |
| expo-keep-awake | npm 58.0.4 | years | very high | github.com/expo/expo | unavailable | Approved [ASSUMED]: already in node_modules |

**Packages removed:** none. **Flagged [SUS]:** none. The planner may use a light `checkpoint:human-verify` ("confirm `npx expo install` resolved the bundled versions").

## Architecture Patterns

### System Architecture Diagram

```
 Library ──"New scan"──▶ capture/prep ──(perm granted / fixture)──▶ capture/scan
                                                                       │ start(gateConfig)
                          GET /v1/capture/config (react-query, fallback defaults)
                                                                       ▼
   getCaptureSource(): requireOptionalNativeModule('VmCapture') ?? FixtureCaptureSource
          │  timer follows fixture t-deltas (scenario: good/too-few/tracking-gap/pose-jump)
          │  writes Paths.document/sessions/<sid>/{frames/NNNNNN.jpg, frames.jsonl, session.json}
          ▼ events: keyframe {i,t,T_arkit,K,tracking,blurPx?}
   readiness.ts / cost.ts / coverage.ts  ──▶ HUD (pill, $ meter, SVG mini-map)
          │ stop()
          ▼
   local store index.json (saved_on_phone) ──▶ capture/[id] step review (precheck.ts)
          │ Upload (precheck pass)
          ▼ step quote: GET /v1/quote?frames=N ──▶ {credits, usd, budgetRemaining, withinBudget}
          │ "Approve & process" tap (only path)
          ▼ POST /v1/scans (Idempotency-Key=sid, approved_max_credits) → world uploading
   Upload manager (root layout, AppState active, launch)
     reconcile: GET uploads:missing ─▶ POST /uploads (batch ≤200) ─▶ File.upload PUT ×N ─▶ R2 captures/<cid>/frames/
                when missing=[] ─▶ PUT frames.jsonl ─▶ PUT session.json ─▶ POST :complete
                                                                       │
   API :complete: list() + parse manifest + validateSession(+D-16 rules)
          ├─ fail ─▶ world failed / validate, charged=false (no ledger row) ─▶ app "Didn't pass checks"
          └─ pass ─▶ uploading→packing (conditional UPDATE) + enqueue pack (same tx)
                                                                       ▼
   Worker (unchanged): pack (re-validate) → submit (approved ≥ quote? reserve budget, mock) → track → import → ready
          ▼
   Library poll (5 s while non-terminal) shows ready. Local session deleted once server ≥ packing.
```

### Recommended Project Structure
```
virtumetry/
├── assets/fixtures/tiny-session/   # 30 JPEGs + README.md (licence) + frames.json (array, from frames.jsonl)
└── src/
    ├── app/capture/                # _layout.tsx (Stack, fullScreenModal), prep.tsx, scan.tsx, [id].tsx
    ├── capture/
    │   ├── types.ts                # CaptureSource, events, Session/FrameLine types (hand-copied from manifest.ts)
    │   ├── source.ts               # getCaptureSource()
    │   ├── fixture-source.ts       # FixtureCaptureSource (injected resolveFrame + clock + fs)
    │   ├── fixture-assets.ts       # 30 static require() calls + frames.json import
    │   ├── rules.ts                # shared constants mirrored from backend (pinned by test)
    │   ├── config.ts               # CaptureConfig type + bundled defaults + useCaptureConfig()
    │   ├── readiness.ts  cost.ts  coverage.ts  precheck.ts
    │   └── store.ts                # persisted local scan store (replaces library/local-scans.ts)
    ├── upload/
    │   ├── reconcile.ts            # pure reconciler (injected api + uploader)
    │   ├── uploader.ts             # thin expo-file-system adapter
    │   └── manager.ts              # singleton: launch + AppState, calls reconcile per scan
    └── components/coverage-map.tsx, readiness-pill.tsx, ...
backend/src/
├── capture-config.ts               # zod schema + defaults + parse(CAPTURE_CONFIG_JSON)
├── routes/scans.ts                 # POST /v1/scans, /uploads, uploads:missing, :complete, GET /v1/quote, GET /v1/capture/config
└── bundle/validate.ts              # + coverage/blur/tracking-share/forward-motion/intrinsics rules
```

### Pattern 1: Fastify routes with literal colons (VERIFIED by local probe, fastify 5.12.8)
- `'/v1/scans/:id/uploads::missing'` → literal `uploads:missing`, `params.id` correct. ✔
- `'/v1/scans/:id::complete'` → **broken**: param named `id::complete` captures `"abc:complete"`.
- `'/v1/scans/:id([0-9a-fA-F-]{36})::complete'` → `params.id` = the uuid. `…:completeX` and non-uuid ids → 404. Coexists with `GET /v1/scans/:id`. ✔
- Latent bug, moot once removed: the existing `'/v1/worlds/:id/uploads:refresh'` actually registers a param named `refresh` (matches `/uploadsXYZ`).

### Pattern 2: Server-reconciled upload (pure reconciler, D-22)
```ts
// src/upload/reconcile.ts — no expo imports; jest drives it with fakes
export async function reconcile(scan: LocalScan, api: ScansApi, up: Uploader, onProgress?: (p: Progress) => void) {
  const id = scan.serverWorldId ?? (await api.createScan(scan)).world.id;        // Idempotency-Key = sessionId
  const m = await api.missing(id);                                               // { missingFrames, manifestPresent, status }
  if (m.status !== 'uploading') return m;                                        // packing+/failed: done (replay-safe)
  if (m.missingFrames.length) {
    for (const batch of chunk(m.missingFrames, 200)) {
      const signed = await api.presign(id, batch.map((p) => ({ path: p, bytes: up.size(scan, p) })));
      // Hand ALL of the batch to the native session at once (it survives suspension); do not await one-by-one.
      const results = await Promise.allSettled(signed.map((s) => up.put(scan, s)));
      // 403 → URL expired: just return; next reconcile re-presigns. Other failures: same.
    }
    return api.missing(id);                                                      // re-check; manifest only when empty
  }
  for (const p of ['frames.jsonl', 'session.json']) {                            // manifest LAST, in order
    const [s] = await api.presign(id, [{ path: p, bytes: up.size(scan, p) }]);
    if ((await up.put(scan, s)) !== 200) return m;
  }
  return api.complete(id);
}
```

### Pattern 3: Validation rules shared by `:complete` and pack
Use one entry point: `validateStored(storage, captureId, { minFrames, maxFrames, rules })`. Extract `readManifest` from `pack.ts`, which already handles MANIFEST_MISSING, MANIFEST_TOO_LARGE and MANIFEST_INVALID. `:complete` calls it synchronously, and pack keeps calling it through `packCapture`. `rules` = `captureConfig.precheck` loaded from `config.CAPTURE_CONFIG_JSON` on both api and worker.

### Anti-Patterns to Avoid
- **In-JS concurrency limit of ~4 on background uploads.** When iOS suspends JS, the queued-but-unstarted tasks never start. That is exactly VirtSpace's lesson ("enqueue all at once", ARCHITECTURE §Background Uploads). Hand a whole presign batch (≤200) to the native session. iOS `URLSession` already caps connections per host. *This refines D-21's "~4 concurrency": cap concurrency at the batch, not at 4.*
- **Trusting `File.upload` to reject on HTTP errors.** Docs: "Non-2xx responses resolve rather than reject." Always check `result.status`.
- **Accepting arbitrary file paths in the presign body.** Allow only `^frames/\d{6}\.jpg$` with index ≤ `capture.frameCount`, plus `frames.jsonl` and `session.json`. Keys are generated server-side as `captureKey(cid, rel)`.
- **Computing `withinBudget` on the phone.** The UI-SPEC forbids it.
- **Upload logic inside a screen.** Use the app-scoped singleton (ARCHITECTURE Anti-Pattern 6).
- **Adding `listKeys`.** `list(prefix)` already exists on both drivers.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ListObjectsV2 pagination | new `listKeys` | `storage.list(prefix)` | Already paginates with ContinuationToken (s3.ts) and walks recursively (local.ts) |
| Idempotent create + quota | new create logic | move `findWorldByClientRequestId`, `replayCreate`, `isUniqueViolation`, `chargeScanQuota`/`releaseScanQuota` usage from `worlds.ts` into `scans.ts` | Concurrency-tested pattern (unique index + refund loser) |
| Manifest read/limits/parse | new parser | `readManifest` (export from pack.ts) + `SessionV1` + `parseFramesJsonl` | Same errors as the pack job |
| Budget window SQL | new spent query | extract the `SELECT ... FILTER (WHERE created_at >= date_trunc('day' ...))` from `reserveCredits` into `spentCredits(db, mode)` | UTC-window subtleties already solved there |
| Fail a world | new UPDATE | `failWorld(db, id, ['uploading'], 'validate', code, msg)` from pipeline.ts | Scrubs URLs, caps message |
| Background HTTP | fetch loops / XHR | `File.upload` / `createUploadTask` | Native background `URLSession` |
| In-memory FS for tests | custom FS mock | jest-expo's built-in `expo-file-system/mocks/FileSystem.ts` (auto-wired through `requireNativeModule('FileSystem')`) | Supports create/write/text/copy/delete/list |
| UUID | `uuid` package | `import { uuid } from 'expo'` → `uuid.v4()` | Already shipped |
| Settings deep link | URL schemes | `Linking.openSettings()` | RN core |

**Key insight:** this phase's risk is in contracts (routes, rules, thresholds, ordering), not algorithms. Reuse every Phase 1–3 primitive and keep new code to pure functions plus thin adapters.

## Fixture Geometry (computed from `backend/test/fixtures/tiny-session/frames.jsonl`)

| Measure | Value | Implication |
|---|---|---|
| Camera height (y) | 1.880–1.944 m | y-up confirmed. Use x/z for top-down (D-10 holds) |
| x range / z range | 0.106 m / 2.508 m | Non-degenerate but essentially a straight 2.5 m line. Auto-fit must keep aspect ratio with min span 1 m (UI-SPEC) |
| Path length / step | 2.54 m; steps 0.065–0.106 m | No `CAMERA_JUMP` (max 0.106 < 0.5) |
| Duration | 7.78 s, ~0.27 s per frame | At 1× replay the scan takes ~8 s. Use real `t` deltas (fast enough) |
| Pitch | forward·y = −0.78…−0.84 (looking ~52–57° down) | Horizontal forward magnitude ≥ 0.547, so yaw is well defined |
| Yaw sectors (12 × 30°) | **1** (bins centred on the first frame's yaw) or **2** (absolute bins; yaw straddles ±180°) | Coverage thresholds must be **1** in dev/test config |
| Forward vs motion (3D) | median 51.9° | Distorted by pitch. **Don't use 3D** |
| Forward vs motion (XZ) | median **4.7°** (max 14°) | Good fixture passes a 120° rule with huge margin |
| Reversed poses (walking backwards) | XZ median **175.3°** | Use as the in-test broken fixture for `FORWARD_MOTION_MISMATCH` |
| Pose-jump (+0.6 m x from frame 15) | exactly one `CAMERA_JUMP` (frame 15, 0.620 m). XZ median unchanged at 4.7° | Scenario fails only the intended rule |
| Intrinsics | cx/w 0.500, cy/h 0.516, fx/fy 0.993 | Passes ±25 % centre and a ±10 % aspect band |

### Recommended config values
`[ASSUMED]` production defaults. Tune after Phase 8 real scans.

```jsonc
// code defaults (production)
{
  "readiness": { "minFramesGreen": 150, "minFramesAmber": 80,
                 "minSectorsGreen": 9, "minSectorsAmber": 6,
                 "maxBlurShareGreen": 0.10, "maxBlurShareAmber": 0.20,
                 "maxTrackingGapShareGreen": 0.0, "maxTrackingGapShareAmber": 0.05 },
  "precheck":  { "minFrames": 50, "maxBlurShare": 0.25, "maxTrackingGapShare": 0.0, "minCoverageSectors": 4 }
}
```
Effective `precheck.minFrames = max(precheck.minFrames, limits.minFrames)` and `maxFrames = limits.maxFrames` (mock: 1 / 5000).

**Railway dev + test-harness `CAPTURE_CONFIG_JSON`** (single line in the env). It merges over the defaults:
```json
{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}
```
Outcomes with these values:
- `good` (30 frames, 1 sector, 0 gaps, no blurPx): green, precheck pass, backend pass → ready.
- `too-few` (stop after 8 frames): red "Keep going — 17 more frames", precheck FAIL (8 < 20), Upload disabled. Backend test (bypassing the device): `FRAME_COUNT_OUT_OF_RANGE`.
- `tracking-gap` (frames 10–17 `limited`, 27 %): red tracking reason, precheck FAIL. Backend: `TRACKING_GAP` (share 0.27 > 0.0).
- `pose-jump`: green, precheck pass. Backend at `:complete`: `CAMERA_JUMP` → failed/validate, Not charged.

**Tracking rule alignment (recommendation):** today the backend fails on *any* non-normal frame (`TRACKING_NOT_NORMAL`, per frame). Replace it with one share-based issue (`TRACKING_GAP`) using `rules.maxTrackingGapShare` (default 0.0, which keeps current strictness). Device and server then can't disagree when the threshold is tuned. Update `validate.test.ts:80` accordingly.

**Intrinsics rule (recommendation):** tighten the existing `INTRINSICS_PRINCIPAL_POINT` to the ±25 % centre band (same code, so `display-state` mapping and the existing test at `validate.test.ts:69-71` keep passing). Add `INTRINSICS_ASPECT` for `|fx/fy − 1| > 0.10`.

## Common Pitfalls

### Pitfall 1: `:id:complete` route captures the wrong param
**What goes wrong:** `'/v1/scans/:id::complete'` yields `params['id::complete'] = 'abc:complete'`. `findOwnedWorld` returns undefined, and every call is a 404.
**How to avoid:** `'/v1/scans/:id([0-9a-fA-F-]{36})::complete'`. Add a route test that hits `/v1/scans/<uuid>:complete` and asserts the handler saw the uuid.
**Warning signs:** 404 `world_not_found` on complete while `uploads:missing` works.

### Pitfall 2: Presigned PUTs expire before background tasks run
**What goes wrong:** S3 `presignUpload` uses `expiresIn: 900`. With a 200-file batch handed to a background session while the phone sleeps, later tasks hit 403.
**How to avoid:** add `ttlSeconds` to `StorageDriver.presignUpload(key, contentType, maxBytes, exactBytes?, ttlSeconds = 900)`. Scans presign passes 21600 (6 h). R2 allows up to 7 days [ASSUMED]. The reconciler treats 403 as "re-presign next pass".

### Pitfall 3: Mock outputs missing in the Railway image → world stuck at `importing`
**What goes wrong:** `mock.ts` reads `new URL('../../test/fixtures/mock-outputs/', import.meta.url)`, which resolves to `/app/test/fixtures/mock-outputs`. `.dockerignore` excludes `backend/test`. `provider.open()` → ENOENT, and `handleTrack` snoozes forever ("never gives up").
**How to avoid:** add `!backend/test/fixtures/mock-outputs` to `.dockerignore`, and `COPY --chown=node:node backend/test/fixtures/mock-outputs ./test/fixtures/mock-outputs` to the runtime stage (42 KB). Then redeploy Railway dev api + worker.
**Warning signs:** dev world sits at `Processing · Finishing up`. The worker log shows `track job ... error #N ... ENOENT`.

### Pitfall 4: New precheck rules break the existing pipeline tests and the pack job
**What goes wrong:** if pack's `validateSession` applies default `minFrames: 50` / `minCoverageSectors: 4`, the 30-frame, 1-sector fixture fails every `pipeline.pg` / `scenarios.pg` / `webhooks.pg` test and `fixture:e2e`.
**How to avoid:** `startPipeline()` in `test/helpers/pipeline.ts` passes the dev `CAPTURE_CONFIG_JSON` into `loadConfig`. `validate.test.ts` passes explicit rules. `scripts/fixture-e2e.ts` relies on `.env` / dev values. Make `rules` a required parameter of `validateSession` so TypeScript flags every call site.

### Pitfall 5: `File.upload` resolves on 403/500
**How to avoid:** the uploader adapter returns `status`. The reconciler treats only 2xx as done. Never mark anything uploaded locally. The next `uploads:missing` is the truth anyway.

### Pitfall 6: Expo Go background-session behaviour is unverified
**What goes wrong:** Expo Go owns the `URLSession` background identifier (`host.exp.Exponent.expo-file-system.network-task.background`). Lock-screen continuation may or may not work there. A force-quit from the app switcher always cancels tasks (iOS behaviour).
**How to avoid:** only the reconcile path must work in Expo Go (success criterion 5 is a force-quit check). Survival under suspension is deferred to Phase 8 per CONTEXT. Keep `sessionType` at its default `'background'`. If tasks misbehave in Expo Go, fall back to `sessionType: 'foreground'`. The reconciler is identical either way.

### Pitfall 7: Fixture assets in jest
**What goes wrong:** jest-expo's `assetFileTransformer` turns every `.jpg` `require()` into `1`, and the expo-asset native mock's `downloadAsync` returns undefined, so `localUri` is null.
**How to avoid:** `FixtureCaptureSource` takes an injected `resolveFrame(i) => Promise<string /*file uri*/>`. Production uses `Asset.loadAsync(FRAMES[i]).then(([a]) => a.localUri!)`. Tests write fake bytes into the in-memory FS and return those URIs. Pre-resolve all 30 in `start()` before the timer runs.

### Pitfall 8: `.jsonl` cannot be `require()`d by Metro
**How to avoid:** commit `assets/fixtures/tiny-session/frames.json` (a JSON array of the 30 lines). Add an app jest test that reads `../backend/test/fixtures/tiny-session/frames.jsonl` with `fs` and asserts deep-equality, so the two fixture copies cannot drift.

### Pitfall 9: wallMs / EXIF ordering
**What goes wrong:** the validator requires strictly increasing `wallMs`. Pack writes EXIF from it.
**How to avoid:** `wallMs = startNow + round((t_i − t_0) × 1000)` with the original `t` kept. Frame spacing is ≥ 0.25 s, so it stays strictly increasing even with speed-up (rebase from original `t`, not the sped-up timer).

### Pitfall 10: Local copy deleted too early, or never
**How to avoid:** the store deletes the session dir only when `:complete` / `missing` reports status ∈ {packing, submitting, processing, importing, ready}. On `failed/validate` keep it (UI-SPEC: "stays until discarded"). The Library hides a local row once the server list contains its `serverWorldId` AND the server status is past `uploading`.

### Pitfall 11: Mock provider state is in memory
**What goes wrong:** the mock's `byId` map lives in the worker process. A Railway worker redeploy mid-processing makes `status()` throw 404 NOT_FOUND, and track snoozes forever.
**How to avoid:** this is a dev-only limitation. Don't redeploy the worker during an owner test run. Document it in the UAT.

### Pitfall 12: Removing the old routes breaks six test files
Files touching the removed code:
- Delete: `test/frames-done.test.ts`, `test/worlds.uploads-refresh.test.ts`.
- Rewrite for `/v1/scans`: `test/worlds.idempotency.test.ts` and `test/quota.charge.test.ts` (3 × `POST /v1/worlds`).
- Repurpose: `test/upload-size.test.ts` imports `frameSizeMap` and expects `image/heic`. Repurpose it to scans presign size binding.
- Edit: `test/zod-contract.test.ts` imports `framesDoneBody`. Drop that part, keep `listQuery`.
- Leave unchanged: `test/rate-limit.test.ts` builds its own stub route, so it is unaffected (rename optional). `storage.local.test.ts` uses arbitrary `.heic` key strings, fine.
- `atomic-flip.test.ts` only uses DELETE routes (unaffected).

## Code Examples

### Uploader adapter (SDK 58 API from installed typings + native source)
```ts
// src/upload/uploader.ts
import { File } from 'expo-file-system';
export type Signed = { path: string; url: string; headers: Record<string, string> };
export async function put(fileUri: string, s: Signed, onProgress?: (sent: number, total: number) => void) {
  // BINARY_CONTENT is the default uploadType: body = raw file bytes. sessionType defaults to 'background' (iOS).
  const res = await new File(fileUri).upload(s.url, {
    httpMethod: 'PUT',
    headers: s.headers, // { 'content-type', 'content-length' } exactly as presigned
    onProgress: onProgress && ((p) => onProgress(p.bytesSent, p.totalBytes)),
  });
  return res.status; // non-2xx RESOLVES — caller must check
}
```
`createUploadTask(url, opts)` + `task.uploadAsync()` / `task.cancel()` / `task.addListener('progress', …)` is the same request with a cancel handle. Use it only if Discard during upload needs to cancel in-flight PUTs.

### Copy fixture frames into the session dir
```ts
import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
const dir = new Directory(Paths.document, 'sessions', sessionId);
new Directory(dir, 'frames').create({ intermediates: true, idempotent: true });
const [asset] = await Asset.loadAsync(FRAME_MODULES[k]);           // Metro-served in Expo Go → cached file
await new File(asset.localUri!).copy(new File(dir, 'frames', `${String(k + 1).padStart(6, '0')}.jpg`));
new File(dir, 'frames.jsonl').write(lines.join('\n') + '\n', { append: true }); // or rewrite whole file per keyframe
```
Check the `FileWriteOptions` fields in `node_modules/expo-file-system/build/File.types.d.ts` before relying on `append`. Rewriting the whole small file per keyframe is the safe fallback. Write `session.json` at `start()`.

### Native-or-fixture source
```ts
import { requireOptionalNativeModule } from 'expo';
export function getCaptureSource(): CaptureSource {
  const native = requireOptionalNativeModule('VmCapture'); // null in Expo Go and jest (no mock exists)
  return native ? wrapNative(native) : fixtureSource;       // wrapNative lands in Phase 8; keep a stub that throws
}
```

### Forward vs motion (backend + mirrored nowhere: server-only semantic rule)
```ts
/** D-16(c): median XZ angle between camera forward (−Z column) and travel, moving segments only. */
export const MAX_FORWARD_MOTION_DEG = 120;
export const MIN_SEGMENT_MOVE_M = 0.02;     // ignore jitter
export const MIN_HORIZONTAL_FORWARD = 0.3;  // ignore near-vertical looks (yaw undefined)
export const MIN_MOVING_SEGMENTS = 5;       // too few → rule not applicable
export function forwardMotionMedianDeg(frames: FrameLine[]): number | null {
  const a: number[] = [];
  for (let k = 1; k < frames.length; k++) {
    const p = frames[k - 1]!.T_arkit, T = frames[k]!.T_arkit;
    const mx = T[12]! - p[12]!, mz = T[14]! - p[14]!, mn = Math.hypot(mx, mz);
    const fx = -T[8]!, fz = -T[10]!, fn = Math.hypot(fx, fz);
    if (mn < MIN_SEGMENT_MOVE_M || fn < MIN_HORIZONTAL_FORWARD) continue;
    a.push((Math.acos(Math.max(-1, Math.min(1, (fx * mx + fz * mz) / (mn * fn)))) * 180) / Math.PI);
  }
  if (a.length < MIN_MOVING_SEGMENTS) return null;
  a.sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)]!;
}
// issue 'FORWARD_MOTION_MISMATCH' when median > MAX_FORWARD_MOTION_DEG
```
Coverage sectors must use the same yaw (`atan2(−T[8], −T[10])`, skip when horizontal forward < 0.3) in `coverage.ts` (app) and the backend rule. The pinning tests hold the constants equal.

### Capture config env (backend)
```ts
// config.ts baseSchema: CAPTURE_CONFIG_JSON: z.string().optional()
// capture-config.ts
const Partial = z.object({ readiness: ReadinessSchema.partial(), precheck: PrecheckSchema.partial() }).partial().strict();
export function captureConfig(cfg: Config) {
  const raw = cfg.CAPTURE_CONFIG_JSON ? Partial.parse(JSON.parse(cfg.CAPTURE_CONFIG_JSON)) : {};
  return { readiness: { ...DEFAULTS.readiness, ...raw.readiness }, precheck: { ...DEFAULTS.precheck, ...raw.precheck } };
}
// Call once in refine() so a bad value fails boot (message names the var, never the value).
```

### Scans route skeleton (registration)
```ts
// routes/index.ts authed scope: scansRoutes(authed, deps)  — deps gains `provider: ReconProvider`
// server.ts: registerRoutes(app, { config, storage, auth, provider: createProvider(config) })
app.post('/v1/scans', { config: { rateLimit: { max: config.RATE_LIMIT_CREATE_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS,
  keyGenerator: (r) => `create:${r.userId ?? r.ip}` } } }, createHandler);
app.post<{ Params: { id: string } }>('/v1/scans/:id/uploads', presignHandler);
app.get<{ Params: { id: string } }>('/v1/scans/:id/uploads::missing', missingHandler);
app.post<{ Params: { id: string } }>('/v1/scans/:id([0-9a-fA-F-]{36})::complete', completeHandler);
app.get('/v1/quote', quoteHandler);            // ?frames=N (zod coerce int 1..limits.maxFrames)
app.get('/v1/capture/config', configHandler);
```
`:complete` response: always 200 with `{ world: serializeWorld(w), issues?: [{code}] }`. If frames or the manifest are still missing, answer 409 `{ error: 'upload_incomplete', missingFrames, manifestPresent }` without failing the world. Check `frames.length === capture.frameCount` (`FRAME_COUNT_MISMATCH`). Do the uploading→packing flip + enqueue in one transaction, copied from the removed `frames:done`.

**D-19 approval timestamp:** scans are created only by the "Approve & process" tap, so `worlds.created_at` *is* the approval time. Recommend **no migration**: set `approvedMaxCredits` at insert and document that `created_at` = approval time. Add an `approved_at` column only if the owner wants it distinct.

**`POST /v1/scans` body:** recommend `approved_max_credits` validated as `int ≥ provider.quote(frame_count).credits`. A ceiling below the quote would just fail at submit. Reject it early with 400 `approval_below_quote`. Presign body: `{ files: [{ path, bytes }] }` (≤200). `bytes` from `new File(uri).size` on the phone, so Content-Length is signed (reuse the `exactBytes` path). Limits: `MAX_FRAME_BYTES` for jpg, `MANIFEST_MAX_BYTES` (8 MiB) for JSON.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `expo-file-system/legacy` `uploadAsync(url, fileUri, …)` | `new File(uri).upload(url, opts)` / `createUploadTask` with `sessionType` | SDK 54–58 class API | Use the class API. The legacy import still exists but logs warnings |
| `/v1/worlds` + `frame_N.heic` + `frames:done` with poses body | `/v1/scans` session-format (`frames/NNNNNN.jpg`, `frames.jsonl`, `session.json`, `:complete`) | This phase | Old routes and tests removed |
| Per-frame `TRACKING_NOT_NORMAL` | Share-based `TRACKING_GAP` with a tunable threshold (default 0) | This phase (recommended) | Device and server rules can't diverge |

**Deprecated/outdated:** `captures.poses_json` is no longer written. Leave the column (no migration).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Asset.loadAsync(module)` → `[Asset]` with `localUri` works in Expo Go SDK 58 | Code Examples | Fixture copy fails on device. Fallback: `File.downloadFileAsync(asset.uri, dest)` |
| A2 | `expo-keep-awake` `useKeepAwake()` API unchanged | Standard Stack | Trivial. UI-SPEC says skip if problematic |
| A3 | Production threshold defaults (150/80 frames, 9/6 sectors, shares) suit real rooms | Fixture Geometry | Readiness too strict/lax in Phase 8. Tunable via env, no build |
| A4 | R2 presigned URL max TTL ≥ 6 h (7 days) | Pitfall 2 | If lower, cap TTL accordingly |
| A5 | Background `URLSession` inside Expo Go behaves acceptably | Pitfall 6 | Only lock-screen survival is affected (deferred to Phase 8). Reconcile covers force-quit |
| A6 | `react-native-svg` renders in jest-expo without a manual mock | Validation | Add `jest.mock('react-native-svg', …)` stub. Logic tests are pure anyway |
| A7 | `crypto.randomUUID` is not reliably available on Hermes | Standard Stack | None: `uuid.v4()` from `expo` is used regardless |
| A8 | `FileWriteOptions` supports `append` | Code Examples | Rewrite the file per keyframe instead (tiny) |
| A9 | All five packages are legitimate (slopcheck unavailable) | Package Audit | Very low: they're in Expo's own `bundledNativeModules.json` |

## Open Questions

1. **Separate `approved_at` column?**
   - What we know: scans are created only at approval, so `created_at` equals approval time.
   - Recommendation: no migration. Confirm with the owner during plan-check only if they care.
2. **Tracking rule: keep per-frame strict or switch to share-based?**
   - Recommendation: share-based with default 0.0, which behaves identically to today unless tuned.
3. **Does lock-screen upload continue in Expo Go?**
   - Recommendation: note it in UAT as observational only. The pass criterion is the force-quit reconcile.
4. **Do we want `react-native-svg` in jest render tests at all?**
   - Recommendation: test `coverage.ts` purely, plus one RNTL smoke render of the scan screen with svg mocked if it fails to render.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node (local) | app jest, backend vitest | ✓ | v22.21.1 (backend `engines` says ≥24; CI uses 24) | Tests ran on 22 in prior phases. CI is the 24 gate |
| npm | installs | ✓ | 10.9.4 | — |
| Metro dev server | owner Expo Go run | ✓ (already on :8081, do not restart) | — | — |
| `backend/.env` (Neon dev direct URL for `test:pg`) | pg integration + e2e tests | ✓ present (not read) | — | CI secret `TEST_DATABASE_URL` |
| `virtumetry/.env.development` | Expo Go → Railway dev API | ✓ present | — | — |
| Railway dev api + worker (mock, s3 → virtumetry-dev) | manual success criteria 4/5 | assumed ✓ (Phase 3 UAT passed) | — | — |
| slopcheck | package audit | ✗ | — | Packages tagged [ASSUMED] |
| iPhone 17 Pro + Expo Go | manual walkthrough | ✓ (owner) | — | — |

**Railway dev env vars to set (owner/orchestrator, not changed here). Set on BOTH api and worker unless noted:**
- `CAPTURE_CONFIG_JSON` = `{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}`
- `DAILY_CREDIT_BUDGET=10000`, `MONTHLY_CREDIT_BUDGET=100000` (the worker enforces them. The api reads them for `/v1/quote`)
- `DAILY_SCAN_QUOTA=30` (api)
- Optional, worker: `TRACK_POLL_SECONDS=10` (default 60) and `MOCK_PROCESSING_SECONDS=20` (default 5), so the owner sees each state but reaches ready in about a minute.
- Production: untouched.
- Also required: redeploy dev with the Dockerfile/.dockerignore mock-outputs fix (Pitfall 3).

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| App framework | jest 30 (`jest-expo` ~58.0.15) + `@testing-library/react-native` 14.1; config in `virtumetry/package.json` `"jest"` (setup `jest.setup.ts`, testTimeout 20 s) |
| Backend framework | vitest ^2.1; `backend/vitest.config.ts` (testTimeout 30 s; include `test/**/*.test.ts`) |
| App quick run | `cd virtumetry && npx jest --ci src/__tests__/<file>` |
| App full suite (CI) | `cd virtumetry && npx expo lint && npx tsc --noEmit && npx jest --ci` |
| Backend quick run | `cd backend && npx vitest run test/<file>` |
| Backend pg/e2e (local) | `cd backend && npm run test:pg -- test/integration/<file>` (sets `TEST_DATABASE_URL` from `.env` via dev guard; never prints it) |
| Backend full suite (CI) | `cd backend && npx tsc --noEmit && npx vitest run` (pg suites run when the `TEST_DATABASE_URL` secret is set) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAP-01 | Prep first-run full vs compact, permission granted/denied, Open Settings | RNTL | `npx jest --ci src/__tests__/capture-prep.test.tsx` | ❌ Wave 0 |
| CAP-05 | Readiness worst-of + single reason, priority gap→blur→frames→coverage; config merge | unit | `npx jest --ci src/__tests__/capture-readiness.test.ts` | ❌ |
| CAP-05 | `CAPTURE_CONFIG_JSON` parse/merge/strict-reject; `GET /v1/capture/config` shape | unit (vitest) | `npx vitest run test/capture-config.test.ts` | ❌ |
| CAP-06 | `cost(30)` → 930 credits, "$9.30"; base "$9.00" at 0 frames | unit | `npx jest --ci src/__tests__/capture-cost.test.ts` | ❌ |
| CAP-07 | Fixture path non-degenerate on x/z (span ≥ 2 m), sector count = 1, auto-fit keeps aspect with min 1 m span | unit | `npx jest --ci src/__tests__/capture-coverage.test.ts` | ❌ |
| CAP-09 | Store persists index.json, survives "restart" (new module instance), discard deletes dir + entry; review screen shows count/duration/cost/readiness, Upload disabled on precheck fail | unit + RNTL | `npx jest --ci src/__tests__/capture-store.test.ts src/__tests__/capture-review.test.tsx` | ❌ |
| CAP-10 | FixtureCaptureSource emits keyframe events in order with raw fields, writes schema-1 dir (session.json, frames.jsonl, frames/000001.jpg…), each scenario shapes events; frames.json == backend frames.jsonl | unit (fake timers, in-memory FS) | `npx jest --ci src/__tests__/capture-fixture-source.test.ts` | ❌ |
| PROC-01 (device) | precheck pass/fail per rule; rule constants pinned | unit | `npx jest --ci src/__tests__/capture-precheck.test.ts` | ❌ |
| PROC-01 (server) | `FORWARD_MOTION_MISMATCH` (reversed poses), `CAMERA_JUMP` (pose-jump), `TRACKING_GAP`, `INTRINSICS_PRINCIPAL_POINT` (±25 %), `INTRINSICS_ASPECT`, coverage/blur shares; good fixture → `[]`; constants pinned | unit (vitest) | `npx vitest run test/bundle/validate.test.ts` | ✅ extend |
| PROC-01 (server) | `:complete` with broken fixtures → failed/validate, `charged=false`, **0 credit_events rows**, 0 submits | pg integration | `npm run test:pg -- test/integration/scans.pg.test.ts` | ❌ |
| PROC-02 | Quote route `{credits:930, usd:9.3, budgetRemaining, withinBudget}`; over budget → false; app quote step: Approve disabled until withinBudget, create only on tap with `approved_max_credits` | vitest + RNTL | `npx vitest run test/scans.quote.test.ts`; `npx jest --ci src/__tests__/capture-quote.test.tsx` | ❌ |
| PROC-02/SC4 | e2e: create → presign → PUT fixture → missing=[] → complete → drain → `ready`, approved_max set, ledger has one mock reserve | pg e2e | `npm run test:pg -- test/integration/scans-e2e.pg.test.ts` | ❌ |
| PROC-03 | Scans routes: idempotent create (same world, quota once), ownership 404, presign path allowlist + batch ≤200 + TTL arg, missing lists only absent frames + manifestPresent, complete replay returns current state, `<uuid>:complete` routes correctly | pg integration | `npm run test:pg -- test/integration/scans.pg.test.ts` | ❌ |
| PROC-03 | Reconciler: force-quit after 15/30 frames → second run presigns only the 15 missing; manifest PUTs after all frames, frames.jsonl before session.json; `:complete` exactly once; 403 → re-presign next pass; non-2xx never counted | unit | `npx jest --ci src/__tests__/upload-reconcile.test.ts` | ❌ |

### Sampling Rate
- **Per task commit:** the quick-run command for the touched file(s).
- **Per wave merge:** app `npx jest --ci` + backend `npx vitest run` (+ `npm run test:pg` for backend waves).
- **Phase gate:** both CI pipelines green (`.github/workflows/app.yml`, `backend.yml`), then the manual Expo Go walkthrough on Railway dev: prep → scan good → review → quote → approve → ready; `too-few` blocked on device; `pose-jump` blocked by server with "Not charged"; force-quit mid-upload → relaunch → completes.

### Wave 0 Gaps
- [ ] `virtumetry/src/__tests__/capture-*.test.ts(x)`, `upload-reconcile.test.ts`: new files listed above
- [ ] `backend/test/capture-config.test.ts`, `test/scans.quote.test.ts`, `test/integration/scans.pg.test.ts`, `test/integration/scans-e2e.pg.test.ts`
- [ ] `test/helpers/pipeline.ts`: pass dev `CAPTURE_CONFIG_JSON` into `loadConfig`. Add a helper to build a scans-route app on the harness storage/db (onRequest hook sets `req.userId`, `vi.mock('../../src/db/client.js')` → harness db) and to seed a user
- [ ] Migrate/delete the six old-route test files (Pitfall 12)
- [ ] No framework installs needed

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (inherited) | Better Auth session cookie via `apiFetch`. All new routes go in the authed scope |
| V3 Session Management | inherited | unchanged |
| V4 Access Control | yes | `findOwnedWorld` (404 for foreign / non-uuid ids) on every `:id` route. Presign keys built server-side from `capture.r2FramesPrefix` |
| V5 Input Validation | yes | zod for bodies/query (`frames` int range, `files` ≤200 with a path allowlist regex, `approved_max_credits` int ≥ quote), `z.guid()` Idempotency-Key, `CAPTURE_CONFIG_JSON` strict schema |
| V6 Cryptography | yes (minimal) | SigV4 presign via the AWS SDK (never hand-rolled). Content-Length signed when declared |
| V11 Business logic / money | yes | Validation before any reservation; approval ceiling persisted at create; quota charged once; budget re-checked atomically at submit |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal / arbitrary key via presign `files` | Tampering | Allowlist regex + index ≤ frameCount. Local driver `safeJoin` already guards |
| Uploading huge objects | DoS / cost | Exact Content-Length signed from declared `bytes` ≤ `MAX_FRAME_BYTES` / `MANIFEST_MAX_BYTES`. Pack's pre-read size checks remain |
| Replay / double create | Tampering / cost | Idempotency-Key + unique index + quota refund for the loser |
| Bypassing the device precheck | Elevation | Server re-runs every rule at `:complete` and again at pack |
| Approving less than the quote, or skipping approval | Tampering | `approved_max_credits` required at create; submit refuses `NOT_APPROVED`/`QUOTE_ABOVE_APPROVAL` |
| Leaking presigned URLs in logs | Info disclosure | Existing policy: log ids/keys only. `failWorld` scrubs URLs |
| Raw `failure_message` shown to user | Info disclosure | App maps `failure_code` only (Phase 3 T-03-28 rule kept) |

## Sources

### Primary (HIGH confidence)
- Repo code read in this session: `backend/src/routes/worlds.ts`, `storage/{index,local,s3}.ts`, `bundle/{manifest,validate,convert,pack}.ts`, `pipeline.ts`, `budget.ts`, `provider/{types,mock,index}.ts`, `config.ts`, `db/schema.ts`, `routes/index.ts`, `server.ts`, `test/helpers/{pipeline,auth-app}.ts`, test files listed in Pitfall 12, `Dockerfile`, `.dockerignore`, `.github/workflows/{app,backend}.yml`; `virtumetry/package.json`, `jest.setup.ts`, `src/lib/api.ts`, `src/library/*`, `src/app/_layout.tsx`, `src/app/(tabs)/index.tsx`
- Local probes: Fastify 5.12.8 / find-my-way 9.10.0 colon-route behaviour; fixture geometry script (path, yaw sectors, forward-vs-motion, pose-jump, reversed)
- `node_modules/expo-file-system@58.0.14` typings (`NetworkTasks.types.d.ts`, `internal/NativeFileSystem.types.d.ts`) and iOS source (`ios/FileSystemUploadTask.swift`, background session config)
- `node_modules/jest-expo/src/preset/setup.js`, `node_modules/expo-file-system/mocks/FileSystem.ts` (in-memory FS mock)
- `node_modules/expo/bundledNativeModules.json`, `node_modules/expo/build/Expo.d.ts`
- https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/ — upload options, non-2xx resolves, background/termination note
- https://docs.expo.dev/versions/v58.0.0/sdk/camera/ — `useCameraPermissions`, Expo Go inclusion, plugin `cameraPermission`
- https://docs.expo.dev/versions/v58.0.0/sdk/svg/ — Expo Go inclusion, install command

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` §Background Uploads, §Contracts, §Patterns (project research, consistent with the docs)
- npm registry (`npm view`) versions and absence of postinstall scripts

### Tertiary (LOW confidence)
- Expo Go background-session behaviour (A5), R2 max presign TTL (A4)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Versions come from the installed node_modules and Expo's bundled map. Only the package audit is [ASSUMED], because slopcheck was unavailable.
- Architecture: HIGH. Built on verified existing code. Route escaping was verified by probe.
- Pitfalls: HIGH for 1–5 and 7–12, which come from code and probes. MEDIUM for 6 (Expo Go runtime).
- Threshold defaults: LOW for production values (A3), HIGH for the dev values, which come from the computed fixture geometry.

**Research date:** 2026-11-24
**Valid until:** 2026-12-24 (stable SDK 58. Re-check if the Expo SDK or fastify bumps)
