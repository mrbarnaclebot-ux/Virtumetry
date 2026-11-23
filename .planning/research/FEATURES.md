# Feature Research

**Domain:** Phone walk-through room capture → cloud Gaussian-splat reconstruction (Echo-3) → walkable 3D room on phone and web; later real-estate 3D listing tours
**Researched:** 2026-11-23
**Confidence:** MEDIUM. Competitor features come from vendor pages, app-store listings and trade press (radiancefields.com). Hands-on testing was not possible. Echo-3 API facts match PROJECT.md and the 2026-11 API launch coverage. Real-estate expectations come from MLS forums and Zillow/Matterport material.

## Landscape in one paragraph

The market has three groups. (1) **Splat/scan apps** (Polycam, Scaniverse, KIRI Engine, Teleport, SpAItial's own app): you capture on a phone, the app processes it, then you view, crop, share and export. Their audience is hobbyists and pros, not homebuyers. (2) **Real-estate tour platforms** (Matterport, Zillow 3D Home, CloudPano, Asteroom, CubiCasa): these jump between 360° panos and add dollhouse and floor-plan views, tags, MLS-unbranded links and portal syndication. Their real product is the floor plan and the listing integration, not visual quality. (3) **Splat-native tour newcomers** (Splat Tour, Teleport property tours, Zillow SkyTour for exteriors only): free movement with parallax, one public link plus embed code, an auto floor plan, and per-room lazy loading. Virtumetry fits group 3, with a faithful metric reconstruction from Echo-3 and a guided native capture. Its v1 edge over the SpAItial app has to come from **capture reliability and cost protection** plus **floor plan and measuring in the same viewer**, not from rendering.

Facts that shape the feature set:
- Echo-3 **fills gaps** ("preserves what you captured and completes what you missed"). Capture guidance should aim for "enough coverage", not "every surface". Exhaustive coverage UIs are over-investment.
- Cost is **900 + 1 credit per frame** (about $13–19 per room). Failed and cancelled API jobs are reported as not charged (radiancefields, MEDIUM confidence). The main money risk is a *bad-but-valid* capture that processes successfully and comes back poor. Pre-upload checks therefore matter more than retry logic.
- Echo-3 outputs a **floorplan PNG with a pixel→world affine**, `mesh-simplified` (collision and raycasts) and metric scale. With these, floor plan, walk mode and measurement are integration work, not research.

---

## Feature Landscape

### Table Stakes (Users Expect These)

`v1` = single room, owner-only milestone. `Later` = the milestone noted.

#### (a) Capture / scan experience

| Feature | Why Expected | Complexity | Milestone | Notes |
|---|---|---|---|---|
| Pre-scan prep checklist (lights on, open blinds, clear the floor, Do Not Disturb) | Polycam, Scaniverse and RoomPlan all coach this. It is the cheapest quality win | LOW | v1 | One screen of 3 rows, as in the VirtSpace ui-spec §4.2 pattern. Show it every time until the user has 3 good scans |
| Live coaching, one instruction at a time ("Slow down", "Turn on a light", "Step back from the wall", "Point at something with detail") | RoomPlan's coaching enum (`slowDown`, `turnOnLight`, `moveAwayFromWall`, `lowTexture`) set the expected style. SpAItial says its app has "clear guidance to move steadily" | MEDIUM | v1 | Drive it from ARKit signals already in the capture module: angular/linear velocity, `ARFrame.lightEstimate`, predicted blur, feature-point count, LiDAR depth to nearest surface. Throttle to one message per ~2 s |
| Tracking state handling: detect ARKit `limited`/`notAvailable`, **pause keyframe capture**, prompt "Go back to where you were", resume after relocalization | Every AR scanner does this. Frames captured during tracking loss poison poses | MEDIUM | v1 | Hard requirement because poses go into `camera_trajectory.json`. Echo-3 rules include a ~0.5 s tracking warm-up, so drop frames for 0.5 s after `normal` returns. Never splice a session whose relocalization failed. Offer "Finish with what you have" or "Start over" instead |
| Visible progress: elapsed time, keyframe count, coverage indicator | All scan apps show capture progress. Users need to know when to stop | LOW | v1 | The keyframe count also drives the cost display (see Differentiators) |
| Coverage feedback ("what's covered") | SpAItial (LiDAR phones) shows live coverage plus a point-cloud preview. Polycam Guided Mode shows a live point cloud. Without it users under- or over-scan | MEDIUM–HIGH | v1 (simple form) | v1: top-down mini-map of camera path plus viewed wall sectors, computed from poses and LiDAR depth. Skip the dense point-cloud preview (see Differentiators) |
| Minimum / maximum limits with clear stop | Echo-3 needs ≥ ~3 min equivalent for good results and allows at most 5,000 frames. Splat Tour enforces 3–10 min, Polycam 1,000 frames per splat | LOW | v1 | App caps for a single room, e.g. min 150 keyframes, soft warning at ~900, hard stop ~1,500. Tune with the first real scans |
| Review before saving (thumbnail strip or path replay, discard/keep) | SpAItial lists a review step before save. Polycam lets you review and delete images before processing | LOW–MEDIUM | v1 | Path replay plus key stats is enough. Per-frame deletion is not needed |
| Scan saved on device before any upload | SpAItial does it. Users expect a scan to survive app kill or lock | MEDIUM | v1 | Already a PROJECT requirement (background upload) |
| Pre-upload validation that mirrors provider rules (frame count, same image size, long edge ≤1920, blur share, monotonic timestamps, intrinsics present, file ≤64 MiB, bundle ≤8 GiB) | VirtSpace lesson: a provider-side 422 failed every capture silently | LOW–MEDIUM | v1 | Run it twice: on device (fast feedback) and in the backend before `POST /v1/worlds`. Share one rules table |
| Cost quote before spending ("This room will use ~1,340 credits ≈ $13.40. Process?") | PROJECT requirement. SpAItial, Splat Tour and Polycam are all credit-based. Spending money without a quote feels like a trap | LOW | v1 | Use `GET /v1/captures/process-quote` or compute 900 + frames locally, then confirm against the server-side budget cap before the button enables |
| Camera permission priming and "Open Settings" recovery | HIG. VirtSpace ui-spec finding 10 | LOW | v1 | |

#### (b) Viewer

| Feature | Why Expected | Complexity | Milestone | Notes |
|---|---|---|---|---|
| Orbit / look-around with touch gestures (drag to look, pinch to zoom, two-finger pan) | Default in every splat viewer (Polycam, Scaniverse, SuperSplat, Teleport) | LOW | v1 | |
| Walk mode at eye height with collision | SuperSplat viewer turns walk mode on automatically when collision data exists. Splat Tour sells "free movement". Without collision, users clip through walls and the room reads as fake | MEDIUM | v1 | Collide against Echo-3 `mesh-simplified`. Controls: tap-to-walk on the floor (the SuperSplat default; lowest learning curve) plus an optional virtual joystick. Clamp to eye height ~1.6 m |
| Good start view (opens at a sensible pose, not inside a wall or in the void) | First-frame impression. Splat viewers that start at the origin look broken | LOW | v1 | Use the first or median camera pose from `cameras.json` |
| Honest progressive loading (one labelled bar from bytes, then "opening") and crash recovery | VirtSpace ui-spec finding 7 (double bars, black screen on WebGL process kill) | LOW–MEDIUM | v1 | Handle WebView process termination with a reload option |
| Smooth frame rate on target phone (LOD / splat budget) | VirtSpace lesson: full-res splats were choppy on iPhone 17 Pro. Splat Tour keeps rooms to 5–10 MB and loads lazily | MEDIUM–HIGH | v1 | Prefer SOG/streamed LOD with a splat budget. Exact renderer choice belongs in STACK.md |
| Point-to-point measurement | Matterport offers it (plan-dependent). SpAItial pitches "measurable, metric". Polycam claims splat measurement. Metric scale is the promise, so users will test it with a tape measure | MEDIUM | v1 | Raycast against `mesh-simplified`, not splats. Snap to surfaces. Show the result in m and ft/in. State accuracy honestly ("±2–3 cm typical" only after we measure it) |
| Floor plan view | Matterport, Zillow 3D Home, Splat Tour and CubiCasa all include one. Zillow says interactive floor plans give listings 49% more saves (Zillow's own figure) | LOW–MEDIUM | v1 | Display the Echo-3 floorplan PNG, using the affine to place a "you are here" marker and view cone |
| Reset / recenter button | Users get lost in 3D | LOW | v1 | |

#### (c) Sharing

| Feature | Why Expected | Complexity | Milestone | Notes |
|---|---|---|---|---|
| Public web link that opens in any browser with no app or account | SpAItial, Teleport, Splat Tour, Polycam and Matterport all have it. It is the core of the eventual listings product | MEDIUM | v1 | Unguessable token URL. Mobile Safari and Chrome must work, since most viewers will be on phones |
| Link preview (Open Graph image and title) | Shared links in iMessage/WhatsApp look broken without one | LOW | v1 | Use the thumbnail render plus the room name |
| Revoke / disable a link | These are scans of private homes. PROJECT privacy constraint | LOW | v1 | Revoking rotates the token. The old URL shows "This room is no longer shared" |
| Web viewer offers the same core modes (orbit, walk, floor plan, measure) | Teleport and Splat Tour offer the same experience on web and app | MEDIUM | v1 | If the in-app viewer is web-based (WebView), reuse it as is. That is the cheapest route to parity |

#### (d) Real-estate listing (later milestones; listed so v1 does not block them)

| Feature | Why Expected | Complexity | Milestone | Notes |
|---|---|---|---|---|
| Whole-home tour (multiple rooms merged, floor switcher) | One room is not a listing. Matterport, Splat Tour (per floor) and Teleport "Portals" all cover full properties | HIGH | Whole-house milestone | Echo-3 `zips[]` takes up to 8 bundles. Lazy-load per room as Splat Tour does |
| MLS-compliant **unbranded** link alongside a branded link | MLS boards require unbranded tours (no agent logo, contact details or CTA). Matterport handles this with `&mls=1` | LOW–MEDIUM | Listings milestone | Implement as a query flag that strips branding, contact info, tags with links, and outbound links |
| Embed code (iframe) | Teleport, Splat Tour, Polycam (paid) and Matterport all have it. Brokers paste tours into their own sites | LOW | Listings milestone | Needs the CSP/frame-ancestors setup on the web viewer |
| Floor plan with room labels and dimensions | Asteroom and CubiCasa ship dimensioned 2D plans. Buyers judge layout from the plan | MEDIUM–HIGH | Whole-house / listings | Echo-3 gives a render, not a vector plan. Labels and dimensions need our own work: room segmentation from the mesh, or a RoomPlan pass during capture |
| Dollhouse / overview view of the whole home | Matterport's signature view, which buyers recognise | MEDIUM | Whole-house | A splat seen from outside and above with the ceiling clipped. Clip-plane support in the renderer is the dependency |
| Hotspots / tags (e.g. "New boiler 2024") | Matterport Mattertags, SuperSplat annotations, Teleport waypoints with captions | MEDIUM | Listings milestone | Watch out: MLS bans branding inside tags, so the unbranded mode must filter them |
| Guided tour / highlight reel (auto camera path) | Matterport highlight reel, SuperSplat animation tracks | MEDIUM | Listings milestone | A camera path through the capture's own poses gives a free starting point |
| Privacy redaction (remove family photos, documents, faces before publishing) | Listings expose private homes. Splat editors (KIRI, Polycam, SuperSplat) offer crop/delete | HIGH | Listings milestone | Crop boxes plus delete-region is the realistic first version. Automatic face/photo blur in splats is research-grade |
| Tour stays online for the listing's life; stable URLs | Splat Tour keeps tours live after the subscription ends. Brokers paste a URL once | LOW | Listings milestone | URL design in v1 should already be stable (`/r/<token>`) |
| View analytics (views, time in tour) | Brokers report results to sellers. Standard on tour platforms | LOW–MEDIUM | Listings milestone | |

### Differentiators (Competitive Advantage)

These line up with the Core Value: faithful, reliable, and no paid processing wasted on bad captures.

| Feature | Value Proposition | Complexity | Milestone | Notes |
|---|---|---|---|---|
| **"Good enough" readiness meter**: one green/amber/red signal combining keyframe count, coverage sectors, blur share and tracking quality, plus "You can finish now" | Competitors show raw coverage. Nobody tells the user when to stop. This targets "wasted processing on bad captures" head-on | MEDIUM | v1 | Start with simple thresholds, then calibrate against the first 5–10 real Echo-3 results. Keep the thresholds in a config the owner can tune |
| **Live cost meter during capture** ("~$11 so far") | Per-frame pricing makes cost visible and controllable. SpAItial bills by scan minute in its app, so cost is opaque mid-scan | LOW | v1 | 900 + keyframes. Pairs with the budget cap |
| **Server-side budget guard before processing** (refuses when it would exceed the cap; never auto-retries a paid job) | VirtSpace burned quota. Competitors leave this to the user | LOW–MEDIUM | v1 | Already a PROJECT requirement. Show the remaining monthly budget on the quote screen |
| **Floor plan + measure + walk in one viewer, on web too** | SpAItial's app gives splat plus link. Matterport has plans and measurement but pano jumps. Splat Tour has plans but no measurement mentioned | MEDIUM | v1 | Cheap because Echo-3 supplies floorplan, affine and mesh. Tap the floor plan to teleport there |
| **Auto room dimensions** (L × W × ceiling height) shown on the room card | Instant "is the scale right?" check, and the first thing brokers want | MEDIUM | v1.x | From the mesh's floor/ceiling planes and the floorplan bounds. Label it "approximate" |
| Dense live point-cloud / mesh preview during capture | SpAItial and Polycam have it on LiDAR phones. It reassures users visually | HIGH | v1.x | ARKit scene reconstruction mesh rendered in the native view. Defer until the simple coverage map proves insufficient, because Echo-3 gap-fill lowers its value |
| Post-scan "quick look" before paying (low-fi preview from captured poses and depth) | Lets the user spot a missed corner before $15 is spent | HIGH | Later | Only if real scans show coverage misses that the readiness meter does not catch |
| Flythrough video export (MP4 along the capture path) | Teleport and Polycam offer it. Brokers post it on social and in portals that do not support 3D | MEDIUM | Listings milestone | |
| Splat-native tour quality on listing sites (free movement vs Matterport's pano jumps) | The core marketplace differentiator. Splat Tour, Teleport and Zillow (exterior) are only starting here, and MLS/portals have not standardised splat support | HIGH | Listings milestone | Portal syndication (Zillow's 3D slot accepts only certain native providers' links) is a business-development issue, not a feature. Flag it for the listings research |

### Anti-Features (Commonly Requested, Often Problematic)

Do **not** build these in v1.

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| Generative fill, AI staging or "what-if" furniture | Splat Tour sells AI staging, and generation is demo-friendly | Breaks "faithful". VirtSpace already dropped Marble for this reason. In listings, undisclosed generated content is a misrepresentation risk | Later, and only as a clearly labelled separate layer that never overwrites the faithful scan |
| Square footage / GLA figures | Brokers ask for square footage first | Scan-derived areas are disputed (Open Homes declines to publish them; CubiCasa sells ANSI-aligned GLA as a separate, appraisal-reviewed product). A wrong number on a listing is a liability | Point measurement plus "approximate room dimensions", with a disclaimer. Reconsider for listings with a measurement-standard review |
| On-device splat training (Scaniverse-style) | Free and instant | Months of work, worse quality than Echo-3, battery and heat. PROJECT already keeps self-hosting behind the provider interface | Echo-3 via the provider interface |
| Video or photo import from other cameras | Teleport and Polycam accept any camera | Echo-3 needs per-frame intrinsics and works best with ARKit poses. Imports bypass guidance and pre-flight checks, so bad captures cost money | Native ARKit capture only |
| Exhaustive "paint every surface" coverage UI | Feels thorough | Echo-3 completes missed areas, so the UI makes scans longer and costlier for little gain. Slower scans also mean more frames and more money | Coverage *sufficiency* (readiness meter), not completeness |
| Splat editing tools (crop, delete, colour) | KIRI, Polycam and SuperSplat have them | Big UI surface, little v1 value for one owner who can rescan | Defer to the listings milestone as privacy redaction (crop box, delete region) |
| Download / export SPZ, PLY or mesh to users | Power users expect it | Echo-3 Standard outputs are non-commercial. Raw files of private homes leak easily. It also undercuts future hosted-tour value | Hosted viewing only. Revisit for broker plans under Pro/Enterprise licensing |
| Public gallery, social feed, likes, comments | Polycam and Luma had community feeds | Privacy of homes, moderation burden, not the business | Share links only |
| Automatic retry of failed or poor reconstructions | Seems helpful | Each run costs ~$15–18. VirtSpace burned quota. Retrying a bad capture gives the same bad result | Manual "Try again" for transient failures only, behind the budget guard. "Rescan" for quality problems |
| Multi-room merge in v1 | The end goal is whole homes | Doubles capture-UX and alignment problems before single-room quality is proven | Next milestone (`zips[]`, up to 8) |
| Branding, lead capture, agent profiles, MLS mode in v1 | Needed for listings | No brokers in v1. Adds untestable surface | Keep the URL scheme and viewer config extensible, then build in the listings milestone |
| VR / Vision Pro / WebXR mode | Teleport and KIRI support it | Tiny audience for listings, plus extra rendering paths | Not planned |
| Live multi-user / co-viewing tours | "Virtual showing" sounds attractive | Realtime infrastructure for a niche case. Buyers prefer prerecorded tours (Rocket survey via NAR) | Share link plus a phone call |
| AR "place the room on your table" | Common in scan apps | Novelty with no listings value | None |

---

## Feature Dependencies

```
Native ARKit capture module (frames + intrinsics + poses + tracking state + depth)
    ├──requires──> Live coaching (velocity, light, blur, depth signals)
    ├──requires──> Tracking-loss pause/resume
    ├──requires──> Coverage mini-map ──enhances──> Readiness meter
    ├──requires──> Keyframe counter ──> Live cost meter ──> Cost quote screen
    └──requires──> On-device save ──> Pre-upload validation ──> Background upload
                                                   └──> Backend pre-flight (same rules) ──> Budget guard ──> Echo-3 submit

Echo-3 outputs (splat SOG/SPZ, mesh-simplified, floorplan PNG + affine, cameras.json)
    ├── splat + LOD ──────────> Viewer (orbit)
    ├── mesh-simplified ──────> Walk mode collision
    │                      └──> Measurement raycasts ──> Auto room dimensions
    ├── floorplan + affine ───> Floor plan view ──> "You are here" + tap-to-teleport
    └── cameras.json ─────────> Start pose, (later) guided tour path

Web viewer (one codebase) ──> In-app viewer (WebView) and public share link
Public share link ──requires──> Auth (owner owns rooms) + token + revoke
Share link ──> (later) Embed code ──> MLS unbranded mode ──> Hotspots must be filterable

Single-room quality proven ──> Multi-room merge ──> Dollhouse, floor switcher, labelled floor plan
Splat crop/delete ──> Privacy redaction ──> Public listings

Generative staging ──conflicts──> Faithful-reconstruction promise (keep as a separate labelled layer only)
Exhaustive coverage UI ──conflicts──> Short/cheap scans (Echo-3 gap-fill)
```

### Dependency Notes

- **All capture guidance depends on the native module exposing more than frames.** It must also stream tracking state, velocity, light estimate and depth to JS (or render the HUD natively). Decide the HUD boundary (native SwiftUI overlay vs RN overlay fed by events) in the capture phase. A native overlay avoids bridge latency for per-frame feedback.
- **Measurement and walk mode both depend on `mesh-simplified`,** and on getting the coordinate transform right (RDF y-down splat vs viewer `(x,-y,-z)` vs mesh frame). Build one shared transform utility and test it with a fixture.
- **The floor plan depends on the floorplan affine.** Validate it against the mesh on fixture outputs before building "you are here".
- **The in-app viewer and the share page should be the same web viewer.** That gives one place for LOD, walk, measure and floor plan, and the share link inherits every feature.
- **The cost quote depends on the budget guard.** The quote screen must show "within budget" only after the server confirms, never optimistically.

---

## MVP Definition

### Launch With (v1: single room, owner-only)

- [ ] Prep checklist + camera permission priming: cheapest quality win
- [ ] Live coaching (slow down / light / too close / low texture) + tracking-loss pause/resume with 0.5 s warm-up: prevents bad poses, the costliest failure
- [ ] Coverage mini-map + readiness meter + min/max keyframe limits: tells the owner when to stop
- [ ] Live cost meter + cost quote + server budget guard: money safety
- [ ] Review step + on-device save + pre-upload validation (device and backend): no silent provider rejections
- [ ] Library states (capturing → uploading → processing → ready / failed + retry for transient failures only)
- [ ] Web viewer: orbit, walk with collision, start pose, honest loading, LOD/budget, crash recovery
- [ ] Measurement (mesh raycast) + floor plan view with "you are here" and tap-to-teleport
- [ ] Public share link with OG preview + revoke, same viewer features on web
- [ ] Owner auth

### Add After Validation (v1.x)

- [ ] Auto room dimensions (L × W × H). Trigger: measurement raycasts proven accurate
- [ ] Dense live mesh/point-cloud preview. Trigger: real scans still come back with missed areas despite the readiness meter
- [ ] Threshold tuning UI for the readiness meter (debug-only). Trigger: first 5–10 real scans

### Future Consideration (whole-house, listings, broker milestones)

- [ ] Multi-room merge, floor switcher, dollhouse: after single-room quality is proven
- [ ] Labelled and dimensioned floor plan: needs segmentation work; whole-house milestone
- [ ] Embed code, MLS unbranded mode, branded mode, hotspots, guided tour, analytics: listings milestone
- [ ] Privacy redaction (crop/delete): required before any public listing
- [ ] Flythrough video export: broker marketing
- [ ] Android capture: needs an ARCore port and a test device

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---|---|---|---|
| Tracking-loss pause/resume | HIGH | MEDIUM | P1 |
| Live coaching | HIGH | MEDIUM | P1 |
| Pre-upload validation (device + backend) | HIGH | LOW | P1 |
| Cost quote + budget guard | HIGH | LOW | P1 |
| Readiness meter + coverage mini-map | HIGH | MEDIUM | P1 |
| Live cost meter | MEDIUM | LOW | P1 |
| Review before save | MEDIUM | LOW | P1 |
| Walk mode with collision | HIGH | MEDIUM | P1 |
| LOD / splat budget | HIGH | MEDIUM–HIGH | P1 |
| Measurement | HIGH | MEDIUM | P1 |
| Floor plan + you-are-here | HIGH | LOW–MEDIUM | P1 |
| Public share link + OG + revoke | HIGH | MEDIUM | P1 |
| Tap-to-teleport from floor plan | MEDIUM | LOW | P2 |
| Auto room dimensions | MEDIUM | MEDIUM | P2 |
| Dense live mesh preview | MEDIUM | HIGH | P3 |
| Flythrough video export | MEDIUM | MEDIUM | P3 |
| Embed / MLS unbranded / hotspots | HIGH (later) | LOW–MEDIUM | P3 (listings) |
| Multi-room merge | HIGH (later) | HIGH | P3 (next milestone) |

## Competitor Feature Analysis

| Feature | SpAItial app (Echo-3) | Polycam | Scaniverse | KIRI Engine | Teleport (Varjo) | Matterport | Zillow 3D Home / SkyTour | Splat Tour | Our approach (v1) |
|---|---|---|---|---|---|---|---|---|---|
| Capture input | iPhone walk-through; live coverage + point cloud on LiDAR Pros | Guided Mode (iOS) with live point cloud; images/video | Phone, on-device processing (~1 min) | Short video, 3DGS | App or any camera, images/video | Pro cameras or phone; panos | 360 camera (plan) or phone (tour); drone for SkyTour | One ultra-wide phone video per floor, loop + diagonals | Native ARKit keyframes + poses, readiness meter |
| Scan limits | Billed per scan minute (900 credit min) | 1,000 imgs/splat (Business) | n/a (on-device) | n/a | 3,000 images (API) | n/a | n/a | 3–10 min per video | App min/max keyframes; Echo-3 ≤5,000 |
| Cost visibility | Credits per minute | Plan tiers | Free | Plan tiers | 5 free scans, then paid | Subscription | Free (Showcase paid) | Credits per minute | Live cost meter + quote + cap |
| Viewer | Browser and app, measurable | Orbit, splat measurement (claimed) | Orbit | Orbit + editing | Orbit, waypoints, VR | Pano walk, dollhouse, floor plan, measure, tags | Pano tour + interactive floor plan; SkyTour exterior splat | 360 panos + optional 3D walk, lazy per room | Orbit + collision walk + measure + floor plan |
| Floor plan | Echo-3 floorplan export (render) | Space Mode (LiDAR) | No | No | No | Yes (schematic) | Yes, interactive, linked to photos | Auto | Echo-3 render + you-are-here |
| Share/embed | Link | Link; embed on paid | Link/export | Export | Link + embed + VR | Branded + unbranded (`&mls=1`) + embed | Zillow/Trulia, syndicated to Redfin/Realtor | Public link + embed; Pro branding | Public link + revoke (embed later) |
| Export | SPZ/SOG/mesh (API) | Many formats | PLY/SPZ | PLY/OBJ | PLY (conflicting docs) | Paid add-ons | n/a | n/a | None (anti-feature v1) |

Notes: Luma no longer counts as a capture competitor (uploads disabled since 2024-11, per prior VirtSpace research). CubiCasa competes on floor plans and GLA, not 3D visuals. Apple RoomPlan apps produce parametric floor plans and set the coaching *style*, not photoreal output. An optional RoomPlan pass for a vector floor plan is worth a look in the whole-house milestone.

## Open Questions / Gaps

- Exact SpAItial app UX (coverage visualisation, review step, in-app viewer modes) is known only from store-listing text. Worth one hands-on session with their app (first month free) before finalising the capture HUD. Observe only; do not reverse-engineer.
- "Failed captures are not charged" comes from one trade-press source. Confirm in the SpAItial docs or billing before relying on it in retry policy.
- Echo-3 floorplan accuracy and affine correctness are unverified until the first real output. Measurement accuracy claims must wait for a tape-measure test.
- MLS/portal acceptance of splat-based tour links (especially Zillow's 3D slot) is unresolved. Research it in the listings milestone.
- Readiness-meter thresholds can't be researched; they have to be calibrated from real scans.

## Sources

- SpAItial Echo-3 launch: https://radiancefields.com/spaitial-echo-3-turns-iphone-scans-into-3d-worlds (MEDIUM)
- Echo-3 API opens to all accounts: https://radiancefields.com/spaitial-echo-3-api-opens-to-every-developer-account (MEDIUM)
- SpAItial app listing summary: https://mwm.ai/apps/spaitial/6803571420 ; https://runtimewire.com/article/spaitial-echo-3-iphone-3d-world-capture (LOW–MEDIUM)
- Polycam capture modes: https://learn.poly.cam/hc/en-us/articles/48565771018772 ; Guided Mode: https://learn.poly.cam/hc/en-us/articles/35619450890132-How-to-Use-Guided-Mode-in-Polycam ; upload limits: https://learn.poly.cam/hc/en-us/articles/30549121659412 ; Basic plan: https://poly.cam/de-de/basic-plan (MEDIUM)
- Scaniverse support: https://scaniverse.com/support ; techniques: https://nianticspatial.com/docs/scaniverse/techniques/ (MEDIUM)
- KIRI Engine 3DGS: https://www.kiriengine.app/features/3d-gaussian-splatting (MEDIUM)
- Teleport property tours: https://get.teleport.varjo.com/product-pages/3d-property-tours (MEDIUM)
- Splat Tour: https://radiancefields.com/splat-tour-turns-phone-video-into-3d-property-tours (MEDIUM, single source)
- Zillow SkyTour / 3D Home: https://www.zillowgroup.com/news/take-home-listings-to-new-heights-with-skytour ; https://www.zillow.com/3d-home/floor-plans/ ; https://www.zillowgroup.com/news/zillow-showcase-brings-listings-to-life (MEDIUM)
- Matterport Showcase: https://matterport.com/matterport-academy/intro-to-showcase/intro-to-showcase ; https://matterport.com/blog/refreshing-the-way-to-explore-your-digital-twins (MEDIUM)
- MLS unbranded requirements: https://realcomp.moveinmichigan.com/News-Events/Feature-2026/February-2026/-Matterport-Tours-Important-Update ; https://wegetaroundnetwork.com/topic/9284/any-way-matterport-will-fix-tags--realtor-mls-use-issue-soon (LOW–MEDIUM)
- Apple RoomPlan coaching: https://developer.apple.com/documentation/roomplan/roomcapturesession/instruction ; https://developer.apple.com/forums/thread/709750 (HIGH for enum)
- SuperSplat viewer walk mode / collision / embed: https://blog.playcanvas.com/new-in-supersplat-walk-mode-streamed-lod-and-easy-upload ; https://developer.playcanvas.com/user-manual/supersplat/viewer/embedding/ (HIGH)
- CubiCasa GLA: https://clearcapital.com/how-to-calculate-gross-living-area-digitally ; square-footage caution: https://www.open-homes.com/faqs/are-cubicasa-or-matterport-floor-plans-accurate/ (LOW–MEDIUM)
- Buyer attitudes to virtual tours: https://www.nar.realtor/news/real-estate-news/virtual-tours-gain-ground-with-buyers (MEDIUM)
- Prior project: VirtSpace `docs/research/reconstruction-vs-generation.md`, `docs/design/ui-spec.md`

---
*Feature research for: phone room scanning → Gaussian-splat 3D rooms → real-estate tours*
*Researched: 2026-11-23*
