# Project Research Summary

**Project:** Virtumetry
**Domain:** iPhone walk-through room capture (ARKit) → cloud Gaussian-splat reconstruction (SpAItial Echo-3) → walkable 3D room in-app and on a public web link; later a real-estate listing marketplace
**Researched:** 2026-11-23
**Confidence:** MEDIUM-HIGH

## Executive Summary

Virtumetry is a capture-and-reconstruct pipeline with a viewer on the end, not a rendering product. Echo-3 provides reconstruction, metric scale, a collider mesh and a floor plan; what we build is a thin native ARKit capture module, a backend that packs and submits bundles safely, and one web-tech viewer that runs both in the app and in the browser. Competitors converge on rendering; the v1 edge is **capture reliability + cost protection** (readiness meter, live cost meter, quote, server budget guard) and **floor plan + measure + walk in one viewer**.

Governing rule: **keep Swift dumb; policy in TypeScript, on the backend where possible.** The owner is on Windows with 15 iOS builds/month and no Mac. Swift owns only the ARSession, keyframe gate, predicted-blur rejection, JPEG encode and an on-disk manifest of raw ARKit values. The backend does ARKit→OpenCV pose conversion, EXIF insertion, validation and ZIP packing. Everything before the native phase runs in Expo Go against a fixture capture source and a mock provider at $0. The backend is a VirtSpace fork, copied verbatim first and changed later.

Main risks are money and trust. A structurally valid but semantically wrong bundle (pose convention, intrinsics, rotated pixels) is billed (~$15–19) and returns garbage; a blind retry or re-presigned URL can double-charge. Prevention: persist `submission_key` + exact `submit_body` before the first POST; provider Idempotency-Key; budget enforced in one conditional SQL update; backend semantic validators; first live credits spent on a minimum-frame run from a converted public dataset. Secondary risks are isolation and compile cost: new Neon + Railway project, a paid provider that refuses to boot without an explicit flag, and Swift compile-checked on a macOS CI runner before it costs an EAS build.

### Cross-file tensions resolved

1. **Auth.** Sign in with Apple can't be tested properly in Expo Go (token audience is Expo Go's bundle id). v1: **Better Auth** (self-hosted on Neon, Drizzle adapter, `@better-auth/expo` + SecureStore) with **email + password, owner allowlist, sign-up disabled** — works in Expo Go, no mail provider needed. Email OTP/magic link is an optional swap later. `DEV_AUTH_TOKEN` is tests/CI only; the server refuses to boot with it in production. **SIWA added in the native phase** via Better Auth's idToken flow.
2. **Upload wording.** "Survive app kill" is not achievable (iOS cancels background sessions on force-quit; Expo `UploadTask` is not restored after termination). Reworded: uploads survive lock, suspension and system termination, and resume after force-quit via server-side reconciliation — `GET /v1/scans/:id/uploads:missing` (R2 ListObjectsV2 is the source of truth) on every launch/foreground, re-PUT only missing frames, manifest last. `expo-file-system` background tasks first; Swift `URLSession` only if device tests show losses.
3. **Pose conversion + EXIF.** Swift: ARKit 1920x1440 video format, sensor-native landscape frames, **no resize, no rotation, no EXIF Orientation, no thumbnail/GPS/XMP**; write raw column-major `camera.transform` and raw `intrinsics` to `frames.jsonl`, plus monotonic wall time (`bootEpoch + ARFrame.timestamp`). Backend (`convert.ts`, `exif.ts`): invert, left-multiply diag(1,-1,-1,1), transpose to row-major, write intrinsics JSON; insert `DateTimeOriginal` / `SubSecTimeOriginal` (3 digits) / `OffsetTimeOriginal` in the first 64 KiB; semantic validator (path continuity, forward vector vs motion direction, intrinsics vs JPEG size). Fixes ship as a Railway deploy, not an EAS build. Fallback: ~5 lines of ImageIO in Swift. Privacy manifest must declare the boot-time API if Swift computes `bootEpoch`.
4. **macOS compile check.** A GitHub Actions `macos-latest` job (`expo prebuild -p ios` + unsigned `xcodebuild`) is a deliverable of the native-readiness phase; Swift must compile green there before the first EAS dev build. Verify the private-repo macOS minute multiplier.

Smaller settlements: bundle presigned GET **24 h** (min 2.5 h; R2 allows 7 d; ZIP purged only after terminal state); frame PUT presigns ~6 h with a 403 re-presign backstop; share route `src/app/s/[slug].tsx` outside the auth group; status = 60 s `snoozeJob` + webhook nudge; native module name `virtumetry-capture`.

## Key Findings

### Recommended Stack

App = existing Expo SDK 58 starter (RN 0.88, Expo Router, React Compiler). Backend = VirtSpace verbatim (Node 24, Fastify 5, Drizzle, Neon, R2, vitest). Add only:

- **Local Expo module** (`create-expo-module --local`), Swift only — ARKit capture + preview view. No RN AR library fits (ViroReact renders scenes, no raw frames; react-native-arkit dead). Inline modules experimental.
- **`expo-dev-client`** — one EAS build covers many JS iterations.
- **Spark 2.4 + three 0.187 (pinned) in an Expo DOM component** (`'use dom'`) — one viewer for app (works in Expo Go) and web share page; LoD with iOS 1.5M-splat budget answers VirtSpace's choppy full-res lesson. Imperative three, not R3F. PlayCanvas = fallback.
- **`three-mesh-bvh`** — walk collision + measure raycasts against `mesh-simplified`.
- **Better Auth 1.7.27 + `@better-auth/expo`** — email+password+allowlist now, Apple idToken later, organization plugin for brokers later.
- **`expo-file-system` background upload + server reconciliation** — no Swift uploader.
- **Backend:** `yazl` (store-only ZIP, exact size up front), `@aws-sdk/lib-storage` (streaming multipart), `@fastify/cors`, thin typed Echo-3 `fetch` client (no official SDK).
- **Tests:** `jest-expo` 58 + Jest 30 + RNTL 14, existing vitest, CI on GitHub Actions (EAS CI = 60 min). No Maestro in v1 (not on EAS free, no official real-iPhone support).

Pin `three` exactly; `npx expo install` throughout; don't upgrade vitest/TS during the copy; keep both Better Auth packages on the same version.

### Expected Features

Echo-3 fills gaps and bills 900 + frames, so the danger is a bad-but-valid capture → pre-upload checks matter more than retry logic.

**Table stakes:** prep checklist and camera permission priming; one-at-a-time live coaching; tracking-loss pause/resume with 0.5 s warm-up; progress + coverage mini-map + min/max frame limits + review + on-device save; pre-upload validation on device and backend; library states (capturing, uploading, processing, ready, failed + retry for transient failures only); viewer orbit + collision walk + start pose + honest loading + LoD budget + WebView crash recovery + reset; point-to-point measure + floor plan "you are here"; public share link with OG preview + revoke; owner auth.

**Differentiators:** green/amber/red readiness meter (tunable thresholds, calibrated on first 5–10 real scans); live cost meter + quote + server budget guard; floor plan + measure + walk in one viewer, also on web, with tap-to-teleport.

**Defer:** auto room dimensions, dense live mesh preview, threshold-tuning UI. Later milestones: multi-room merge, labelled floor plan, dollhouse, embed, MLS mode, hotspots, redaction, flythrough, Android, payments. **Anti-features:** generative fill/staging, square-footage claims, exports (Standard = non-commercial), imports, auto-retry of paid jobs, exhaustive-coverage UI, public gallery.

### Architecture Approach

Monorepo: `virtumetry/` (app, also the web share page), `backend/` (VirtSpace fork), `.planning/`. No `web/` in v1, no npm workspaces. The **on-disk session format** (`session.json`, `frames.jsonl` with raw ARKit values, `frames/*.jpg`) is the single contract between native module, fixture source, uploader and pack job. Backend builds the ZIP; per-frame presigned PUTs make resume re-send only missing frames. Money path = persist-before-spend state machine + provider idempotency key.

**Components:**
1. `virtumetry-capture` (Swift) — ARSession singleton owned by a controller (not the view), keyframe gate, predicted-blur reject, JPEG to disk, manifest append, throttled events, preview view.
2. FixtureCaptureSource (TS) — same interface, replays recorded sessions in Expo Go.
3. Capture screen + coverage (TS) — guidance, readiness, pre-check, quote, credit approval.
4. Upload manager (TS singleton) — app-scoped, reconciles from server truth, manifest last.
5. Backend API + worker — Postgres job queue (`pack`, `submit`, `track`, `purge`); `snoozeJob` replaces long leases; webhook = verify → dedupe → nudge → 200; only `track` writes state.
6. ReconProvider (`mock` | `echo3`) — mock scripts failures (FAILED, 402, 409, 429, 503, duplicate webhooks) and signs its own webhooks.
7. Viewer (`'use dom'`) — LoD splat, collider walk, floor plan, measure, one shared coordinate-transform utility.
8. Budget ledger — atomic conditional reservation keyed on `submission_key`, compensating release.

### Critical Pitfalls

1. **Semantically wrong bundle billed (P1, P4)** — 1920x1440, no resize/rotation, one unit-tested `arkitToOpenCV`, monotonic timestamps, backend semantic validator, first live run at `min_frames`.
2. **Double submit / blind retry (P2, P11)** — persist key + byte-identical body before POST; never mint keys automatically; retry after FAILED needs explicit cost re-approval; budget reserved in one conditional UPDATE; kill-mid-submit and concurrent-submit tests.
3. **Presigned ZIP expiry / no Range (P3)** — 24 h direct R2 presign, Range 206 preflight, purge only after terminal state.
4. **Isolation + no-Mac build burn (P12, P8)** — new Neon/Railway; dev refuses prod URLs; live mode needs `ALLOW_PAID_PROVIDER=1`; no session `SET` through the Neon pooler; macOS CI compile check; batched native work; fingerprint runtime policy.
5. **Capture lifecycle + bridge (P5, P6, P7)** — no pixels or 60 Hz state over the bridge; ARSession owned by a controller; capture screen a never-rekeyed modal; keyframes only at `.normal` tracking; flag `pose_discontinuity`; A/B trajectory vs none.

Also: webhook is a hint only (P16); re-host outputs immediately, redirects expire in ~5 min (P20); written retention policy implemented in the same phase (P22).

## Implications for Roadmap

Phases 1–6 must run in Expo Go, web and backend tests — no Apple Developer membership, no EAS builds.

1. **Backend fork + isolation** — copy VirtSpace backend, strip stitcher/World Labs/depth; new Neon + Railway; separate dev/prod R2; CI green; paid-provider boot guard; migrations on the direct host. (P12, P11)
2. **Session format, bundle pipeline, mock provider** — schema; `convert.ts`, `exif.ts`, semantic validator, streaming store-ZIP → R2 multipart; Range presign check; `snoozeJob`; ReconProvider + scripted-failure mock; fixture bundle converted from a public posed dataset (tiny fixture committed). (P1, P3, P4)
3. **Auth, scan API, app shell** — Better Auth (email+password, allowlist); scans CRUD, upload presign, `uploads:missing`, `:complete`; Expo Router shell + library with all states; per-profile API URLs that refuse prod. (P9, P12)
4. **Upload manager + fixture capture source ($0 loop)** — import fixture scan; app-scoped uploader with background PUTs + reconciliation; coverage/readiness in TS; pre-check, quote, credit approval; pack → mock submit → track → ready. (P10, P5)
5. **Viewer, floor plan, measure, share page** (parallel with 4) — DOM viewer (Spark LoD, collider walk, floor plan overlay, measure, start pose, WebView-kill recovery, one transform util); public `/s/[slug]` with revoke, OG preview, `noindex`; R2 CORS for Range. Measure iPhone 17 Pro fps early. (P18, P19)
6. **Live Echo-3 provider** — `echo3.ts`, submit/track/import state machine, webhook route, caps, cancel/retry UX with cost re-confirmation, streamed re-hosting, weekly `openapi.json` diff. First paid run = minimum-frame converted-dataset bundle; record its outputs into mock fixtures. (P2, P3, P11, P16, P20, P21)
7. **Native build readiness** — buy Apple Developer membership at the start (enrolment 1–2 days); macOS compile check; stub `virtumetry-capture` compiling green; fingerprint `runtimeVersion`; EAS profiles/channels; Sentry; Windows tunnel workflow; iPhone Developer Mode + `eas device:create`. (P8, P26–P29)
8. **Native capture + Sign in with Apple** — ported Swift engine, live coaching, tracking-loss pause/resume, thermal + disk preflight, permission string; batch of 3–5 EAS dev builds; SIWA via Better Auth idToken; first real 3-minute scan end to end. (P1, P5, P6, P7, P13, P14, P25)
9. **Hardening + privacy** — retention/purge clocks + R2 lifecycle; deletion cascading Neon → R2 → SpAItial; versioned consent naming SpAItial; privacy manifest; on-device upload survival matrix (lock, system kill, force-quit); budget alerts; "approximate" measurement copy. (P17, P22, P23, P24)

**Ordering rationale:** session format first (every consumer meets there); conversion/EXIF in backend so fixes don't cost builds; first paid run uses a converted dataset so a failure can only be the adapter; 4 and 5 can overlap; Apple purchase at the start of 7 so 8 isn't blocked.

**Research flags:** Phase 2 (public posed dataset; intrinsics/trajectory schemas), Phase 5 (Spark LoD first-open time on 17 Pro; SPZ vs SOG), Phase 6 (idempotency retention window; `mesh-simplified` cost; SpAItial output retention + data/training terms), Phase 8 (1920x1440 on 17 Pro; `orientation.json` for landscape — review SpAItial's Capture iOS prototype first; AE A/B; trajectory A/B). Standard patterns: 1, 3, 4, 7, 9.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | npm/docs verified; Spark pin behaviour and Expo Go auth audience LOW |
| Features | MEDIUM | Vendor pages/trade press, no hands-on; readiness thresholds need real scans |
| Architecture | MEDIUM-HIGH | Echo-3 contract + SDK 58 verified, VirtSpace source read; idempotency window + Expo Go background upload unverified |
| Pitfalls | MEDIUM-HIGH | Echo-3 rules + VirtSpace lessons HIGH; ARKit/iOS behaviour MEDIUM |

### Gaps to Address

- Idempotency retention window undocumented — keep auto submit retries within ~1 h; confirm with SpAItial before the first paid run.
- "Failed runs cost 0" thinly corroborated — verify on first failure; make retry copy conditional.
- `orientation.json` for landscape, AE policy, trajectory on interruption — settle in phase 8.
- Floor plan affine + measurement accuracy — no accuracy claim until a tape-measure test passes.
- R2 Range on presigned GET — mock central-directory read + worker preflight are the check.
- SDK 59 timing vs Expo Go — if it ships before phase 8, move to a dev build early.
- Standard-plan non-commercial licence — blocker for any non-owner scan; ask SpAItial in writing.
- Observed vs completed regions in Echo-3 output — unknown; matters for listings.
- One hands-on session with SpAItial's app before finalising the capture HUD (observe only).

## Sources

**Primary (HIGH):** docs.spaitial.ai (capture-worlds, worlds, webhooks, exports, billing, rate limits); docs.expo.dev SDK 58 (llms.txt, modules, DOM components, FileSystem, unit testing, EAS Hosting); sparkjs.dev; better-auth.com (Expo, Fastify); Cloudflare R2 docs; npm registry (2026-11-23); VirtSpace repo (backend source, HANDOFF.md, spec-doc.md R1–R42, research docs).
**Secondary (MEDIUM):** radiancefields.com (Echo-3 launch, API opening, Splat Tour); Polycam, Scaniverse, KIRI, Teleport, Matterport, Zillow pages; PlayCanvas/SuperSplat docs; Apple forums on background URLSession stalls; Maestro iOS device-support write-ups.
**Tertiary (LOW):** training data on ARKit orientation, force-quit behaviour, required-reason API categories, GitHub macOS multiplier; RealityKit `GaussianSplatComponent` iOS availability (disputed).

---
*Research completed: 2026-11-23 · Ready for roadmap: yes*
