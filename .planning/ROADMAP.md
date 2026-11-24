# Roadmap: Virtumetry

## Overview

v1 proves the scan-to-3D-room loop for one owner on one iPhone. The roadmap builds the whole loop at $0 first. It starts with an isolated backend fork, then the on-disk session format, the bundle pipeline and a mock provider. Next come the owner app shell, a fixture-driven capture-upload-process loop in Expo Go, and the shared viewer and share page. After that, a single deliberate minimum-frame run switches on the live Echo-3 provider. Only then does the owner buy the Apple Developer membership, get Swift compile-checked on macOS CI, and spend a small batch of EAS builds on native ARKit capture and Sign in with Apple. Privacy and retention hardening close the milestone. Phases 1-6 run entirely in Expo Go, on web and in backend tests: no Apple Developer membership and no EAS builds.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Isolated Backend Fork** - VirtSpace backend copied into `backend/`, stripped, on its own Neon/Railway/R2, with CI and paid-provider guards (completed 2026-11-23)
- [x] **Phase 2: Bundle Pipeline & Mock Provider** - A recorded session becomes a valid Echo-3 bundle on R2 and runs through the mock provider to a ready world, at $0 (completed 2026-11-23)
- [x] **Phase 3: Owner Account & Scan Library** - Owner logs in on Expo Go and sees their own scan library with every state (owner phone UAT pending: 03-HUMAN-UAT.md) (completed 2026-11-24)
- [ ] **Phase 4: $0 Capture-to-World Loop** - A fixture scan is captured, checked, quoted, approved, uploaded and processed by the mock provider, all in Expo Go
- [ ] **Phase 5: Viewer, Floor Plan, Measure & Share** - Owner walks, measures and teleports in a ready world in the app and shares it through a public browser link
- [ ] **Phase 6: Live Echo-3 Provider** - One approved scan is processed by real Echo-3 exactly once, within budget, with safe retry
- [ ] **Phase 7: Native Build Readiness** - Apple membership bought, Swift compile-checked on macOS CI, first EAS dev build on the iPhone with push and crash reporting
- [ ] **Phase 8: Native ARKit Capture & Sign in with Apple** - Owner consents, then scans a real room with the iPhone and it comes back as a walkable world
- [ ] **Phase 9: Privacy & Retention Hardening** - Enforced retention and purge, plus the on-device upload-survival matrix

## Phase Details

### Phase 1: Isolated Backend Fork

**Goal**: A working Virtumetry backend runs from `backend/` on infrastructure fully separate from VirtSpace. It cannot spend money or accept dev auth by accident.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, FND-04, FND-05
**Success Criteria** (what must be TRUE):

  1. The forked backend (stitcher, World Labs and depth pipeline removed) passes its full test suite on every push in GitHub Actions, alongside app lint and typecheck *(CI job: backend vitest + app `expo lint` + `tsc --noEmit`)*
  2. The deployed dev backend on the new Railway project answers a health check backed by the new Neon database and the dev R2 bucket. No env or config value points to any VirtSpace host *(automated config test that rejects known VirtSpace hosts + manual health-check curl)*
  3. The server refuses to boot the Echo-3 provider without `ALLOW_PAID_PROVIDER=1`, and refuses to boot in production when `DEV_AUTH_TOKEN` is set *(automated boot-guard tests)*
  4. A deploy runs pending migrations automatically over the direct (non-pooler) Neon host *(automated test asserting the migration URL is non-pooler + Railway deploy log check)*

**Plans:** 7/7 plans complete

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Verbatim VirtSpace copy + strip stitcher/World Labs from worker and provider (wave 1)
- [x] 01-02-PLAN.md — Provision Neon project/branches, R2 buckets, backend secrets layout, CI DB secret (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-03-PLAN.md — Strip World Labs routes, depth, schema columns/statuses/job kinds (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-04-PLAN.md — Virtumetry rename, fresh 0000_init migration, [BLOCKING] apply to Neon dev (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-05-PLAN.md — Fail-closed boot guards + /readyz + local walking-skeleton write path (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-06-PLAN.md — Node-only image, Railway project virtumetry, first deploy with migrations on preDeploy (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 01-07-PLAN.md — backend.yml + app.yml, push to origin main, both workflows green (wave 6)

### Phase 2: Bundle Pipeline & Mock Provider

**Goal**: The on-disk session format is fixed. A recorded session can be turned by the backend into a valid Echo-3 capture bundle and run end to end through the mock provider to a ready world with re-hosted outputs, without spending a credit.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: PROC-04, PROC-06, PROC-07, PROC-08, PROC-10
**Success Criteria** (what must be TRUE):

  1. A committed fixture session (raw ARKit poses + intrinsics + JPEGs, converted from a public posed dataset) is packed by the backend into a store-only ZIP on R2. It has OpenCV `camera_from_world` poses, intrinsics JSON and monotonic EXIF timestamps, and its presigned URL serves HTTP Range (206) for ≥24 h *(automated tests: `arkitToOpenCV` unit tests, ZIP structure/EXIF validator, Range preflight against the dev R2 bucket)*
  2. A packed bundle runs pack → submit → track → ready against the mock provider. All outputs (splat, `mesh-simplified`, floor plan + affine, `cameras.json`) are copied into our own R2 before the world is marked ready *(automated integration test)*
  3. Mock-signed webhooks are HMAC-verified and deduplicated on `delivery_id`, and only nudge the tracker. With webhooks dropped, polling still reaches the terminal state *(automated tests incl. duplicate and invalid-signature webhooks)*
  4. Scripted mock failures (FAILED, 402, 409, 429, 503, duplicate webhooks) each end in the documented state with no extra submit *(automated scenario tests)*
  5. Two concurrent scans that would together exceed the daily or monthly credit cap result in exactly one reservation. The over-budget scan is refused before any provider call *(automated concurrency test on the atomic conditional reservation)*

**Plans:** 7/7 plans complete

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Session format (zod schema 1), arkitToOpenCV, EXIF writer, D-06 validator, ZIP reader, TUM-derived fixture + mock outputs
- [x] 02-02-PLAN.md — D-15 schema + migrations 0001/0002 applied to Neon dev, config vars, snoozeJob, guarded pg test runner

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-03-PLAN.md — Streaming storage, packCapture to store-only bundle ZIP, local Range, R2 Range proof on virtumetry-dev, prefix purge
- [x] 02-04-PLAN.md — Atomic daily+monthly credit reservation (concurrency-tested) + ReconProvider contract and scripted mock

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-05-PLAN.md — pack → submit → track → import → ready worker pipeline with re-hosted outputs (end-to-end test)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-06-PLAN.md — HMAC-verified, deduplicated, nudge-only webhook route + polling fallback tests
- [x] 02-07-PLAN.md — Scenario matrix (FAILED/402/409/429/503), concurrent budget refusal, fixture:e2e on dev, README

### Phase 3: Owner Account & Scan Library

**Goal**: The owner logs into their own account in Expo Go and sees a library of their scans with honest states, and can rename and delete them.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-05, LIB-01, LIB-03
**Success Criteria** (what must be TRUE):

  1. The owner logs in with email and password in Expo Go. Sign-up is unavailable, and a non-allowlisted email is rejected *(automated backend auth tests + manual Expo Go check)*
  2. The owner stays logged in after force-quitting and reopening the app, and can log out from Settings *(jest-expo test for SecureStore session + manual Expo Go check)*
  3. The library lists only the logged-in account's scans. Each shows its state (saved on phone, uploading with progress, processing with estimate, ready, failed), and another account's scans can never be read through the API *(automated API ownership tests + RNTL library-state tests with seeded scans)*
  4. The owner can rename a scan, and deleting it removes it from the database and R2 and sends a deletion request to the provider (mock) *(automated deletion-cascade test + manual Expo Go check)*
  5. Each app build profile points only to its own API URL, and the dev profile refuses a production URL *(automated config test)*

**Plans:** 9/9 plans complete

Plans:
**Wave 1**
- [x] 03-01-PLAN.md — Package legitimacy gate for all Phase 3 installs (owner checkpoint)
**Wave 2**
- [x] 03-02-PLAN.md — Backend sign-in slice: Better Auth + migration 0003 + session mode + auth guards
- [x] 03-05-PLAN.md — App sign-in slice: jest infra, resolveApiUrl, auth client, session gate, sign-in, Settings log out
**Wave 3**
- [x] 03-03-PLAN.md — Library API: list fields, PATCH rename, two-account 404s, owner:create script
**Wave 4**
- [x] 03-04-PLAN.md — Delete cascade (provider deleteWorld + hard delete) and seed:library
- [x] 03-06-PLAN.md — App library list: display-state mapper, conditional polling, all data states
**Wave 5**
- [x] 03-07-PLAN.md — App rename modal + optimistic delete with rollback
- [x] 03-08-PLAN.md — Railway dev environment + production session-auth redeploy
**Wave 6**
- [x] 03-09-PLAN.md — Build profiles, .env.development, SC5 test, owner phone checklist (checkpoint)
**UI hint**: yes

### Phase 4: $0 Capture-to-World Loop

**Goal**: In Expo Go, the owner can run the full capture loop with a fixture capture source at zero cost: prep, scan, review, check, quote, approve, upload, process (mock), ready. The same interface will later be fed by the native module.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: CAP-01, CAP-05, CAP-06, CAP-07, CAP-09, CAP-10, PROC-01, PROC-02, PROC-03
**Success Criteria** (what must be TRUE):

  1. Before the first scan the owner sees the prep checklist and camera-permission priming. A fixture capture then replays a recorded scan through the capture interface, showing a live readiness meter (green/amber/red with remotely tunable thresholds), a live cost meter (900 + frames credits in $) and a top-down coverage mini-map *(jest-expo/RNTL tests for readiness, cost and coverage logic + manual Expo Go walkthrough)*
  2. A finished scan is saved on the phone first. The owner reviews frame count, duration, cost and readiness, then chooses upload or discard *(RNTL test + manual Expo Go check)*
  3. A scan that fails a check (too few frames, blur, coverage or tracking gaps on device; pose continuity, forward vector vs motion or intrinsics vs image size on the backend) is blocked before any credit is spent, with the reason shown *(automated tests on shared rules + backend semantic validator using deliberately broken fixtures)*
  4. Processing starts only after the owner explicitly approves the displayed quote. The approved scan then reaches "ready" in the library via the mock provider *(automated end-to-end test against the mock backend + manual Expo Go run)*
  5. After a force-quit mid-upload, the next launch asks the server which frames are missing, re-sends only those, and uploads the manifest last *(automated upload-manager reconciliation tests + manual Expo Go force-quit check)*

**Plans:** 5/9 plans executed

Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Server checks before credit: CAPTURE_CONFIG_JSON tuning + rules-driven validator (tracking/blur/coverage shares, pose jump, forward-vs-motion, intrinsics) + shared validateStored

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-02-PLAN.md — Session-format upload routes to ready: POST /v1/scans (approval ceiling), presign batch (6 h TTL), uploads:missing, :complete with checks, e2e to ready
- [x] 04-04-PLAN.md — App capture logic: CaptureSource types, readiness, cost, coverage, precheck, rules pinned to backend

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-03-PLAN.md — GET /v1/quote + GET /v1/capture/config, retire old .heic upload routes and migrate tests
- [x] 04-05-PLAN.md — Fixture capture source (bundled TUM session, scenarios) + persisted saved-on-phone store in the Library

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 04-06-PLAN.md — New scan entry, prep + camera priming, scan screen with live readiness/cost/coverage HUD

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 04-07-PLAN.md — Upload engine: scan API calls, server-reconciled uploader (force-quit resume, manifest last), app-scoped manager

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 04-08-PLAN.md — Review / quote / upload screen with explicit approval, Library local states and validate-stage mapping

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 04-09-PLAN.md — Dockerfile ships mock outputs, guarded budget:reset-dev, Railway dev env values, owner Expo Go UAT checklist, full gate
**UI hint**: yes

### Phase 5: Viewer, Floor Plan, Measure & Share

**Goal**: The owner can open a ready world in the app, orbit it smoothly, walk it with collision, use the floor plan and measure. They can share it through a public link that opens the same viewer in any browser.
**Mode:** mvp
**Depends on**: Phase 3 (can run in parallel with Phase 4, using mock-ready fixture worlds)
**Requirements**: VIEW-01, VIEW-02, VIEW-03, VIEW-04, VIEW-05, VIEW-06, SHARE-01, SHARE-02, SHARE-03, SHARE-04, SHARE-05
**Success Criteria** (what must be TRUE):

  1. A ready fixture world opens from a sensible start viewpoint with honest loading progress, orbits smoothly on iPhone 17 Pro in Expo Go under the LoD splat budget, and the view can be reset *(manual on-device fps/first-open check in Expo Go + automated tests for the shared coordinate-transform util)*
  2. In walk mode the owner moves first-person and cannot pass through walls of the collider mesh. On the floor plan they see "you are here" and can tap to teleport. Measuring two tapped points shows a distance labelled approximate *(automated raycast/collision and pixel→world affine tests + manual Expo Go check)*
  3. If the WebView or WebGL context is killed, the viewer recovers by itself without leaving the screen *(manual forced-crash check + automated recovery-handler test)*
  4. A share link with an unguessable slug opens the world in desktop and mobile browsers. Revoking it makes it stop working immediately. An optional password gates it, and the owner sees its open count *(automated API tests for slug, revoke, password and counter + manual browser check)*
  5. Pasting a link into a messaging app shows a thumbnail and title preview, and the page is `noindex` *(automated test for OG/robots tags + manual paste check)*

**Plans**: TBD
**UI hint**: yes

### Phase 6: Live Echo-3 Provider

**Goal**: With the full mock loop proven, the backend can process an approved scan on real Echo-3 exactly once, inside the budget. The owner can retry a retryable failure only after re-confirming the cost.
**Mode:** mvp
**Depends on**: Phase 4, Phase 5
**Requirements**: PROC-05, LIB-02, OPS-06
**Success Criteria** (what must be TRUE):

  1. The submission key and exact request body are persisted before the Echo-3 call. A crash mid-submit or two concurrent submits never produce a second paid world *(automated kill-mid-submit and concurrent-submit tests against the mock and the live client contract)*
  2. The first paid run is a minimum-frame converted-dataset bundle submitted with `ALLOW_PAID_PROVIDER=1`. It completes, its outputs are re-hosted, the world opens in the viewer, and its outputs are recorded as new mock fixtures *(manual one-off live run + automated fixture replay test)*
  3. A failed scan shows a retry button only when the failure is retryable, and retrying needs a fresh explicit cost approval *(RNTL + backend tests + manual Expo Go check)*
  4. The owner is alerted when spend crosses the configured share of the daily or monthly budget *(automated threshold test + manual check of the alert during the live run)*

**Plans**: TBD
**UI hint**: yes

### Phase 7: Native Build Readiness

**Goal**: Native work can start without wasting builds. The owner buys the Apple Developer membership at the start. A stub `virtumetry-capture` module compiles green on macOS CI, and the first EAS dev build runs on the iPhone with push notifications and crash reporting.
**Mode:** mvp
**Depends on**: Phase 4 (app loop to build into the dev client); can overlap with Phase 6
**Requirements**: OPS-01, OPS-02, OPS-05, PROC-09
**Success Criteria** (what must be TRUE):

  1. A GitHub Actions macOS job runs `expo prebuild -p ios` and an unsigned `xcodebuild` on every push, and it is green with the stub module before the first EAS build is queued *(CI job)*
  2. The first EAS development build installs on the registered iPhone 17 Pro, and a JS-only change reaches it by EAS Update under the fingerprint runtime policy without a new build *(manual on-device check + EAS build/update logs)*
  3. A test crash in the app and a test error in the backend both appear in the error-reporting dashboard *(manual triggered-error check)*
  4. The owner gets a push notification on the iPhone when a (mock) world becomes ready or fails *(automated backend push-dispatch test + manual on-device check)*

**Plans**: TBD

### Phase 8: Native ARKit Capture & Sign in with Apple

**Goal**: The owner scans a real room by walking it with the iPhone. The native module keeps only Echo-3-ready keyframes and coaches them live, and the scan comes back as a walkable world. Sign in with Apple works in the dev build.
**Mode:** mvp
**Depends on**: Phase 6, Phase 7
**Requirements**: CAP-02, CAP-03, CAP-04, CAP-08, AUTH-04, OPS-04
**Success Criteria** (what must be TRUE):

  1. Before the first real upload the owner sees a versioned consent screen naming SpAItial as processor; uploads are blocked until the current version is accepted, and the dev build ships a privacy manifest declaring every required-reason API the app and capture module use *(RNTL test + automated check of the prebuilt manifest in the macOS CI job + manual on-device check)*
  2. Walking a room with the native capture writes only keyframes that meet the gate (≥0.12 s and ≥7 cm or 10° apart, predicted blur ≤64 px, 1920x1440, no resize or rotation) in the same session format the fixture source uses, and the backend validator accepts them *(automated backend validation of the captured session + manual on-device scan; macOS CI compile green before each EAS build, ≤5 iOS builds this phase)*
  3. During a scan the owner sees one coaching prompt at a time. When tracking is lost, capture pauses, says how to recover, and resumes only after a short normal-tracking warm-up *(manual on-device check + jest-expo tests for prompt prioritisation)*
  4. Capture enforces Echo-3 min/max frame limits and warns about heat or low storage before and during the scan *(automated limit tests + manual on-device check)*
  5. A first real 3-minute room scan goes capture → review → approve → upload → live Echo-3 → ready, and the owner can walk it in the app *(manual on-device end-to-end check)*
  6. The owner can sign in with Apple in the dev build and lands in the same account *(manual on-device check + automated backend idToken test)*

**Plans**: TBD
**UI hint**: yes

### Phase 9: Privacy & Retention Hardening

**Goal**: Scans of private homes are handled responsibly: raw data is actually purged on schedule, and upload survival is proven on the real device. (Consent and the privacy manifest land earlier, in Phase 8, before the first real home scan.)
**Mode:** mvp
**Depends on**: Phase 8
**Requirements**: OPS-03
**Success Criteria** (what must be TRUE):

  1. Raw frames and bundles past the written retention window are removed by R2 lifecycle rules and the purge job, never before the world reaches a terminal state *(automated purge-job tests + manual R2 lifecycle-rule check)*
  2. On the iPhone, an upload survives screen lock, app suspension and iOS termination, and resumes after force-quit by re-sending only missing frames *(manual on-device survival matrix, regression check for PROC-03)*

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 (Phase 5 may overlap Phase 4; Phase 7 may overlap Phase 6)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Isolated Backend Fork | 7/7 | Complete    | 2026-11-23 |
| 2. Bundle Pipeline & Mock Provider | 7/7 | Complete    | 2026-11-23 |
| 3. Owner Account & Scan Library | 9/9 | Complete    | 2026-11-24 |
| 4. $0 Capture-to-World Loop | 5/9 | In Progress|  |
| 5. Viewer, Floor Plan, Measure & Share | 0/TBD | Not started | - |
| 6. Live Echo-3 Provider | 0/TBD | Not started | - |
| 7. Native Build Readiness | 0/TBD | Not started | - |
| 8. Native ARKit Capture & Sign in with Apple | 0/TBD | Not started | - |
| 9. Privacy & Retention Hardening | 0/TBD | Not started | - |
