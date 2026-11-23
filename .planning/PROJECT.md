# Virtumetry

## What This Is

Virtumetry is a phone app that turns a slow walk-through of a real room into a photoreal, real-scale 3D world you can walk around in, on the phone and in any browser. It is built with Expo (iOS first, Android later) and uses SpAItial's Echo-3 API for reconstruction. The long-term goal is a real-estate listing marketplace where brokers scan properties and buyers or renters tour them in 3D; v1 proves the scan-to-3D-room loop for the owner as the only tester.

## Core Value

A walk-through scan of a real room comes back as a faithful, walkable 3D world, reliably, without wasting paid processing on bad captures.

## Requirements

### Validated

- [x] Mock provider + recorded fixture bundles so development never spends Echo-3 credits by accident — Validated in Phase 2: Bundle Pipeline & Mock Provider
- [x] Hard credit budget caps on the backend (daily + monthly, atomic reservation) — Validated in Phase 2
- [x] Backend packs the bundle ZIP and hosts it on R2 (Range-capable 24 h URL), runs submit/track/import against the mock with webhook + polling, and re-hosts outputs — Validated in Phase 2 (live Echo-3 submit is Phase 6)

### Active

- [ ] Owner can scan a room on iPhone by walking it with the camera, with live guidance on what is covered and when the scan is good enough
- [ ] The app captures Echo-3-ready keyframes: sharp JPEGs (long edge ≤1920), per-frame intrinsics, ARKit camera poses, motion-gated (≥0.12 s, ≥7 cm / 10°)
- [ ] The app checks a scan before upload (frame count, blur, coverage) and shows the processing cost quote before spending credits
- [ ] Scans upload reliably: survive phone lock, suspension and iOS termination, and resume after force-quit by re-sending only frames the server reports missing
- [ ] Backend submits real bundles to Echo-3 with an idempotency key (live provider, Phase 6)
- [ ] Owner can walk the finished room in the app (splat viewer, smooth on iPhone 17 Pro, collider-based walk mode)
- [ ] Owner can see the auto floor plan and measure distances in the room
- [ ] Owner can share a room via a public web link that opens in any browser
- [ ] Library of scans with clear states (capturing, uploading, processing, ready, failed + retry)
- [ ] Real authentication (owner account) — no shared anonymous library

### Out of Scope

- Listings marketplace (listings, search, buyer accounts) — later milestone; v1 proves the scan loop first
- Multi-room / whole-house merge (Echo-3 `zips[]`, up to 8) — next milestone, after single-room quality is proven
- Android capture (ARCore) — no Android test phone; app shell stays cross-platform so it can follow
- Payments / broker pricing — "decide later"; v1 is owner-paid with budget caps
- Self-hosted reconstruction (gsplat/Brush on GPU) — kept possible behind the provider interface, not built in v1
- World Labs Marble / pano stitching from VirtSpace — generative, not faithful; dropped
- Public sign-up / App Store release — owner-only testing in v1
- Reverse-engineering SpAItial's app or model — ToS and gives nothing (their model is server-side)

## Context

- **Prior project: VirtSpace** (github.com/mrbarnaclebot-ux/VirtSpace) — native SwiftUI + ARKit one-spot pano capture, Fastify/Drizzle/Neon/R2 backend on Railway, World Labs Marble generation. Its research (`docs/research/reconstruction-vs-generation.md`, `live-mapping.md`) concluded generation from one pano is not faithful enough for listings; reconstruction from a walk-through (frames + poses) is required. Its backend (job queue with leases, idempotency, quotas, credit budget, R2 storage, push, mock provider, CI, Railway IaC, ~348 tests) is solid and gets reused.
- **VirtSpace lessons:** agents once polluted production data and burned quota → strict isolation from prod; a session `SET` through the Neon pooler broke prod writes → never; World Labs 422 on a new limit failed every capture silently → pre-flight validation; full-res splats were choppy on iPhone 17 Pro → LOD/budgeted rendering; raw frames kept forever despite promising purge → explicit retention policy; auth was deferred forever → build it in v1.
- **Echo-3 API (public since Nov 2026):** `POST /v1/worlds` with `model: echo-3`, `input.type: capture_bundle`, presigned ZIP URL (HTTP Range, valid ≥2.5 h). ZIP: `images/Image_NNNNNN.jpg` (1-indexed, same size, long edge ≤1920, short ≥360, no EXIF rotation, increasing `DateTimeOriginal`/`SubSecTimeOriginal`), `cameras/per_frame_intrinsics.json` (required), `cameras/camera_trajectory.json` (optional, OpenCV `camera_from_world` 4x4, metres; ARKit: invert `camera.transform` then × diag(1,-1,-1,1)), `cameras/orientation.json`. Keyframes 3–5/s, ≥0.12 s and ≥7 cm or 10° apart, skip predicted blur >64 px. No LiDAR or video input. Cost `900 + frame_count` credits (1 credit = $0.01; ~$15–18 per room). `GET /v1/captures/process-quote`, `/v1/captures/limits`, status polling, HMAC-SHA256 webhooks (`X-Spaitial-Signature`, dedupe on `delivery_id`), 30 min–2 h processing, 10 creates/min. Outputs: SPZ/SOG/PLY (RDF y-down; viewer frame is (x,-y,-z)), `mesh` + `mesh-simplified` PLY, floorplan PNG + pixel→world affine JSON, `cameras.json`. Standard plan = non-commercial; Pro = commercial rights. SpAItial links an open "Capture iOS prototype" repo worth reviewing.
- **Existing app:** Expo SDK 58 starter in `virtumetry/` (React Native 0.88, Expo Router, typed routes, React Compiler); typecheck, lint, expo-doctor clean.

## Constraints

- **Platform / tooling**: Owner develops on Windows and will not use a Mac — iOS native code builds only on EAS cloud
- **Build budget**: EAS free plan — 15 iOS + 15 Android builds/month, low-priority queue, 60 CI min/month, EAS Update to 1K MAU; native changes must be batched, JS-only changes ship via dev client / EAS Update (rules in `virtumetry/AGENTS.md`)
- **Device testing**: iPhone 17 Pro only, no Android phone. Apple Developer Program ($99/yr) not yet bought — buy right before the native capture phase; everything before it must be testable in Expo Go
- **Native capture**: no Expo package exposes ARKit frames + poses + intrinsics → a custom Expo native module (port of VirtSpace's Swift capture engine)
- **Money**: every real Echo-3 run costs ~$15–18 → mock provider and fixture bundles are the default; never retry blind; persist request ids before polling; budget caps enforced server-side
- **Licensing**: Echo-3 Standard plan outputs are non-commercial; commercial launch needs Pro or Enterprise
- **Data isolation**: new Neon database and new Railway project; VirtSpace production is never touched
- **Privacy**: scans of private homes — explicit retention policy for raw frames and outputs, privacy manifest, consent
- **Branding**: own name, look and copy — not a copy of SpAItial's app

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Echo-3 API as the reconstruction engine | Faithful + gap-filled reconstruction now available via API; building our own is months of research-grade work | — Pending |
| Keep a provider interface (mock / echo-3 / future self-hosted) | Launch pricing may change; avoid lock-in; enables zero-cost dev | — Pending |
| Copy the VirtSpace backend into `backend/`, strip stitcher + World Labs | Proven jobs/quotas/storage/CI; rewriting would re-learn its bugs | — Pending |
| Monorepo at `Virtumetry/` (`virtumetry/` app, `backend/`, later `web/`, `.planning/`) | One place for app, backend, web share page and planning | — Pending |
| Native ARKit capture module instead of plain video | Echo-3 requires per-frame intrinsics and works best with poses; video input not accepted | — Pending |
| iOS first; buy Apple Developer membership just before the capture phase | Earlier phases run in Expo Go for free | — Pending |
| v1 = single room, owner only, owner-paid with caps | Prove quality and reliability before marketplace, multi-room or pricing | — Pending |
| Build our own version, never reverse-engineer SpAItial | ToS; model is server-side | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-24 after Phase 2*
