# Requirements: Virtumetry

**Defined:** 2026-11-23
**Core Value:** A walk-through scan of a real room comes back as a faithful, walkable 3D world, reliably, without wasting paid processing on bad captures.

## v1 Requirements

v1 = single room, owner-only testing, iPhone first. Each requirement maps to one roadmap phase.

### Foundation & Isolation (FND)

- [x] **FND-01**: Backend runs from `backend/` in the monorepo as a copy of the VirtSpace backend with the stitcher, World Labs provider and depth pipeline removed, and its test suite passes in CI
- [x] **FND-02**: Backend uses its own new Neon database, Railway project and separate dev/prod R2 buckets; no config path can reach VirtSpace production
- [x] **FND-03**: Backend refuses to start the paid Echo-3 provider unless `ALLOW_PAID_PROVIDER=1` is set, and refuses dev-token auth in production
- [x] **FND-04**: Database migrations run automatically on deploy over the direct (non-pooler) Neon host
- [x] **FND-05**: App and backend lint, typecheck and tests run on every push in GitHub Actions (not EAS CI minutes)

### Account (AUTH)

- [x] **AUTH-01**: Owner can log in with email and password; sign-up is disabled and only allowlisted emails can log in
- [x] **AUTH-02**: Owner stays logged in across app restarts (session stored in SecureStore)
- [x] **AUTH-03**: Owner can log out from Settings
- [ ] **AUTH-04**: Owner can sign in with Apple (added once the native dev build exists)
- [x] **AUTH-05**: Every scan and world belongs to one account; no shared or anonymous library

### Capture (CAP)

- [x] **CAP-01**: Owner sees a short prep checklist (lights on, doors open, avoid mirrors) and camera-permission priming before the first scan
- [ ] **CAP-02**: Owner can scan a room by walking it with the iPhone camera; the app keeps only Echo-3-ready keyframes (≥0.12 s and ≥7 cm or 10° apart, predicted blur ≤64 px, 1920x1440, no resize/rotation)
- [ ] **CAP-03**: Owner gets one live coaching prompt at a time (slow down, more light, look at the floor/ceiling line, turn around)
- [ ] **CAP-04**: When ARKit tracking is lost, capture pauses automatically, tells the owner how to recover, and resumes only after tracking has been normal for a short warm-up
- [x] **CAP-05**: Owner sees a readiness meter (green/amber/red) combining frame count, coverage, blur and tracking quality, with thresholds that can be tuned without an app build
- [x] **CAP-06**: Owner sees a live cost meter showing the current Echo-3 cost (900 + frames credits, in $) while scanning
- [x] **CAP-07**: Owner sees a top-down coverage mini-map of the path walked and directions looked
- [ ] **CAP-08**: Capture enforces Echo-3 min/max frame limits and warns about heat or low storage before and during a scan
- [x] **CAP-09**: A finished scan is saved on the phone first; owner can review it (frame count, duration, cost, readiness) and choose upload or discard
- [x] **CAP-10**: In Expo Go and tests, a fixture capture source replays a recorded scan through the same interface as the native module

### Upload & Processing (PROC)

- [x] **PROC-01**: Before spending credits the app runs pre-upload checks (frame count, blur, coverage, tracking gaps) and the backend re-runs the same rules plus semantic checks (pose continuity, forward vector vs motion, intrinsics vs image size)
- [x] **PROC-02**: Owner sees the Echo-3 cost quote and must explicitly approve it before processing starts
- [ ] **PROC-03**: Uploads continue while the phone is locked or the app is suspended or terminated by iOS, and after a force-quit they resume on next launch by re-sending only the frames the server reports missing
- [x] **PROC-04**: Backend converts ARKit poses to OpenCV `camera_from_world`, writes intrinsics and EXIF timestamps, and packs a valid Echo-3 capture-bundle ZIP on R2 with a Range-capable presigned URL valid ≥24 h
- [ ] **PROC-05**: Backend submits to Echo-3 at most once per approved scan: idempotency key and exact request body are saved before the call; a retry after failure needs a new explicit owner approval
- [x] **PROC-06**: Backend tracks status via signed webhooks (HMAC verified, deduplicated on `delivery_id`) with a polling fallback; webhooks only nudge the tracker
- [x] **PROC-07**: When processing finishes, backend copies all outputs (SPZ/SOG splat, `mesh-simplified`, floor plan + affine, `cameras.json`) into our own storage before marking the world ready
- [x] **PROC-08**: Backend enforces a hard credit budget (per day and per month) with an atomic reservation; a scan over budget is refused before any spend
- [ ] **PROC-09**: Owner gets a push notification when a world is ready or failed
- [x] **PROC-10**: A mock provider (including scripted failures: FAILED, 402, 409, 429, 503, duplicate webhooks) is the default everywhere except an explicitly enabled live mode

### Library (LIB)

- [x] **LIB-01**: Owner sees all scans with clear states: saved on phone, uploading (with progress), processing (with estimate), ready, failed
- [x] **LIB-02**: Owner can retry a failed scan only when the failure is retryable, after re-confirming the cost
- [x] **LIB-03**: Owner can rename and delete a scan; deleting removes it from our database and storage and requests deletion at SpAItial

### Viewer (VIEW)

- [x] **VIEW-01**: Owner can open a ready world and orbit it smoothly on iPhone 17 Pro (level-of-detail splat budget, honest loading progress)
- [x] **VIEW-02**: The world opens from a sensible start viewpoint, and the owner can reset the view
- [x] **VIEW-03**: Owner can switch to walk mode and move first-person with collision against the Echo-3 collider mesh
- [x] **VIEW-04**: Owner can open the floor plan, see "you are here", and tap a spot to teleport there
- [x] **VIEW-05**: Owner can measure the distance between two tapped points, labelled as approximate
- [x] **VIEW-06**: The viewer recovers automatically if the WebView or WebGL context crashes

### Sharing (SHARE)

- [x] **SHARE-01**: Owner can create a public link (unguessable slug) that opens the world in any browser using the same viewer
- [x] **SHARE-02**: Owner can revoke a link and it stops working immediately
- [x] **SHARE-03**: Shared links show a preview (thumbnail + title) when pasted into messaging apps, and are `noindex`
- [x] **SHARE-04**: Owner can optionally protect a link with a password
- [x] **SHARE-05**: Owner can see how many times each link was opened

### UI/UX (UX)

- [ ] **UX-01**: One design system (palette tokens with derived surfaces/borders/states at WCAG AA, type scale, spacing, radii, elevation, motion with reduced-motion support) drives the app, the viewer chrome and the web share page
- [ ] **UX-02**: Every screen and sheet is redesigned on the design system with a distinct Virtumetry brand look (not a copy of SpAItial), modern icons and branded app icon/splash
- [ ] **UX-03**: A first-run onboarding explains scan → upload → walk/share, shows once, is skippable and can be replayed from Settings
- [ ] **UX-04**: Contextual coach marks explain capture prep and viewer modes the first time they are seen
- [ ] **UX-05**: One toast system reports success, error and info; destructive actions keep explicit confirmations
- [ ] **UX-06**: Micro-interactions, transitions and visual guides animate with Reduce Motion respected, and key actions give haptic feedback
- [ ] **UX-07**: No zombie UI: every control works, and every loading, empty, error and offline state is real and honest
- [ ] **UX-08**: Accessibility holds across the redesign: labels, ≥44pt targets, capped Dynamic Type, AA contrast

### Native Build & Privacy (OPS)

- [ ] **OPS-01**: A macOS GitHub Actions job runs `expo prebuild` and an unsigned `xcodebuild` so Swift compile errors are caught before any EAS build
- [ ] **OPS-02**: EAS dev/preview profiles use a fingerprint runtime policy so JS-only changes ship by EAS Update, and native changes are batched (target ≤5 iOS builds for the capture phase)
- [ ] **OPS-03**: Raw frames and bundles follow a written retention policy enforced by R2 lifecycle rules and a purge job
- [ ] **OPS-04**: The app shows a versioned consent screen naming SpAItial as processor before the first upload, and ships a correct privacy manifest
- [ ] **OPS-05**: Crash and error reporting is wired for app and backend
- [ ] **OPS-06**: The owner is alerted when spend reaches a set share of the budget

## v2 Requirements

Deferred. Tracked, not in the current roadmap.

### Whole house
- **HOUSE-01**: Merge up to 8 room scans into one property (Echo-3 `zips[]`) with a floor switcher
- **HOUSE-02**: Labelled floor plan with room names and dimensions
- **HOUSE-03**: Dollhouse overview

### Marketplace
- **MKT-01**: Listings (address, price, details, photos, 3D tour) on a public web marketplace
- **MKT-02**: Broker accounts and organisations; buyer/renter accounts
- **MKT-03**: Embed code and MLS-compliant unbranded tour links
- **MKT-04**: Hotspots and privacy redaction before publishing
- **MKT-05**: Search and discovery

### Platform & business
- **PLAT-01**: Android capture with ARCore
- **PLAT-02**: Payments / broker pricing (per scan or subscription)
- **PLAT-03**: Self-hosted reconstruction provider (gsplat/Brush on GPU) behind the provider interface
- **PLAT-04**: Auto room dimensions, threshold-tuning UI, dense live mesh preview

## Out of Scope

| Feature | Reason |
|---------|--------|
| Generative fill / virtual staging | Listings must be faithful; generated content misleads buyers |
| Square-footage / GLA claims | Liability on listings; measurements stay "approximate" |
| Exporting splat/mesh files | Echo-3 Standard plan outputs are non-commercial; revisit on Pro |
| Importing videos/photos from other cameras | Echo-3 needs posed keyframes with intrinsics from our capture |
| Automatic retry of paid jobs | Double-charge risk; retries always need owner approval |
| "Paint every surface" coverage UI | Echo-3 fills gaps; aim for "good enough", not exhaustive |
| Public gallery / social feed | Not part of the listings goal |
| World Labs Marble / pano stitching | Generative, not faithful (VirtSpace research) |
| Reverse-engineering SpAItial | ToS; model is server-side |
| Public sign-up / App Store release | v1 is owner-only testing |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| FND-04 | Phase 1 | Complete |
| FND-05 | Phase 1 | Complete |
| AUTH-01 | Phase 3 | Complete |
| AUTH-02 | Phase 3 | Complete |
| AUTH-03 | Phase 3 | Complete |
| AUTH-04 | Phase 8 | Pending |
| AUTH-05 | Phase 3 | Complete |
| CAP-01 | Phase 4 | Complete |
| CAP-02 | Phase 8 | Pending |
| CAP-03 | Phase 8 | Pending |
| CAP-04 | Phase 8 | Pending |
| CAP-05 | Phase 4 | Complete |
| CAP-06 | Phase 4 | Complete |
| CAP-07 | Phase 4 | Complete |
| CAP-08 | Phase 8 | Pending |
| CAP-09 | Phase 4 | Complete |
| CAP-10 | Phase 4 | Complete |
| PROC-01 | Phase 4 | Complete |
| PROC-02 | Phase 4 | Complete |
| PROC-03 | Phase 4 | Pending |
| PROC-04 | Phase 2 | Complete |
| PROC-05 | Phase 6 | Pending |
| PROC-06 | Phase 2 | Complete |
| PROC-07 | Phase 2 | Complete |
| PROC-08 | Phase 2 | Complete |
| PROC-09 | Phase 7 | Pending |
| PROC-10 | Phase 2 | Complete |
| LIB-01 | Phase 3 | Complete |
| LIB-02 | Phase 6 | Complete |
| LIB-03 | Phase 3 | Complete |
| VIEW-01 | Phase 5 | Complete |
| VIEW-02 | Phase 5 | Complete |
| VIEW-03 | Phase 5 | Complete |
| VIEW-04 | Phase 5 | Complete |
| VIEW-05 | Phase 5 | Complete |
| VIEW-06 | Phase 5 | Complete |
| SHARE-01 | Phase 5 | Complete |
| SHARE-02 | Phase 5 | Complete |
| SHARE-03 | Phase 5 | Complete |
| SHARE-04 | Phase 5 | Complete |
| SHARE-05 | Phase 5 | Complete |
| UX-01 | Phase 6.1 | Pending |
| UX-02 | Phase 6.1 | Pending |
| UX-03 | Phase 6.1 | Pending |
| UX-04 | Phase 6.1 | Pending |
| UX-05 | Phase 6.1 | Pending |
| UX-06 | Phase 6.1 | Pending |
| UX-07 | Phase 6.1 | Pending |
| UX-08 | Phase 6.1 | Pending |
| OPS-01 | Phase 7 | Pending |
| OPS-02 | Phase 7 | Pending |
| OPS-03 | Phase 9 | Pending |
| OPS-04 | Phase 8 | Pending |
| OPS-05 | Phase 7 | Pending |
| OPS-06 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 58 total
- Mapped to phases: 58
- Unmapped: 0

---
*Requirements defined: 2026-11-23*
*Last updated: 2026-11-23 after roadmap creation*
