# Phase 5: Viewer, Floor Plan, Measure & Share - Research

**Researched:** 2026-11-24
**Domain:** Gaussian-splat viewer in an Expo DOM component (Spark + three + three-mesh-bvh), Echo-3 output coordinates, Fastify public share routes, Expo Router web on EAS Hosting
**Confidence:** MEDIUM-HIGH (APIs verified from package sources and official docs; one LOW item: the collider mesh frame is undocumented by SpAItial)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Fixture world worth viewing
- **D-01:** The current mock outputs (8-gaussian `splat.ply`, unit-box collider, blank 64x64 floor plan) cannot prove orbit/walk/measure. Add a **generated synthetic "demo room"** output set: a script (`backend/scripts/make-demo-room.ts`) builds a ~4 x 5 m room (floor, 4 walls with a doorway, 1-2 box "furniture" obstacles) as (a) a colored Gaussian splat (~50-150k gaussians, committed size budget **<= 5 MB**; format = whatever Spark 2.4 loads that we can write without new heavy deps, researcher picks PLY vs SPZ/`.splat`), (b) a matching triangle collider PLY (walls/floor/obstacles), (c) a rendered top-down floor plan PNG + `floorplan.json` with correct affines, (d) `cameras.json` with a plausible walk path, (e) a `thumbnail.jpg`. License-free (we generate it). Committed under `backend/test/fixtures/demo-room/`.
- **D-02:** Existing tiny `mock-outputs/` stay for fast backend tests. The mock provider gets an env-selected outputs set (`MOCK_OUTPUTS_SET=demo-room`, validated, default unchanged); the **Railway dev** env sets it so a Phase-4 fixture scan comes back as the demo room. Production untouched. Mock emits `thumbnail` too (importer already has `thumbnailKey`).
- **D-03:** Coordinate conventions (y-up vs OpenCV y-down for `spaitial-world-v1`, `camera_from_splat` inversion) are **researcher-verified** against SpAItial docs; the demo room is generated in exactly that convention so the viewer is correct for real Echo-3 outputs, not just our fixture.

#### Viewer architecture (VIEW-01/02)
- **D-04:** One `'use dom'` component (`virtumetry/src/viewer/world-viewer.tsx` + plain-TS engine modules under `src/viewer/`) using **Spark 2.4.0 + three 0.187.0 + three-mesh-bvh 0.9.18** (pinned exactly), imperative three in `useEffect`, no R3F. Props are serializable: `{ splatUrl, colliderUrl?, floorplanUrl?, floorplanMeta?, camerasUrl?, startPose?, title }`; native actions: `onProgress`, `onReady`, `onError`, `onPose` (throttled, for recovery). Same component renders as plain DOM on web.
- **D-05:** Honest progress: fetch the splat ourselves with streamed byte counting (`Content-Length`), percent shown in an overlay; then hand bytes to Spark (`fileBytes`). Indeterminate spinner only when length unknown. Stages: "Downloading world", "Preparing".
- **D-06:** LoD: Spark 2.x built-in LoD with an explicit conservative splat budget for mobile (tunable constant). `.RAD` pre-build deferred (no Rust in backend this phase).
- **D-07:** Start viewpoint = first camera of `cameras.json` (converted to three); fallback = scene-bounds center at eye height looking along the longest axis. **Reset** returns to start pose and orbit mode.
- **D-08:** Coordinate + affine math in pure TS (`src/viewer/coords.ts`, `floorplan.ts`, `measure.ts`) with jest tests (OpenCV to three camera, pixel to world xz via `world_xz_from_pixel`/`pixel_from_world_xz`, distance formatting).

#### Walk mode (VIEW-03)
- **D-09:** Toggle Orbit / Walk. Walk: eye height 1.6 m above floor, capsule radius ~0.25 m, horizontal capsule-vs-BVH collision (three-mesh-bvh `shapecast`), no jumping/stairs. Touch: left-half virtual joystick to move, right-half drag to look. Desktop: WASD/arrows + mouse drag look. Collision math lives in a testable module (jest: walking into a wall stops at the wall).
- **D-10:** No collider: Walk and Measure disabled with an explanatory hint.

#### Floor plan (VIEW-04)
- **D-11:** Toggleable floor-plan panel inside the DOM component: floor-plan image with a "you are here" dot + heading wedge; tapping a point teleports (world xz from pixel affine, eye height, pushed out of collider) and switches to Walk. Hidden when the world has no floor plan.

#### Measure (VIEW-05)
- **D-12:** Measure mode: tap two points; each tap raycasts against the collider BVH; show markers + line + label "≈ 2.41 m (approx.)". Third tap starts a new measurement; "Clear" button.

#### Crash recovery (VIEW-06)
- **D-13:** Two layers: (a) inside the DOM component, handle `webglcontextlost`/`restored` (preventDefault, rebuild renderer + reload scene from cached bytes); (b) native side, detect WebView process termination (via whatever `@expo/dom-webview` exposes, researcher confirms) and remount with a bumped `key`, restoring the last pose from `onPose`. A pure `recovery.ts` reducer (crash -> remount with saved pose, cap e.g. 3 per minute then show "Reload" button) with a jest test.

#### Routes / UI entry
- **D-14:** Library row tap on a `ready` world -> `src/app/world/[id].tsx` (full-screen stack screen outside tabs) that fetches `GET /v1/worlds/:id` via react-query and renders the viewer + overlays (back, title, Reset, mode switcher Orbit/Walk/Measure/Plan, Share). Non-ready rows keep current behaviour. Visuals per UI-SPEC.

#### Share links (SHARE-01..05)
- **D-15:** Extend `share_slugs` (drizzle-kit generate; no push): `password_hash text null`, `open_count integer not null default 0`, `last_opened_at timestamptz null`. Slug = 22-char base64url of 16 random bytes. Multiple links per world allowed.
- **D-16:** Owner routes (`backend/src/routes/share.ts`, auth, `findOwnedWorld` 404 for others): `POST /v1/worlds/:id/shares {password?}` (ready worlds only) -> `{ id, slug, url, has_password, open_count, created_at }`; `GET /v1/worlds/:id/shares`; `DELETE /v1/worlds/:id/shares/:shareId` -> `revoked_at=now()` (idempotent).
- **D-17:** Public routes (no auth, rate-limited with existing `@fastify/rate-limit`): `GET /v1/public/shares/:slug` -> `{ title, needs_password }` or 404 (missing / revoked / not ready / deleted all give the same 404); `POST /v1/public/shares/:slug/open {password?}` -> verify password (node:crypto `scrypt` + `timingSafeEqual`; 401 `password_required` / `wrong_password`), atomically increment `open_count`, return `{ title, floorplan_meta, assets: {splat_url, collider_url, floorplan_url, cameras_url} }` presigned with **TTL 15 min**. Revocation kills the link immediately; already-downloaded bytes are not clawed back (documented). Each successful open = one count.
- **D-18:** Share UI: viewer Share button -> share sheet (route modal) listing links (URL, open count, lock icon, created date, Revoke with confirm), "Create link" with optional password, then RN `Share.share` / copy. Hidden for non-ready worlds.

#### Web share page + previews (SHARE-01/03)
- **D-19:** Web viewer = Expo Router web route `virtumetry/src/app/r/[slug].tsx` (outside the auth guard), rendering the same `WorldViewer` as plain DOM; password form when `needs_password`; "This link is no longer available" on 404. `.web.tsx` stubs only if the web export fails without them. Deployed with `eas deploy` (preview, never `--prod`) for dev.
- **D-20:** OG previews need server-rendered meta per slug. The canonical share URL is a **backend landing** `GET /s/:slug` (Fastify HTML): `og:title`, `og:description`, `og:image` (presigned thumbnail with long TTL, or a static fallback), `<meta name="robots" content="noindex,nofollow">` + `X-Robots-Tag: noindex`, then sends browsers to `<WEB_SHARE_ORIGIN>/r/<slug>` (meta refresh + JS). Revoked/missing -> 404 page, still noindex. Landing does **not** count opens. Web route also sets noindex via `expo-router/head`. New backend env `WEB_SHARE_ORIGIN` (zod, https) and `PUBLIC_BASE_URL`.
- **D-21:** CORS: `@fastify/cors` allows the web share origin for `/v1/public/*`. R2 **virtumetry-dev** bucket CORS: GET/HEAD from share origin (+ localhost), allow `Range`, expose `Content-Range, Accept-Ranges, Content-Length, ETag`. Prod bucket untouched.

#### Testing
- **D-22:** App jest: coords / floorplan affine / measure / collision / recovery pure modules; world screen RNTL (loading -> viewer props, Share hidden when not ready) with the DOM component mocked; share sheet RNTL (create / revoke / count); web share route RNTL (password form, 404 message). lint + tsc + jest clean.
- **D-23:** Backend vitest (Neon dev): share create (ready only, ownership 404), slug format, public get/open, revoked -> 404 immediately, password required/wrong/right, open_count increments, `/s/:slug` landing has OG + robots noindex + X-Robots-Tag and does not count, `MOCK_OUTPUTS_SET` selection, demo-room fixture validity. tsc clean.

### Claude's Discretion
- File split under `src/viewer/`, joystick visuals, panel layout (UI-SPEC), demo-room splat format and gaussian count within budget, LoD constants, rate-limit numbers, plan/wave split.

### Deferred Ideas (OUT OF SCOPE)
- `.RAD` LoD pre-build in backend (Rust `build-lod`) — when real Echo-3 splats are too heavy (Phase 6+).
- Custom share domain / Cloudflare Pages / Next.js listing pages — marketplace milestone.
- Link expiry dates, per-viewer analytics, unique-visitor dedupe — later.
- Native RealityKit splat viewer — only if WebView can't hold frame rate.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VIEW-01 | Open a ready world, orbit smoothly (LoD budget, honest progress) | Spark 2.4 `SplatMesh({ fileBytes, lod: true })` + `SparkRenderer({ renderer, lodSplatCount/lodSplatScale })` verified in the package typings; streamed `fetch` byte counting; OrbitControls; pixel-ratio cap. `GET /v1/worlds/:id` must also return `floorplan_meta` (missing today) |
| VIEW-02 | Sensible start view + reset | `cameras.json` to three pose formula (verified from SpAItial docs): `T_three = F · inv(camera_from_splat) · F`, F = diag(1,-1,-1,1) |
| VIEW-03 | Walk with collision against the collider mesh | three-mesh-bvh 0.9.18 `shapecast` + `closestPointToSegment` capsule recipe (official example at the v0.9.18 tag), horizontal-only push-out, `PLYLoader` |
| VIEW-04 | Floor plan, "you are here", tap to teleport | `world_xz_from_pixel` / `pixel_from_world_xz` row-major 3x3, continuous pixel coords (pixel centres at +0.5), world = spaitial-world-v1 = three world |
| VIEW-05 | Two-point measure, labelled approximate | `acceleratedRaycast` + `firstHitOnly` on the collider mesh (not added to the scene); DOM overlay markers |
| VIEW-06 | Auto-recover from WebView/WebGL crash | `@expo/dom-webview` 58.0.2 exposes `onContentProcessDidTerminate` (iOS) and `onRenderProcessGone` (Android), passed through the `dom` prop (verified in source); canvas `webglcontextlost` / `webglcontextrestored` |
| SHARE-01 | Public link, unguessable slug, same viewer in any browser | `randomBytes(16).toString('base64url')`; Expo Router `src/app/r/[slug].tsx` with `web.output: "server"` (SDK 58 = per-request SSR on EAS Hosting, so dynamic routes work); `eas deploy --alias dev` gives a stable origin |
| SHARE-02 | Revoke stops it immediately | Every public query joins `revoked_at IS NULL AND worlds.status='ready' AND deleted_at IS NULL`; presigned TTL 15 min (accepted leak window) |
| SHARE-03 | Preview (thumbnail + title), `noindex` | Fastify HTML landing `/s/:slug` with OG + `X-Robots-Tag`; Expo `pageHeaders` (SDK 58) + `<Head>` on `/r/[slug]`; mock emits `thumbnail` (new `ArtifactKind`) |
| SHARE-04 | Optional password | `node:crypto` `scrypt` + `timingSafeEqual`, per-slug `FailureThrottle` (existing `src/throttle.ts`) |
| SHARE-05 | Open count | Atomic `UPDATE ... SET open_count = open_count + 1 ... RETURNING` with the same validity conditions |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Windows dev, no Mac. Everything in this phase must work in **Expo Go**. No `eas build`. DOM components work in Expo Go (verified, Expo docs).
- `npx expo install` for all app deps. Pin the viewer trio exactly (no `^`).
- Run `npx expo lint` and `npx tsc --noEmit` before calling any app task done (virtumetry/AGENTS.md).
- Mock provider and fixtures by default. No Echo-3 calls. Never touch VirtSpace production, the Virtumetry prod DB or the `virtumetry-prod` bucket (config.ts already refuses it outside production).
- Migrations: `drizzle-kit generate` only, never `push`. Apply to the Neon dev branch with the guard script.
- Don't add `@react-three/fiber` or `@mkkellogg/gaussian-splats-3d`. Don't send splat bytes over the JS bridge. Don't use `===` for secret compares (use `secretEquals` / `timingSafeEqual`).
- Don't use Expo API routes (`+api.ts`). The API lives in Fastify.
- Privacy: share pages are `noindex`; password links must not leak the room interior in previews (UI-SPEC: omit `og:image`).
- GSD workflow: edits only through `/gsd-execute-phase`.

## Summary

Every viewer API this phase needs is verified against the actual package typings (Spark 2.4.0 and three-mesh-bvh 0.9.18 tarballs, inspected in the scratchpad) or official docs. Spark's `SplatMeshOptions` takes `fileBytes`, `fileType`, `stream`/`streamLength`, `onProgress`, `onLoad`, `lod: boolean | "quality"`, `raycastable` and `paged`. `SparkRenderer` takes `lodSplatCount` (defaults: iOS 1.5M, Android 1M, desktop 2.5M) and `lodSplatScale`. Spark detects PLY and SPZ from magic bytes, so PLY or SPZ need no `fileType`. Its WASM is embedded as base64 and its workers are created from blob/data URLs, so there are no extra asset files to bundle. It does call `WebAssembly.compile(...)` **at module scope**, though, and that matters for SSR (below).

The native crash hook exists: `@expo/dom-webview` 58.0.2 (installed) fires `onContentProcessDidTerminate` on iOS and `onRenderProcessGone` on Android. Expo's `webview-wrapper.tsx` spreads the whole `dom` prop onto the WebView, so `dom={{ onContentProcessDidTerminate, onRenderProcessGone }}` works with the default WebView. `react-native-webview` is not needed.

Coordinates are verified from SpAItial's docs:
- `spaitial-world-v1` is metres, +Y up, floor = XZ, and it is the same frame three.js uses.
- Raw SPZ is RDF/OpenCV (y down) and needs a 180° X rotation, `(x,y,z) → (x,-y,-z)`. Current `.ply`/`.sog` conversions are already Y-up.
- `camera_from_splat` maps raw-splat (RDF) coordinates to OpenCV camera coordinates.
- Floor-plan affines map continuous pixel coordinates (top-left pixel centre at 0.5,0.5) to world XZ.
- **The collider mesh frame is not documented.** Handle it with a bounds check against `scene_bounds`.

The biggest planning risks are not in the viewer:
1. **`GET /v1/worlds/:id` does not return `floorplan_meta` today.** `serializeWorld` omits it.
2. **The importer has no `thumbnail` artifact kind.** `ArtifactKind` and `KEY_COLUMN` need it.
3. **The Docker image only ships `mock-outputs/`.** Both the `Dockerfile` and `.dockerignore` need the new demo-room set, or Railway dev never sees it.
4. **SDK 58 `web.output: "server"` is real per-request SSR** in the EAS Hosting worker runtime. Route modules (root layout, `/r/[slug]`) run on the server, and Spark's module-scope `WebAssembly.compile` must never load there. Load the viewer client-only.
5. **Presigned URLs change on every refetch.** If the world query refetches, `splatUrl` changes and the viewer reloads. Freeze the query.
6. **`@fastify/cors` registers `OPTIONS *` per scope.** The Better Auth scope already does this unprefixed, so the public CORS scope must use `prefix: '/v1/public'`.

**Primary recommendation:** Build the viewer as one `'use dom'` component wrapping a plain-TS engine (three + Spark + bvh), with all math in import-free pure modules tested in jest. Generate the demo room as a **binary 3DGS PLY in Y-up world coordinates** (about 80k gaussians, about 4.5 MB). Keep `web.output: "server"`, with a client-only viewer boundary on `/r/[slug]`. Do the six backend fixes above before any UI work.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Splat render, LoD, orbit/walk/measure, floor-plan overlay, WebGL context loss | Browser (DOM component / web page) | — | WebGL lives in the WebView or browser. Input loops must stay in-page (Pitfall 18: no RN round-trips) |
| Coordinate/affine/collision/recovery math | Browser (pure TS modules) | — | Imported by the DOM engine. Pure, so jest runs it on Windows |
| WebView process-kill detection + remount + saved pose | RN app shell | — | Only native sees the WebView's process die |
| Top bar, share sheet, `Share.share` | RN app shell | — | Native chrome (UI-SPEC A/D) |
| World fetch + asset presign (owner) | API (Fastify) | Storage (R2) | Existing `GET /v1/worlds/:id` |
| Share CRUD, password verify, open count, public presign | API (Fastify) | Database (Neon) | Trust boundary. Counting must be atomic in SQL |
| OG preview + noindex landing `/s/:slug` | API (Fastify, server HTML) | — | Crawlers don't run JS. Must be per-slug server HTML (D-20) |
| Web viewer page `/r/[slug]` | Frontend server (EAS Hosting SSR shell) | Browser | SSR renders only an empty shell. The viewer mounts client-side |
| Asset bytes + CORS + Range | CDN/Storage (R2) | — | Bytes never pass through the API or the bridge |
| Demo-room fixture generation | Build-time script (backend/scripts) | — | Committed output. The mock provider serves it |

## Standard Stack

### Core (app, new)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@sparkjsdev/spark` | 2.4.0 (published 2026-10-20, peer `three >=0.180.0`) | Gaussian splat renderer with built-in LoD | Locked (D-04). PLY/SPZ/SPLAT/KSPLAT/SOG/RAD loader, LoD budget. [VERIFIED: npm registry + package typings] |
| `three` | 0.187.0 | Scene, camera, OrbitControls, PLYLoader, Raycaster | Locked. Core has a CJS build (`build/three.cjs`), so jest can `require` it. Addons are ESM-only. [VERIFIED: npm registry `exports`] |
| `three-mesh-bvh` | 0.9.18 (2026-11-03, peer `three >= 0.159.0`) | BVH capsule collision + accelerated raycast | Locked. **Note: 0.10.0 was published today (2026-11-24). Stay on 0.9.18 as locked.** [VERIFIED: npm registry] |
| `@types/three` | 0.187.0 (dev) | Types | Matches three. [VERIFIED: npm registry] |

Already installed and reused: `@expo/dom-webview` 58.0.2 (default DOM WebView), `react-dom` 19.3.0, `@tanstack/react-query`, `expo-keep-awake`, `expo-router` 58, `react-native-safe-area-context`, `expo-symbols`.

### Backend
No new dependencies. Reuse what is installed: `@fastify/cors` 11.4.3, `@fastify/rate-limit` 10.3.0, `node:crypto` (`scrypt`, `randomBytes`, `timingSafeEqual`), `@aws-sdk/client-s3` (`PutBucketCorsCommand` for the R2 CORS script), drizzle-kit 0.31, and `ffmpeg` (local, already used by `make-tiny-session.ts`) for the demo-room PNG/JPEG.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Demo splat as PLY (Y-up) | SPZ (RDF, gzip) | SPZ would be about 1 MB and exercise the real Echo-3 default format's flip path. But Spark's SPZ codec is Rust/WASM (unreadable here), so a hand-written SPZ encoder can't be checked against a reference in this session. Rejected for risk. The SPZ flip path is covered by a jest test on `splatFrameFor(fileType)` instead |
| `.splat` (antimatter15, 32 B/gaussian) | — | No magic bytes, so it needs `fileType`. Echo-3 never emits it, so it tests nothing real |
| Own fetch + `fileBytes` (D-05) | Spark `url` + `onProgress`, or `stream`+`streamLength` | Own fetch keeps the bytes cached for context-loss rebuilds (D-13a) and gives exact percent. Keep D-05 |
| OrbitControls (three addon) | Spark `SparkControls`/`PointerControls` | OrbitControls is standard and has pinch/pan built in. Walk is custom anyway because of collision |

**Installation (inside `virtumetry/`):**
```bash
npx expo install three@0.187.0 @sparkjsdev/spark@2.4.0 three-mesh-bvh@0.9.18
npx expo install @types/three@0.187.0 -- --save-dev
# then hand-edit package.json to remove any ^/~ on these four (exact pins, D-04)
```
These are pure JS, so there's no native change and no dev-client build. They work in Expo Go.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| three | npm | >10 yrs | very high (not measured) | github.com/mrdoob/three.js | unavailable | Approved [ASSUMED], locked in CLAUDE.md |
| three-mesh-bvh | npm | >5 yrs | high (not measured) | github.com/gkjohnson/three-mesh-bvh | unavailable | Approved [ASSUMED], locked |
| @sparkjsdev/spark | npm | 2.x since Apr 2026 | not measured | github.com/sparkjsdev/spark | unavailable | Approved [ASSUMED], locked |
| @types/three | npm | >5 yrs | high | DefinitelyTyped | unavailable | Approved [ASSUMED] |

None of the four has a `postinstall` script (`npm view <pkg> scripts.postinstall` was empty). All four were already chosen in CLAUDE.md research from official docs.
**Packages removed:** none. **Flagged [SUS]:** none.
*slopcheck could not be installed, so every package is tagged `[ASSUMED]`. The planner should add one `checkpoint:human-verify` before the install task (one checkpoint covering all four is enough).*

## Architecture Patterns

### System Architecture Diagram

```
 OWNER (iPhone, Expo Go)                                   VISITOR (any browser)
 Library row (ready) ──tap──▶ /world/[id] (RN screen)       pastes https://API/s/<slug>
        │ react-query GET /v1/worlds/:id (staleTime ∞)              │
        ▼                                                             ▼
 Fastify: findOwnedWorld → presign assets (1 h) + floorplan_meta    Fastify GET /s/:slug ──▶ HTML: OG tags, noindex,
        │                                                             │   meta-refresh to WEB_SHARE_ORIGIN/r/<slug>
        ▼                                                             ▼  (crawlers stop here; no open count)
 <WorldViewer dom={{onContentProcessDidTerminate}} key=n …>         EAS Hosting SSR: /r/[slug] → empty shell
        │  (WebView, @expo/dom-webview)                               │ client: GET /v1/public/shares/:slug
        │                                                             │   404 → "no longer available"
        │                                                             │   needs_password → gate form
        │                                                             │ POST /v1/public/shares/:slug/open {pw}
        │                                                             │   scrypt verify → UPDATE open_count+1 RETURNING
        │                                                             │   → presigned URLs (15 min) + floorplan_meta
        ▼                                                             ▼
 ┌──────────────────────── viewer engine (same code both sides) ─────────────────────────┐
 │ fetch(splatUrl) stream → bytes counted → onProgress(%) ──▶ R2 (CORS GET/HEAD, Range)    │
 │ getSplatFileType(bytes): SPZ → rotate 180°X ; PLY → Y-up (bounds check vs scene_bounds) │
 │ SplatMesh({fileBytes, lod:true}) + SparkRenderer({lodSplatCount}) → first frame→onReady │
 │ fetch(colliderUrl) → PLYLoader → frame check → MeshBVH  ─┬─ walk: capsule shapecast    │
 │                                                          └─ measure: raycast firstHit  │
 │ fetch(camerasUrl) → frames[0] → T_three = F·inv(C)·F → start pose / Reset              │
 │ floorplanMeta + floorplanUrl → panel; dot = pixel_from_world_xz(cam.x, cam.z)          │
 │ webglcontextlost → preventDefault → rebuild from cached bytes │ onPose (≤2 Hz) → native│
 └───────────────────────────────────────────────────────────────────────────────────────┘
 Native: process terminated → recovery.ts reducer → key++ with startPose=lastPose (cap 3/60 s → Reload)
```

### Recommended Project Structure
```
virtumetry/src/
├── app/world/_layout.tsx          # Stack, headerShown:false (inside the auth guard)
├── app/world/[id]/index.tsx       # RN viewer screen (top bar, recovery overlay)
├── app/world/[id]/share.tsx       # share sheet modal
├── app/r/[slug].tsx               # public web page (outside the guard)
├── viewer/world-viewer.tsx        # 'use dom' — React shell + overlays, owns <canvas>
├── viewer/engine.ts               # three/Spark/bvh imperative engine (create/dispose/rebuild)
├── viewer/walk.ts                 # capsule resolve (three + bvh, jest-testable)
├── viewer/coords.ts               # F, OpenCV→three, frame detection   (no imports)
├── viewer/floorplan.ts            # affine apply/invert, heading → pixel (no imports)
├── viewer/measure.ts              # distance + "≈ 2.41 m (approx.)"     (no imports)
├── viewer/recovery.ts             # crash reducer                       (no imports)
├── viewer/progress.ts             # streamed fetch with byte counting   (fetch only)
├── viewer/tokens.ts               # UI-SPEC VT literals                  (no imports)
└── lib/shares.ts                  # react-query hooks for share CRUD + public calls
backend/
├── scripts/make-demo-room.ts      # generator (ffmpeg for PNG/JPEG, like make-tiny-session)
├── test/fixtures/demo-room/       # splat.ply collider.ply floorplan.png floorplan.json cameras.json thumbnail.jpg
├── scripts/r2-cors-dev.mjs        # PutBucketCors on virtumetry-dev (assertDevBucket)
└── src/routes/share.ts            # owner + public + /s/:slug landing
```

### Pattern 1: DOM component with crash hooks and a stable remount key
**What:** The RN screen owns the `key` and the saved pose. The DOM component gets only serializable props and async native actions.
**Example:**
```tsx
// Source: verified in node_modules/expo/src/dom/webview-wrapper.tsx (spreads `dom` onto the WebView)
// and node_modules/@expo/dom-webview/src/DomWebView.types.ts (event names)
<WorldViewer
  key={recovery.mountKey}
  splatUrl={assets.splat_url} colliderUrl={assets.collider_url}
  floorplanUrl={assets.floorplan_url} floorplanMeta={world.floorplan_meta}
  camerasUrl={assets.cameras_url} startPose={recovery.savedPose} title={title}
  insets={{ top: insets.top + 44, bottom: insets.bottom }}
  onReady={async () => dispatch({ type: 'ready' })}
  onError={async (e) => dispatch({ type: 'error', code: e.code })}
  onPose={async (p) => dispatch({ type: 'pose', pose: p })}
  onProgress={async () => {}}
  dom={{
    onContentProcessDidTerminate: () => dispatch({ type: 'crash', at: Date.now() }), // iOS
    onRenderProcessGone: () => dispatch({ type: 'crash', at: Date.now() }),          // Android
    scrollEnabled: false,
  }}
/>
// In world-viewer.tsx: `export default function WorldViewer(props: Props & { dom?: import('expo/dom').DOMProps })`
```
Native actions must be top-level async function props with serializable arguments only. Any prop change re-renders the whole DOM React tree [CITED: docs.expo.dev/guides/dom-components]. Create the engine in a `useEffect` keyed only on `splatUrl` identity, and keep the other props in refs.

### Pattern 2: Honest progress then `fileBytes`
```ts
// viewer/progress.ts — Source: Spark SplatMeshOptions typings (fileBytes, fileType, onLoad)
export async function fetchWithProgress(url: string, onPct: (p: number | null) => void, signal?: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw Object.assign(new Error(`fetch ${res.status}`), { status: res.status });
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length; onPct(total ? Math.floor((got / total) * 100) : null); }
  const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out; // fresh buffer at offset 0: Spark's getSplatFileType reads new DataView(bytes.buffer)
}
// engine.ts
const type = getSplatFileType(bytes);                 // 'ply' | 'spz' | … (magic bytes)
const splat = new SplatMesh({ fileBytes: bytes, lod: true });
if (type === SplatFileType.SPZ) splat.quaternion.set(1, 0, 0, 0); // 180° about X: RDF → Y-up
await splat.initialized;                               // then render one frame → onReady
const spark = new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT }); scene.add(spark);
```
Clamp the percent shown to 99 until `done` (UI-SPEC: never show 100% early). Floor rounding already does this unless `got === total`.

### Pattern 3: Coordinates (one place, pure, D-08 / Pitfall 19)
```ts
// viewer/coords.ts — Source: docs.spaitial.ai/api/llm-skills + /api/exports
// F = diag(1,-1,-1,1). It is its own inverse.
// splat(RDF) → world(Y-up):           p_w = F · p_s            (only for SPZ / RDF files)
// camera_from_world (OpenCV cam):    C_w = camera_from_splat · F     (SpAItial doc formula)
// three camera matrixWorld (GL cam): T  = inv(C_w) · F = F · inv(camera_from_splat) · F
// Demo-room generator (inverse):     camera_from_splat = F · inv(T) · F   (round-trip jest test)
```
Frame detection for PLY/SOG splats and the collider (LOW-confidence area): compute the mesh AABB. If it overlaps `floorplan_meta.scene_bounds` better after `(x,-y,-z)` than as-is, apply the rotation. With no `scene_bounds`, assume Y-up for PLY and RDF for SPZ. This is a pure function `needsFlip(bbox, sceneBounds): boolean`, with a jest test.

### Pattern 4: Capsule walk (three-mesh-bvh official recipe, horizontal only)
```ts
// Source: github.com/gkjohnson/three-mesh-bvh/blob/v0.9.18/example/characterMovement.js
// walk.ts: segment from (x, floorY + 0.5, z) to (x, eyeY - 0.1, z), radius 0.25.
// The bottom sits 0.25 m above the floor, so floor triangles never push.
bvh.shapecast({
  intersectsBounds: (box) => box.intersectsBox(capsuleBox),
  intersectsTriangle: (tri) => {
    const d = tri.closestPointToSegment(seg, triPt, capPt);
    if (d < radius) { const dir = capPt.sub(triPt).normalize(); dir.y = 0; // horizontal only (D-09)
      if (dir.lengthSq() > 0) { dir.normalize().multiplyScalar(radius - d); seg.start.add(dir); seg.end.add(dir); } }
  },
});
// Clamp dt ≤ 0.05 s. Max speed 2.8 m/s (Shift) → ≤ 14 cm/step < radius, so no tunnelling.
```
Floor Y comes from a downward raycast against the collider at the camera's XZ. Fall back to `scene_bounds.min[1]`, then 0. Eye = floorY + 1.6. Teleport uses the same raycast, then 3 resolve iterations to push out.

### Pattern 5: Measure raycast without rendering the collider
```ts
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
geom.computeBoundsTree(); const collider = new THREE.Mesh(geom); collider.updateMatrixWorld(); // NOT added to scene
raycaster.firstHitOnly = true; raycaster.setFromCamera(ndc, camera);
const hit = raycaster.intersectObject(collider)[0]; // undefined → "Tap on a surface" hint
```
Markers, line and label go in a DOM overlay. Each frame, project the points with `vector.project(camera)`. That gives screen-space sizes for free (UI-SPEC B7).

### Pattern 6: Floor plan affines
```ts
// floorplan.ts — [x, z, 1] = world_xz_from_pixel · [px, py, 1]  (row-major, continuous pixel coords,
// top-left pixel centre = (0.5, 0.5)) — Source: docs.spaitial.ai/api/exports
// tap: px = offsetX * width_px / img.clientWidth; py = offsetY * height_px / img.clientHeight  (no +0.5)
// dot: [px,py] = pixel_from_world_xz · [cam.x, cam.z, 1]
// heading: dir_px = linear part (a b; c d) of pixel_from_world_xz · (fwd.x, fwd.z); angle = atan2(dir_px.y, dir_px.x)
```
Do not validate the `projection` string strictly. The docs say `"orthographic-top-down"`, but the existing mock fixture writes `"orthographic_top_down"`.

### Pattern 7: Fastify public scope (CORS + per-route limits)
```ts
// routes/share.ts — verified: @fastify/cors registers fastify.options('*') per scope (index.js:78);
// auth-handler.ts already registers cors unprefixed, so a second unprefixed one collides on OPTIONS *.
await app.register(async (pub) => {
  await pub.register(cors, { origin: [config.WEB_SHARE_ORIGIN, ...(isProd ? [] : ['http://localhost:8081'])],
                             methods: ['GET', 'POST'] });
  pub.get('/shares/:slug', { config: { rateLimit: { max: 60, timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (r: FastifyRequest) => `pub:${r.ip}` } } }, handler);
  pub.post('/shares/:slug/open', { config: { rateLimit: { max: 20, /* … */ } } }, openHandler);
}, { prefix: '/v1/public' });
// /s/:slug landing: registered at root, unauthenticated, rateLimit 120/min/IP, reply.type('text/html; charset=utf-8')
//   .header('X-Robots-Tag', 'noindex, nofollow'). The global limiter (preHandler, per-IP 600) still applies.
```
The per-route `config.rateLimit` override is the pattern already used in `webhooks.ts`. Wrong-password brute force: a `FailureThrottle` keyed by `slug` (e.g. 10 failures / 15 min), checked before scrypt. When blocked, return `429 rate_limited` (UI-SPEC copy exists).

### Pattern 8: Password hashing (node:crypto, no deps)
```ts
const N = 16384, r = 8, p = 1, KEYLEN = 32;
// scrypt is promisified; store 'scrypt$16384$8$1$<salt b64url>$<hash b64url>'
const salt = randomBytes(16); const hash = await scryptAsync(pw, salt, KEYLEN, { N, r, p });
// verify: parse params from the stored string, recompute, timingSafeEqual(equal-length buffers)
```
[CITED: nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback]. The defaults are N=16384, r=8, p=1, which stays within the default `maxmem` of 32 MiB.

### Pattern 9: Atomic open (SHARE-02/05)
```ts
// 1) SELECT share + world WHERE slug=$1 AND revoked_at IS NULL AND worlds.status='ready' AND worlds.deleted_at IS NULL
// 2) verify password (if password_hash)
// 3) UPDATE share_slugs SET open_count = open_count + 1, last_opened_at = now()
//    WHERE id=$id AND revoked_at IS NULL RETURNING open_count   — 0 rows → 404 (revoked mid-request)
```
In drizzle, write the increment as `sql\`${shareSlugs.openCount} + 1\``. All four public 404 causes return a byte-identical body, such as `{ error: 'share_not_found' }`.

### Pattern 10: Client-only viewer on the SSR web route
SDK 58 `output: "server"` renders routes per request [CITED: docs.expo.dev/router/web/server-rendering]. Spark runs `WebAssembly.compile(...)` at module load (verified, `spark.module.js` line 2925). Worker-style runtimes often forbid runtime WASM compilation (ASSUMED for the EAS Hosting runtime), and three expects a DOM. So:
```tsx
// app/r/[slug].tsx — never import world-viewer statically here
const WorldViewer = lazy(() => import('@/viewer/world-viewer'));
const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), []);
// render <Suspense>{mounted && opened && <WorldViewer …/>}</Suspense>
```
On native, `world/[id]/index.tsx` imports the DOM component statically (that's how DOM components work).

The root layout: today it returns `null` while `authClient.useSession()` is pending, and calls the API cross-origin on web, which is blocked (auth CORS is `origin: false`). Split it into `PublicLayout`/`AuthedLayout` by `Platform.OS === 'web' && segments[0] === 'r'`, so `/r/*` never mounts the session hook or the upload manager. Declare `<Stack.Screen name="r/[slug]" />` outside both `Stack.Protected` groups, and `<Stack.Screen name="world" />` inside the signed-in group.

### Anti-Patterns to Avoid
- **Passing `floorplanMeta` / pose objects that change identity every render:** every prop change re-renders the DOM tree. Memoize.
- **Letting react-query refetch the world:** the presigned URLs change and the viewer reloads mid-walk. Use `staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false`. Key the engine on `world.id + asset_version`, not the URL string.
- **Adding the collider mesh to the scene** (it would render over the splat). Raycast it directly.
- **Importing `constants/theme.ts` in the DOM component:** it imports `react-native` and `global.css` (UI-SPEC). Use `tokens.ts`.
- **`renderer.setPixelRatio(devicePixelRatio)` on iPhone (3x):** cap at 2, or lower if FPS is poor. That alone is about 2.25x fewer pixels.
- **Using `raw_image` affines with the cleaned `floorplan.png`:** we store `image`, so use `image` affines.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Splat rendering / sorting / LoD | custom WebGL splatter | Spark `SplatMesh` + `SparkRenderer` | Sorting, SH, LoD tree in a worker |
| Mesh collision / raycast acceleration | brute-force triangle loops | three-mesh-bvh `MeshBVH.shapecast`, `acceleratedRaycast` | Real Echo-3 colliders have 100k+ tris |
| PLY mesh parsing | own parser | `three/addons/loaders/PLYLoader.js` | ascii/binary, `vertex_indices` variants |
| Orbit/pinch/pan | gesture math | `three/addons/controls/OrbitControls.js` | Touch handled |
| Password KDF | sha256(pw) | `crypto.scrypt` | Memory-hard, stdlib |
| Slugs | uuid / Math.random | `randomBytes(16).toString('base64url')` | 128-bit, URL-safe, 22 chars |
| Rate limiting | counters in routes | `@fastify/rate-limit` per-route config + existing `FailureThrottle` | Already wired |
| HTML escaping in the landing page | ad-hoc replace in places | one `esc()` helper (`& < > " '`) used for every interpolation | Title is user-controlled (XSS) |
| Crash detection | polling the WebView | `onContentProcessDidTerminate` / `onRenderProcessGone` | Exposed by `@expo/dom-webview` |

**Key insight:** The only custom math this phase needs is coordinate/affine/collision glue. Keep it in pure modules with fixture-driven tests, and the hard parts stay inside libraries.

## Common Pitfalls

### Pitfall 1: `floorplan_meta` never reaches the app
**What goes wrong:** The Plan panel has no affines. `serializeWorld` does not include `floorplanMeta`, which is stored by the importer (`pipeline.ts:402`) but never returned.
**How to avoid:** Add `floorplan_meta: w.floorplanMeta` to the `GET /v1/worlds/:id` response only (not the list). Test it.

### Pitfall 2: Thumbnail never imported
**What goes wrong:** The mock emits `thumbnail.jpg`, but `ArtifactKind` has no `'thumbnail'` and `KEY_COLUMN` has no `thumbnailKey`. The file is uploaded, but `thumbnail_key` stays NULL, so there's no Library thumbnail and no OG image.
**How to avoid:** Add `'thumbnail'` to `ArtifactKind`. Add `thumbnail: 'thumbnailKey'` to `KEY_COLUMN` and widen the `keys` type. Add a pipeline test asserting `thumbnail_key` is set.

### Pitfall 3: Demo room missing from the Railway image
**What goes wrong:** The Dockerfile copies only `backend/test/fixtures/mock-outputs`, and `.dockerignore` re-includes only that folder. With `MOCK_OUTPUTS_SET=demo-room`, the worker's `createReadStream` throws ENOENT, so import fails and the world is never ready.
**How to avoid:** Add `COPY --chown=node:node backend/test/fixtures/demo-room ./test/fixtures/demo-room` and `!backend/test/fixtures/demo-room`. Extend `test/docker-mock-outputs.test.ts`. Set the env var on the Railway dev **worker** (the importer) and the api service. Note that `*.md` is dockerignored, so a README in the folder is fine.

### Pitfall 4: SSR evaluates the viewer
**What goes wrong:** `npx expo export --platform web` or the EAS Hosting worker loads `world-viewer`, which loads Spark and runs `WebAssembly.compile` (plus `window` access) on the server. Expect a crash or unhandled rejection.
**How to avoid:** Pattern 10. Verify locally with a Wave 0 web export + `npx expo serve` smoke test on `/r/test` (no deploy, no quota).

### Pitfall 5: Web export has no API URL
**What goes wrong:** `config/api.ts` throws at import (`EXPO_PUBLIC_API_URL is required`). `expo export` runs with NODE_ENV=production, so `@expo/env` loads `.env.production`/`.env`, not `.env.development` (verified, `@expo/env` getEnvFiles). It also never overrides variables already in `process.env`.
**How to avoid:** Add the script `"web:export:dev": "node --env-file=.env.development node_modules/expo/bin/cli export --platform web"` (cross-platform, no `cross-env`). Then run `npx eas-cli@latest deploy --alias dev`, which gives the stable origin `https://<subdomain>--dev.expo.app` [CITED: docs.expo.dev/eas/hosting/deployments-and-aliases]. Set that as `WEB_SHARE_ORIGIN` on Railway dev.

### Pitfall 6: CORS blocks the native viewer too, not just web
**What goes wrong:** In Expo Go dev, the DOM component is served from Metro (`http://<LAN-IP>:8081`), so its `fetch` to R2 presigned URLs is cross-origin. An R2 CORS list of only the share origin + localhost blocks the owner's own viewer on the phone.
**How to avoid:** On **virtumetry-dev** only, allow `AllowedOrigins: ["*"]` for `GET`/`HEAD`. CORS is not access control for presigned GETs (the URL is the bearer secret). The alternative is a LAN pattern such as `http://192.168.*:8081` (R2 allows one `*` per origin pattern, no port wildcards [CITED: developers.cloudflare.com/r2/buckets/cors]). Either way, list `Range` in AllowedHeaders and expose `Content-Range, Accept-Ranges, Content-Length, ETag`. CORS propagation can take up to 30 s.

### Pitfall 7: R2 CORS script fails on permissions or checksums
**What goes wrong:** `PutBucketCors` is implemented in R2's S3 API, but checksum headers are not [CITED: developers.cloudflare.com/r2/api/s3/api]. The backend's R2 token may also be object-scoped, which can't change bucket settings.
**How to avoid:** Script `backend/scripts/r2-cors-dev.mjs` (calls `assertDevBucket()`, then `PutBucketCorsCommand`, then `GetBucketCorsCommand` to print the result). Documented fallback: dashboard JSON (R2 > bucket > Settings > CORS Policy) or `npx wrangler r2 bucket cors set virtumetry-dev --file cors.json`. This is a one-time owner step. Mark it `checkpoint:human-action` if the script returns AccessDenied.

### Pitfall 8: Double `@fastify/cors` registration
**What goes wrong:** `FST_ERR_DUPLICATED_ROUTE` on `OPTIONS *` at boot, when AUTH_MODE=session.
**How to avoid:** Use a prefixed scope (Pattern 7). The boot test must build the server with AUTH_MODE=session.

### Pitfall 9: Upside-down or mirrored room (Pitfall 19 in research)
**What goes wrong:** The `.planning/research/PITFALLS.md` line "SPZ, SOG and PLY are RDF" contradicts current SpAItial docs, which say converted `.ply`/`.sog` are Y-up and only raw `.spz` is RDF.
**How to avoid:** Pick the flip from the detected file type plus the bounds check, in one function. The demo room's floor (Y=0), its doorway and an asymmetric obstacle make a flip or mirror obvious on sight. Test `T_three` handedness (det = +1).

### Pitfall 10: Collision against floor triangles stalls walking
**What goes wrong:** If the capsule reaches the floor, floor triangles push it up and sideways, and the walker jitters or gets stuck.
**How to avoid:** Keep the capsule bottom above the floor (Pattern 4) and zero the Y of every push.

### Pitfall 11: Presigned URL expiry after context loss on web
**What goes wrong:** Public URLs live 15 min. A context loss after that is fine because bytes are cached in the engine (D-13a), but a full page reload re-opens. A native remount on the app uses the 1 h owner URLs.
**How to avoid:** Rebuild from cached bytes, never re-fetch. On web, a 403 means re-calling `open` once (UI-SPEC F). Expired R2 403s carry no CORS headers, so JS sees a network error, not a 403. Treat any fetch failure after an `open` older than 14 min as "re-open once".

### Pitfall 12: Bundle size in the WebView
**What goes wrong:** Spark is about 3 MB (base64 WASM inline) plus three at about 0.7 MB. Parse time is noticeable on first open.
**How to avoid:** Accept it. Show the RN `ActivityIndicator` until the DOM's first `onProgress`. Don't import three addons you don't use.

## Code Examples

### Demo-room generator outline (D-01, all coordinates spaitial-world-v1, Y-up, metres)
```ts
// backend/scripts/make-demo-room.ts — deterministic (seeded PRNG), writes test/fixtures/demo-room/
// Room: x ∈ [-2, 2], z ∈ [-2.5, 2.5], floor y=0, walls to y=2.5, doorway 0.9 m wide x 2.1 m high in the z=+2.5 wall,
// obstacles: table box [0.4..1.4]x[0..0.75]x[-1.5..-0.7], cabinet [-1.9..-1.4]x[0..1.8]x[0.5..1.5].
// splat.ply: binary_little_endian 3DGS, 14 float props (x y z f_dc_0..2 opacity scale_0..2 rot_0..3, rot_0 = w)
//   — same header as make-tiny-session.ts. ~80k samples on floor/walls/obstacle faces (~1000/m²).
//   f_dc = (rgb - 0.5) / 0.28209479; opacity = logit(0.95); scale = ln(0.02) in-plane, ln(0.004) along the normal;
//   rot = quaternion turning local z onto the face normal. 80k × 56 B ≈ 4.5 MB (≤ 5 MB, D-01).
//   Colour cues: checkerboard floor, one distinct colour per wall, so mirroring is visible.
// collider.ply: ascii, boxes as 12-tri cuboids (floor slab, 4 walls split around the doorway, obstacles), ≈ 150 tris.
// floorplan.png: 0.02 m/px raster of the cut at y = 1.0 (walls dark, obstacles mid-grey, floor light), via ffmpeg rawvideo→png.
// floorplan.json: same schema as mock-outputs + exact inverse affines; scene_bounds = room AABB.
// cameras.json: spaitial.capture_cameras.v1, coordinate_system 'opencv', ~24 frames along a loop at 1.5 m height,
//   camera_from_splat = F · inv(T_three) · F  with the splat frame = RDF (x, -y, -z) of the world, per SpAItial convention.
//   NOTE: the PLY itself is Y-up (as current Echo-3 .ply). camera_from_splat is defined against RAW splat (RDF) coords
//   per the docs, so it uses F even when the PLY file is already Y-up.
// thumbnail.jpg: 1200x630 render (floorplan raster letterboxed with room colours) via ffmpeg → jpg.
```

### Landing HTML (D-20, UI-SPEC G)
```ts
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
reply.header('X-Robots-Tag', 'noindex, nofollow').type('text/html; charset=utf-8')
  .header('Cache-Control', 'no-store').send(html);  // no-store: revocation shows up at once
```
`og:image` recommendation: point it at a stable backend route `GET /s/:slug/og.jpg`. That route streams `storage.getStream(thumbnailKey)` with the same validity checks, so revocation also kills the preview image and nothing expires. This is a small deviation from D-20's "presigned thumbnail with long TTL". If the planner prefers the literal D-20, R2 presigns cap at 7 days [ASSUMED from earlier research ARCHITECTURE.md]. Password-protected links omit `og:image` (UI-SPEC).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `react-native-webview` for DOM components | `@expo/dom-webview` default | SDK 56 | Crash events are on the default WebView. No install needed |
| SDK ≤57 `output: "server"` = static pages + API routes | SDK 58 `output: "server"` = per-request SSR | SDK 58 | Dynamic `/r/[slug]` works on EAS Hosting. Viewer must be client-only |
| `<Head>` for initial meta | `generateMetadata()` export (SDK 58) / `pageHeaders` in the expo-router plugin config | SDK 58 | Use `pageHeaders: [{ source: '/r/[slug]', headers: { 'X-Robots-Tag': 'noindex, nofollow' } }]` (web-only config, no native rebuild) plus `<Head>` robots meta |
| `@mkkellogg/gaussian-splats-3d` | Spark 2.x with LoD | 2025-26 | — |

## Runtime State Inventory
Not a rename/refactor phase, so this section is omitted. New runtime state this phase creates (for the planner's checklist): Railway dev env vars `MOCK_OUTPUTS_SET=demo-room`, `WEB_SHARE_ORIGIN`, `PUBLIC_BASE_URL` (the API https URL; today it is only used by the local storage driver and defaults to localhost); R2 virtumetry-dev bucket CORS policy; Neon dev migration 0004; an EAS Hosting deployment + `dev` alias.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The Echo-3 `mesh-simplified` collider is in the same frame as the matching splat (Y-up for ply/sog, RDF for raw spz). Docs don't say | Pattern 3 | Collider offset or flipped. Mitigated by the bounds heuristic, which needs real-output confirmation in Phase 6 |
| A2 | EAS Hosting's worker runtime can't safely evaluate Spark at module load | Pattern 10 | Low: the client-only boundary is correct either way |
| A3 | Expo Go SDK 58 ships `@expo/dom-webview` with `onContentProcessDidTerminate` wired (verified in node_modules 58.0.2, not inside the Expo Go binary) | Pattern 1 | Native layer can't detect the kill. The WebGL layer + manual Reload still cover it |
| A4 | Messaging crawlers (iMessage, WhatsApp, Slack) follow `/s/:slug` OG tags and fetch `og:image` from a backend route | Code Examples | Preview missing image. Fallback: presigned 7-day URL |
| A5 | R2 presign max is 7 days | Code Examples | Only matters if the literal D-20 presigned og:image is chosen |
| A6 | The backend R2 token can't set bucket CORS (object-scoped) | Pitfall 7 | None: the script just works |
| A7 | 80k gaussians render smoothly at DPR 2 on iPhone 17 Pro in WKWebView | Demo room | Lower the count. Easily tuned |
| A8 | All four npm packages are legitimate (slopcheck unavailable) | Audit | Locked in CLAUDE.md from official sources. Human-verify checkpoint |

## Open Questions

1. **Does the full app web export succeed under SSR?** (capture screens, `expo-camera`, `expo-file-system`, SecureStore)
   - What we know: native modules there are used lazily (no module-scope native calls found). `ExpoSecureStore.web.js` is an empty object, and `expoClient` skips storage on web.
   - Unclear: whether any imported module touches native APIs during SSR route-tree evaluation.
   - Recommendation: a Wave 0 task runs `npm run web:export:dev` + `npx expo serve`, curls `/r/x`, and loads it in a browser. Add `.web.tsx` stubs only for the modules that fail (D-19).
2. **LoD budget constant.**
   - Recommendation: `LOD_SPLAT_COUNT = 1_000_000` when `process.env.EXPO_DOM_HOST_OS === 'ios'` (below Spark's 1.5M iOS default, a conservative choice per D-06), otherwise undefined (Spark defaults). Tune on device.
3. **Should the viewer also use `lod: true` for the 80k demo splat?**
   - Yes, so the LoD path is exercised. The build cost is about 1-3 s per 1M splats, so negligible here [CITED: sparkjs.dev/docs/lod-getting-started].

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | scripts/tests | yes | 22.21.1 locally (backend `engines >=24`; Docker is node 24) | Existing tests already run on 22. `--env-file` needs ≥20.6 |
| ffmpeg | make-demo-room (PNG/JPEG) | yes | 8.1.2 | Write the PNG with zlib + `zlib.crc32` (available on Node 22) |
| npm | installs | yes | 10.9.4 | — |
| expo CLI (local) | web export | yes | node_modules/.bin/expo | — |
| eas-cli | `eas deploy` | not global | via `npx eas-cli@latest` | — |
| wrangler | R2 CORS fallback | no | — | Dashboard JSON, or `npx wrangler` |
| Neon dev / TEST_DATABASE_URL | pg tests | via `backend/.env` (not printed) | — | pg suites `skipIf(!url)` |
| slopcheck | package audit | no | — | `[ASSUMED]` + human-verify |

**Missing with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (app) | jest 30.5 + jest-expo 58 + @testing-library/react-native 14 (`virtumetry/package.json` "jest") |
| Framework (backend) | vitest 2.1 (`backend/vitest.config.ts`, `test/**/*.test.ts`, 30 s timeout) |
| Quick run (app) | `cd virtumetry && npx jest src/__tests__/viewer-` |
| Quick run (backend) | `cd backend && npx vitest run test/share.test.ts test/demo-room.test.ts` |
| Full suite | `cd virtumetry && npx jest --ci && npx tsc --noEmit && npx expo lint` ; `cd backend && npm test && npm run typecheck && npm run test:pg` |

Jest notes:
- Pure modules (`coords`, `floorplan`, `measure`, `recovery`, `tokens`) import nothing, so no config change is needed.
- `walk.test.ts` imports `three` (CJS `require` export) and `three-mesh-bvh` (`require` → `build/index.umd.cjs`). These should load without transforms. If jest still complains about ESM, add `three|three-mesh-bvh` to `transformIgnorePatterns`.
- Never import Spark or `three/addons/*` in jest.
- Screen tests use `jest.mock('@/viewer/world-viewer', () => (props) => <View testID="world-viewer" {...captured} />)`.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VIEW-01 | Progress: percent monotonic, floors, null without Content-Length; world screen passes splat URL + floorplan_meta to viewer; query not refetched | unit + RNTL | `npx jest src/__tests__/viewer-progress.test.ts src/__tests__/world-screen.test.tsx` | ❌ Wave 0 |
| VIEW-01 | `GET /v1/worlds/:id` includes `floorplan_meta` | vitest | `npx vitest run test/worlds.detail.test.ts` (or pg ownership suite) | ❌ |
| VIEW-01/02 | Smooth orbit, sensible start, Reset on device | manual (owner UAT, iPhone 17 Pro + desktop) | — | manual |
| VIEW-02 | `T_three = F·inv(C)·F` round-trip with generator; det = +1; first demo camera inside room looking inward; bounds fallback pose | unit | `npx jest src/__tests__/viewer-coords.test.ts` | ❌ |
| VIEW-03 | Walking into a BoxGeometry wall stops at `radius` from it; sliding along the wall keeps tangential motion; floor never pushes Y | unit | `npx jest src/__tests__/viewer-walk.test.ts` | ❌ |
| VIEW-04 | Affine apply/invert round-trip on mock + demo meta; tap px→world; heading angle; teleport target inside room | unit | `npx jest src/__tests__/viewer-floorplan.test.ts` | ❌ |
| VIEW-05 | Distance + format "≈ 2.41 m (approx.)", 2 decimals, < 0.10 m case | unit | `npx jest src/__tests__/viewer-measure.test.ts` | ❌ |
| VIEW-06 | Reducer: crash → remount with saved pose and key+1; 4th crash in 60 s → capped; Reload resets; old crashes age out | unit | `npx jest src/__tests__/viewer-recovery.test.ts` | ❌ |
| VIEW-06 | Process kill / context loss on device | manual (Safari Web Inspector `WEBGL_lose_context`; background the app under memory pressure) | — | manual |
| SHARE-01 | Create (ready only, 409/400 for non-ready), slug `/^[A-Za-z0-9_-]{22}$/`, foreign world 404, list, public open returns presigned assets | vitest pg | `npm run test:pg -- test/integration/share.pg.test.ts` | ❌ |
| SHARE-01 | Web route: spinner → viewer; 404 copy; password gate | RNTL | `npx jest src/__tests__/share-web-route.test.tsx` | ❌ |
| SHARE-02 | Revoke idempotent; public GET/open 404 immediately after; deleted/not-ready world 404 with identical body | vitest pg | same share.pg suite | ❌ |
| SHARE-03 | `/s/:slug` has og:title/description/image, robots meta + `X-Robots-Tag`, escaped title, no og:image for password links, 404 page noindex, open_count unchanged | vitest pg | same | ❌ |
| SHARE-03 | Mock emits thumbnail; importer sets `thumbnail_key`; `MOCK_OUTPUTS_SET` enum validated and selects dir; demo-room fixture valid (≤ 5 MB, PLY count, affines inverse, cameras in bounds) | vitest | `npx vitest run test/provider/mock-outputs-set.test.ts test/demo-room.test.ts test/docker-mock-outputs.test.ts` | ❌ / extend |
| SHARE-04 | password_required (401), wrong_password (401), right (200), throttle → 429, hash format `scrypt$` | vitest (unit for hash, pg for routes) | `npx vitest run test/share-password.test.ts` + pg suite | ❌ |
| SHARE-05 | open_count +1 per successful open, not on wrong password, not on landing; share sheet shows counts, optimistic revoke rollback | vitest pg + RNTL | pg suite + `npx jest src/__tests__/share-sheet.test.tsx` | ❌ |
| infra | Migration journal lists `0004_*` | vitest | `npx vitest run test/migrate-folder.test.ts` (update expected tags) | extend |
| infra | Server boots with AUTH_MODE=session + public CORS scope (no duplicate OPTIONS route); preflight from WEB_SHARE_ORIGIN allowed, others not | vitest | `npx vitest run test/share-cors.test.ts` | ❌ |

### Sampling Rate
- **Per task commit:** the quick jest/vitest file(s) for that task, plus `npx tsc --noEmit` (app) or `npm run typecheck` (backend)
- **Per wave merge:** full app jest + lint + tsc; backend `npm test` + `npm run test:pg`
- **Phase gate:** everything green, plus the local web export smoke test, before `/gsd:verify-work`. On-device UAT covers orbit smoothness, walk feel and crash recovery.

### Wave 0 Gaps
- [ ] Install the viewer trio (exact pins) after the human-verify checkpoint
- [ ] `virtumetry/package.json` script `web:export:dev`; one local `export` + `expo serve` smoke test on `/r/x` (answers Open Question 1)
- [ ] Backend: `0004` migration + `migrate-folder.test.ts` expected list
- [ ] Backend: `test/helpers` reuse (`createTestSchema`, `buildSessionApp`, `seedOwner`, `signIn`) for `share.pg.test.ts`. A ready world is seeded by direct insert with asset keys (see `ownership.pg.test.ts`)
- [ ] `config.ts`: `MOCK_OUTPUTS_SET` (enum `['default','demo-room']`, default `'default'`), `WEB_SHARE_ORIGIN` (https required when `RAILWAY_ENVIRONMENT_ID` or prod; http://localhost allowed locally) + `config.test.ts` cases

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (share passwords) | `crypto.scrypt` (N=16384,r=8,p=1, 16-byte salt), `timingSafeEqual`, per-slug FailureThrottle + per-IP rate limit |
| V3 Session Management | no new sessions | Password unlock is per request (password kept in tab memory only; UI-SPEC F). No cookie set |
| V4 Access Control | yes | Owner routes through `findOwnedWorld` (404 for others); public routes only via slug + validity join; asset access only via short presigned URLs |
| V5 Input Validation | yes | zod: slug `/^[A-Za-z0-9_-]{22}$/` (reject before DB), password 4-64 chars, `:shareId` uuid |
| V6 Cryptography | yes | `randomBytes(16)` slugs; scrypt; no hand-rolled crypto |
| V7 Error handling / info leak | yes | Identical 404 body for missing/revoked/not-ready/deleted. Existing error handler hides 5xx details |
| V14 Config | yes | `X-Robots-Tag`, `noindex`, `Cache-Control: no-store` on landing; CORS scoped to `/v1/public` |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Slug enumeration | Information disclosure | 128-bit slug + per-IP limit + identical 404s |
| Password brute force | Spoofing | FailureThrottle per slug + 20/min/IP on `open` + scrypt cost |
| XSS via world title in landing HTML / OG | Tampering | Escape every interpolation. Title is already validated 1-80 chars |
| Open redirect via landing | Tampering | Redirect target built only from config `WEB_SHARE_ORIGIN` + validated slug |
| Preview leaks interior of password room | Information disclosure | Omit `og:image` for password links (UI-SPEC) |
| Revoked link still downloads | Elevation | Presigned TTL 15 min, documented. No new URLs after revoke |
| Open-count inflation | Tampering (minor) | Rate limit only. Counts are informational (dedupe deferred) |
| Timing difference between wrong password and missing link | Information disclosure | Missing → 404 before scrypt is fine (the slug is the secret); wrong → 401 after scrypt |

## Sources

### Primary (HIGH confidence)
- npm registry (`npm view`, 2026-11-24): spark 2.4.0, three 0.187.0, three-mesh-bvh 0.9.18 / 0.10.0, @types/three 0.187.0; peers, exports, no postinstall
- `@sparkjsdev/spark@2.4.0` tarball typings (`SplatMesh.d.ts`, `SparkRenderer.d.ts`, `defines.d.ts`, `SplatLoader.d.ts`) and `spark.module.js` (`getSplatFileType`, module-scope `WebAssembly.compile`, blob/data-URL workers)
- `three-mesh-bvh@0.9.18` tarball + https://github.com/gkjohnson/three-mesh-bvh/blob/v0.9.18/example/characterMovement.js
- Installed `node_modules/@expo/dom-webview@58.0.2` (iOS `webViewWebContentProcessDidTerminate` → `onContentProcessDidTerminate`, Android `onRenderProcessGone`) and `node_modules/expo/src/dom/webview-wrapper.tsx` (`...dom` spread)
- Installed `@fastify/cors@11.4.3` index.js (`fastify.options('*')` per scope), `@expo/env` (env file order, no override), `@better-auth/expo` client (web skips storage)
- https://docs.expo.dev/guides/dom-components.md: dom prop, native actions, serialization, Expo Go
- https://docs.expo.dev/router/web/server-rendering.md: SDK 58 `output: "server"` = SSR, dynamic routes, EAS Hosting deploy
- https://docs.expo.dev/router/web/static-rendering.md, https://docs.expo.dev/router/web/server-headers.md (`pageHeaders`)
- https://docs.expo.dev/eas/hosting/introduction.md, https://docs.expo.dev/eas/hosting/deployments-and-aliases.md
- https://docs.spaitial.ai/api/llm-skills and https://docs.spaitial.ai/api/exports: spaitial-world-v1 Y-up, RDF raw SPZ, `camera_from_world = camera_from_splat @ diag(1,-1,-1,1)`, floor-plan affines + pixel centres, thumbnail_url
- https://sparkjs.dev/docs/ and https://sparkjs.dev/docs/lod-getting-started/: setup, LoD budgets, `lod: true` build cost
- https://developers.cloudflare.com/r2/buckets/cors/ and https://developers.cloudflare.com/r2/api/s3/api/: CORS JSON, wildcard rules, PutBucketCors implemented, checksums not
- Codebase: `backend/src/{pipeline,config,server}.ts`, `routes/{index,worlds,webhooks,auth-handler}.ts`, `provider/{mock,types,index}.ts`, `db/schema.ts`, `storage/{index,s3}.ts`, `throttle.ts`, `Dockerfile`, `.dockerignore`, `scripts/{make-tiny-session,migrate-dev,test-pg,dev-guard}.*`, `virtumetry/src/app/_layout.tsx`, `lib/{api,auth-client}.ts`, `components/library-row.tsx`, `package.json`, `app.json`, `jest.setup.ts`

### Secondary (MEDIUM)
- WebSearch: Expo dynamic routes on static vs server output (confirms SSR is the documented path for `[slug]` on EAS Hosting)

### Tertiary (LOW)
- Collider mesh coordinate frame (not documented by SpAItial). Bounds heuristic, needs confirmation in Phase 6

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Versions and APIs read from the actual tarballs.
- Architecture: MEDIUM-HIGH. DOM crash hooks verified in source. The SSR client-only boundary is reasoned from verified facts but not yet exercised (Wave 0 smoke test).
- Coordinates: HIGH for splat/cameras/floor plan (official docs). LOW for the collider frame.
- Backend share/security: HIGH. Stdlib plus installed plugins, patterns already in the repo.
- Pitfalls: HIGH. Most come from direct codebase reads (missing `floorplan_meta`, thumbnail kind, Dockerfile, CORS duplicate).

**Research date:** 2026-11-24
**Valid until:** 2026-12-08 (fast-moving: Expo SDK 58 web, three-mesh-bvh just moved to 0.10)
