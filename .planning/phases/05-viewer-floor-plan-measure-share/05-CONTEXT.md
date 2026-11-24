# Phase 5: Viewer, Floor Plan, Measure & Share - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** --auto (owner: "proceed and complete all remaining phases"; every grey area auto-resolved with the recommended option, logged in 05-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

The owner opens a **ready** world (mock/fixture outputs only, no paid Echo-3) from the Library and gets a full-screen 3D viewer in Expo Go: orbit with honest load progress under a LoD splat budget, sensible start view + reset, first-person walk with collision against the collider mesh, a floor-plan overlay with "you are here" and tap-to-teleport, two-point measure labelled approximate, and self-recovery from WebView/WebGL loss. From the viewer the owner creates public share links (unguessable slug, optional password, revoke, open count). The link opens the same viewer in any desktop/mobile browser, previews with thumbnail + title in messaging apps, and is `noindex`.

Requirements: VIEW-01..06, SHARE-01..05. Out of scope: live Echo-3 (Phase 6), native ARKit (Phase 8), marketplace/listing pages, custom domain.

</domain>

<decisions>
## Implementation Decisions

### Fixture world worth viewing
- **D-01:** The current mock outputs (8-gaussian `splat.ply`, unit-box collider, blank 64x64 floor plan) cannot prove orbit/walk/measure. Add a **generated synthetic "demo room"** output set: a script (`backend/scripts/make-demo-room.ts`) builds a ~4 x 5 m room (floor, 4 walls with a doorway, 1-2 box "furniture" obstacles) as (a) a colored Gaussian splat (~50-150k gaussians, committed size budget **<= 5 MB**; format = whatever Spark 2.4 loads that we can write without new heavy deps, researcher picks PLY vs SPZ/`.splat`), (b) a matching triangle collider PLY (walls/floor/obstacles), (c) a rendered top-down floor plan PNG + `floorplan.json` with correct affines, (d) `cameras.json` with a plausible walk path, (e) a `thumbnail.jpg`. License-free (we generate it). Committed under `backend/test/fixtures/demo-room/`.
- **D-02:** Existing tiny `mock-outputs/` stay for fast backend tests. The mock provider gets an env-selected outputs set (`MOCK_OUTPUTS_SET=demo-room`, validated, default unchanged); the **Railway dev** env sets it so a Phase-4 fixture scan comes back as the demo room. Production untouched. Mock emits `thumbnail` too (importer already has `thumbnailKey`).
- **D-03:** Coordinate conventions (y-up vs OpenCV y-down for `spaitial-world-v1`, `camera_from_splat` inversion) are **researcher-verified** against SpAItial docs; the demo room is generated in exactly that convention so the viewer is correct for real Echo-3 outputs, not just our fixture.

### Viewer architecture (VIEW-01/02)
- **D-04:** One `'use dom'` component (`virtumetry/src/viewer/world-viewer.tsx` + plain-TS engine modules under `src/viewer/`) using **Spark 2.4.0 + three 0.187.0 + three-mesh-bvh 0.9.18** (pinned exactly), imperative three in `useEffect`, no R3F. Props are serializable: `{ splatUrl, colliderUrl?, floorplanUrl?, floorplanMeta?, camerasUrl?, startPose?, title }`; native actions: `onProgress`, `onReady`, `onError`, `onPose` (throttled, for recovery). Same component renders as plain DOM on web.
- **D-05:** Honest progress: fetch the splat ourselves with streamed byte counting (`Content-Length`), percent shown in an overlay; then hand bytes to Spark (`fileBytes`). Indeterminate spinner only when length unknown. Stages: "Downloading world", "Preparing".
- **D-06:** LoD: Spark 2.x built-in LoD with an explicit conservative splat budget for mobile (tunable constant). `.RAD` pre-build deferred (no Rust in backend this phase).
- **D-07:** Start viewpoint = first camera of `cameras.json` (converted to three); fallback = scene-bounds center at eye height looking along the longest axis. **Reset** returns to start pose and orbit mode.
- **D-08:** Coordinate + affine math in pure TS (`src/viewer/coords.ts`, `floorplan.ts`, `measure.ts`) with jest tests (OpenCV to three camera, pixel to world xz via `world_xz_from_pixel`/`pixel_from_world_xz`, distance formatting).

### Walk mode (VIEW-03)
- **D-09:** Toggle Orbit / Walk. Walk: eye height 1.6 m above floor, capsule radius ~0.25 m, horizontal capsule-vs-BVH collision (three-mesh-bvh `shapecast`), no jumping/stairs. Touch: left-half virtual joystick to move, right-half drag to look. Desktop: WASD/arrows + mouse drag look. Collision math lives in a testable module (jest: walking into a wall stops at the wall).
- **D-10:** No collider: Walk and Measure disabled with an explanatory hint.

### Floor plan (VIEW-04)
- **D-11:** Toggleable floor-plan panel inside the DOM component: floor-plan image with a "you are here" dot + heading wedge; tapping a point teleports (world xz from pixel affine, eye height, pushed out of collider) and switches to Walk. Hidden when the world has no floor plan.

### Measure (VIEW-05)
- **D-12:** Measure mode: tap two points; each tap raycasts against the collider BVH; show markers + line + label "≈ 2.41 m (approx.)". Third tap starts a new measurement; "Clear" button.

### Crash recovery (VIEW-06)
- **D-13:** Two layers: (a) inside the DOM component, handle `webglcontextlost`/`restored` (preventDefault, rebuild renderer + reload scene from cached bytes); (b) native side, detect WebView process termination (via whatever `@expo/dom-webview` exposes, researcher confirms) and remount with a bumped `key`, restoring the last pose from `onPose`. A pure `recovery.ts` reducer (crash -> remount with saved pose, cap e.g. 3 per minute then show "Reload" button) with a jest test.

### Routes / UI entry
- **D-14:** Library row tap on a `ready` world -> `src/app/world/[id].tsx` (full-screen stack screen outside tabs) that fetches `GET /v1/worlds/:id` via react-query and renders the viewer + overlays (back, title, Reset, mode switcher Orbit/Walk/Measure/Plan, Share). Non-ready rows keep current behaviour. Visuals per UI-SPEC.

### Share links (SHARE-01..05)
- **D-15:** Extend `share_slugs` (drizzle-kit generate; no push): `password_hash text null`, `open_count integer not null default 0`, `last_opened_at timestamptz null`. Slug = 22-char base64url of 16 random bytes. Multiple links per world allowed.
- **D-16:** Owner routes (`backend/src/routes/share.ts`, auth, `findOwnedWorld` 404 for others): `POST /v1/worlds/:id/shares {password?}` (ready worlds only) -> `{ id, slug, url, has_password, open_count, created_at }`; `GET /v1/worlds/:id/shares`; `DELETE /v1/worlds/:id/shares/:shareId` -> `revoked_at=now()` (idempotent).
- **D-17:** Public routes (no auth, rate-limited with existing `@fastify/rate-limit`): `GET /v1/public/shares/:slug` -> `{ title, needs_password }` or 404 (missing / revoked / not ready / deleted all give the same 404); `POST /v1/public/shares/:slug/open {password?}` -> verify password (node:crypto `scrypt` + `timingSafeEqual`; 401 `password_required` / `wrong_password`), atomically increment `open_count`, return `{ title, floorplan_meta, assets: {splat_url, collider_url, floorplan_url, cameras_url} }` presigned with **TTL 15 min**. Revocation kills the link immediately; already-downloaded bytes are not clawed back (documented). Each successful open = one count.
- **D-18:** Share UI: viewer Share button -> share sheet (route modal) listing links (URL, open count, lock icon, created date, Revoke with confirm), "Create link" with optional password, then RN `Share.share` / copy. Hidden for non-ready worlds.

### Web share page + previews (SHARE-01/03)
- **D-19:** Web viewer = Expo Router web route `virtumetry/src/app/r/[slug].tsx` (outside the auth guard), rendering the same `WorldViewer` as plain DOM; password form when `needs_password`; "This link is no longer available" on 404. `.web.tsx` stubs only if the web export fails without them. Deployed with `eas deploy` (preview, never `--prod`) for dev.
- **D-20:** OG previews need server-rendered meta per slug. The canonical share URL is a **backend landing** `GET /s/:slug` (Fastify HTML): `og:title`, `og:description`, `og:image` (presigned thumbnail with long TTL, or a static fallback), `<meta name="robots" content="noindex,nofollow">` + `X-Robots-Tag: noindex`, then sends browsers to `<WEB_SHARE_ORIGIN>/r/<slug>` (meta refresh + JS). Revoked/missing -> 404 page, still noindex. Landing does **not** count opens. Web route also sets noindex via `expo-router/head`. New backend env `WEB_SHARE_ORIGIN` (zod, https) and `PUBLIC_BASE_URL`.
- **D-21:** CORS: `@fastify/cors` allows the web share origin for `/v1/public/*`. R2 **virtumetry-dev** bucket CORS: GET/HEAD from share origin (+ localhost), allow `Range`, expose `Content-Range, Accept-Ranges, Content-Length, ETag`. Prod bucket untouched.

### Testing
- **D-22:** App jest: coords / floorplan affine / measure / collision / recovery pure modules; world screen RNTL (loading -> viewer props, Share hidden when not ready) with the DOM component mocked; share sheet RNTL (create / revoke / count); web share route RNTL (password form, 404 message). lint + tsc + jest clean.
- **D-23:** Backend vitest (Neon dev): share create (ready only, ownership 404), slug format, public get/open, revoked -> 404 immediately, password required/wrong/right, open_count increments, `/s/:slug` landing has OG + robots noindex + X-Robots-Tag and does not count, `MOCK_OUTPUTS_SET` selection, demo-room fixture validity. tsc clean.

### Claude's Discretion
- File split under `src/viewer/`, joystick visuals, panel layout (UI-SPEC), demo-room splat format and gaussian count within budget, LoD constants, rate-limit numbers, plan/wave split.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / phase scope
- `.planning/ROADMAP.md` §"Phase 5" — goal + 5 success criteria
- `.planning/REQUIREMENTS.md` — VIEW-01..06, SHARE-01..05
- `CLAUDE.md` — stack (Spark 2.4.0, three 0.187, three-mesh-bvh 0.9.18, DOM components, `/r/[slug]`, R2 CORS + Range), EAS / Expo Go constraints
- `virtumetry/AGENTS.md` — Expo rules, `npx expo install`, never `eas build`

### Research
- `.planning/research/ARCHITECTURE.md` §"Share flow", Viewer row, Anti-Pattern 7 (no auth guard on share route)
- `.planning/research/STACK.md` — Spark LoD, DOM component limits, Expo Hosting quotas
- `.planning/research/PITFALLS.md` — viewer / WebView pitfalls

### Existing code contracts
- `backend/src/db/schema.ts` — `worlds` asset keys + `floorplanMeta`, `share_slugs`
- `backend/src/routes/worlds.ts` — `GET /v1/worlds/:id` signed asset URLs (`ASSET_FIELDS`), `findOwnedWorld`
- `backend/src/provider/mock.ts` — mock outputs list/dir
- `backend/test/fixtures/mock-outputs/` (+ README) — floorplan.json schema (`spaitial-world-v1`, affines), cameras.json (`spaitial.capture_cameras.v1`, OpenCV `camera_from_splat`)
- `backend/src/worker.ts` — purge deletes share_slugs
- `virtumetry/src/app/(tabs)/index.tsx`, `virtumetry/src/components/library-row.tsx` — Library open handler
- `virtumetry/src/config/api.ts`, `virtumetry/src/lib/api.ts` — API base + client
- `.planning/phases/03-owner-account-scan-library/03-UI-SPEC.md` — existing visual language

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `GET /v1/worlds/:id` already presigns splat/collider/floorplan/cameras/thumbnail URLs.
- `share_slugs` table exists (id, world_id, slug unique, created_at, revoked_at); worker purge already deletes them.
- `@fastify/cors` 11.4.3 and `@fastify/rate-limit` already installed.
- Constant-time compare helper exists in backend auth.
- react-query client, themed components, `constants/theme.ts` in app.

### Established Patterns
- Pure TS logic modules + jest tests; thin screens. Owner-scoped routes return 404 for non-owners.
- Migrations via drizzle-kit generate + guard scripts on the dev branch; env via `node --env-file=.env`.
- zod-validated env in `backend/src/config.ts`; dev-only values set on the Railway dev env.

### Integration Points
- Library row `onOpen` -> new `world/[id]` route.
- Mock provider outputs dir -> demo-room set via env.
- `app.json` `web.output` is `"server"`; keep unless `eas deploy` requires a change.

</code_context>

<specifics>
## Specific Ideas

- Distances always carry "approx.": Echo-3 scale is real-world but not survey-grade.
- Owner tests on iPhone 17 Pro in Expo Go and a desktop browser; share links in tests point only at mock/fixture worlds.

</specifics>

<deferred>
## Deferred Ideas

- `.RAD` LoD pre-build in backend (Rust `build-lod`) — when real Echo-3 splats are too heavy (Phase 6+).
- Custom share domain / Cloudflare Pages / Next.js listing pages — marketplace milestone.
- Link expiry dates, per-viewer analytics, unique-visitor dedupe — later.
- Native RealityKit splat viewer — only if WebView can't hold frame rate.

</deferred>

---

*Phase: 05-viewer-floor-plan-measure-share*
*Context gathered: 2026-11-24*
