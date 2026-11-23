# Architecture Research

**Domain:** Phone walk-through capture (ARKit) to cloud reconstruction (SpAItial Echo-3) to 3D splat viewer, plus a public web share page
**Researched:** 2026-11-23
**Confidence:** MEDIUM-HIGH overall. Echo-3 contract checked against docs.spaitial.ai (HIGH). Expo SDK 58 file-system and DOM-component behaviour checked against docs.expo.dev v58 (HIGH). VirtSpace backend read at source level (HIGH). Background-upload survival after the app is killed, and the Echo-3 idempotency window, are not documented (flagged LOW).

---

## Guiding Principle: Keep Swift Dumb, Put Policy in TypeScript

The owner works on Windows with 15 iOS EAS builds a month and no Mac. Every Swift change costs a cloud build and a reinstall. Every TS change ships over Metro or EAS Update for free. Backend changes ship on a Railway deploy. So the main architecture rule is:

> **Swift only does what must touch ARSession or pixel buffers at frame rate. Everything that is policy, math, or format goes in TypeScript, preferably on the backend, where vitest can test it on Windows.**

| Concern | Lives in | Why |
|---|---|---|
| ARSession lifecycle, video format choice (1920x1440), preview view | **Swift** | Has to be native |
| Per-frame keyframe gate (≥0.12 s AND ≥7 cm or 10°) | **Swift**, thresholds passed in from JS at `start(config)` | Runs at 60 Hz on ARFrame. Thresholds stay tunable without a rebuild |
| Blur rejection | **Swift**: *predicted* motion blur ≈ ‖ω‖ · exposureDuration · focal_px from consecutive poses, no pixel work. Optional cheap Laplacian later | Matches Echo-3's "predicted blur > 64 px" rule. Uses almost no CPU, so thermal headroom is kept |
| JPEG encode (CIContext/ImageIO, q≈0.85, no Orientation tag) and write to disk | **Swift** | Pixel buffers never cross the JS bridge |
| Append one line per kept frame to the on-disk manifest (raw ARKit transform, intrinsics, timestamps) | **Swift** | Crash-safe. Each line is complete before the next frame |
| Throttled event stream to JS (pose at ~10 Hz, keyframe accepted/rejected + reason, tracking state, thermal) | **Swift** emits, **TS** consumes | Small payloads |
| Coverage / guidance ("what's covered, is it good enough") | **TS** (app), computed from the 10 Hz pose stream | This is the part we will tune most. Keeping it in TS avoids a rebuild per tweak |
| Pre-upload check (frame count vs `/captures/limits`, blur-reject ratio, coverage score) | **TS** (app) | Policy |
| ARKit to OpenCV `camera_from_world` (invert `camera.transform`, then × diag(1,-1,-1,1)), intrinsics JSON, `orientation.json` | **TS on the backend** (pack step) | Pure math with unit tests and recorded fixtures. A wrong sign is fixed by a Railway deploy, not an EAS build |
| EXIF `DateTimeOriginal`/`SubSecTimeOriginal`/`OffsetTimeOriginal` injection | **TS on the backend** (pack step, lossless APP1 insert, no re-encode) | Same reason. Echo-3 requires these to strictly increase and to sit in the first 64 KiB. Fallback: about 5 lines of ImageIO in Swift if the backend insert proves awkward |
| ZIP assembly | **Backend** | See "Where the ZIP is built" |

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────── iPhone (Expo app, virtumetry/) ────────────────────────────────┐
│                                                                                                 │
│  ┌─────────────────────────┐   events (10 Hz)   ┌──────────────────────────────────────────┐   │
│  │ virtumetry-capture      │ ─────────────────▶ │ Capture screen (TS)                      │   │
│  │ (local Expo module,     │ ◀───────────────── │  coverage/guidance, HUD, pre-check,      │   │
│  │  Swift: ARKit, gate,    │  start(config)/stop│  quote + "approve up to N credits"       │   │
│  │  blur, JPEG, manifest)  │                    └──────────────┬───────────────────────────┘   │
│  │  ── or ──               │                                   │                               │
│  │ FixtureCaptureSource    │ (Expo Go: replays a recorded session from disk)                   │
│  └───────────┬─────────────┘                                   ▼                               │
│              │ writes                              ┌──────────────────────────────────────────┐ │
│              ▼                                     │ Upload manager (TS, app-scoped singleton)│ │
│  Documents/sessions/{id}/                          │  expo-file-system File.createUploadTask  │ │
│    session.json  frames.jsonl  frames/*.jpg ──────▶│  (sessionType 'background') per frame,   │ │
│                                                    │  reconcile from server truth on launch   │ │
│                                                    └──────────────┬───────────────────────────┘ │
│  ┌──────────────────────────┐  ┌───────────────────────────┐      │                             │
│  │ Library / scan states    │  │ Viewer ('use dom' comp.)  │      │                             │
│  │ (polls GET /v1/scans)    │  │  splat + collider walk,   │      │                             │
│  └──────────────────────────┘  │  floorplan + measure      │      │                             │
│                                └───────────────────────────┘      │                             │
└──────────────────────────────────────────────┬────────────────────┼─────────────────────────────┘
                     HTTPS (session JWT)       │                    │ presigned PUT (direct)
                                               ▼                    ▼
┌──────────────────────── backend/ (Railway: api + worker) ───────────┐   ┌──── Cloudflare R2 ────┐
│  Fastify API                         Worker (Postgres job queue)     │   │ captures/{cid}/...    │
│   /v1/auth/apple → session JWT        pack   → ZIP + validate        │──▶│ bundles/{cid}/*.zip   │
│   /v1/scans (create/list/get/del)     submit → Echo-3 POST (money)   │   │ worlds/{wid}/v{n}/... │
│   /v1/scans/:id/uploads(:missing)     track  → poll/exports/rehost   │   │ fixtures/...          │
│   /v1/scans/:id:cancel / :retry       purge  → retention             │   └──────────▲────────────┘
│   /v1/scans/:id/share (create/revoke)                                │              │ Range GET
│   /v1/public/s/:slug  (no auth)       ReconProvider: mock | echo3    │              │ (presigned, 6 h)
│   /v1/webhooks/spaitial (HMAC)  ──nudge──▶ track job run_after=now   │   ┌──────────┴────────────┐
│                                                                      │──▶│ SpAItial Echo-3 API   │
│  Neon Postgres: users, worlds, captures, jobs, credit_events,        │◀──│ (webhooks → backend)  │
│                 share_slugs, webhook_deliveries                       │   └───────────────────────┘
└──────────────────────────────────────────────────────────────────────┘
                                               ▲
                                               │ GET /v1/public/s/:slug → short-lived signed asset URLs
┌──────────────────── Public share page (same Expo Router app, web export) ──────────────────────┐
│  src/app/s/[slug].tsx → same Viewer component rendered as plain DOM in any browser               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Owns | Talks to | Implementation |
|---|---|---|---|
| **virtumetry-capture** (native module) | ARSession, keyframe gate, predicted-blur reject, JPEG encode, `frames.jsonl` append, preview `View` | JS via Expo Modules API events/functions. Writes to disk | `npx create-expo-module --local` under `virtumetry/modules/`. Swift ported from VirtSpace `ARKitCaptureSource.encode`, `ThermalGovernor`, `CaptureEngine+Pose`. Drop target dots, pivot, exposure-lock dwell and LiDAR depth, which belonged to the pano flow |
| **FixtureCaptureSource** (TS) | Same TS interface as the native module. Replays a recorded session (copies files into `Documents/sessions/`, emits pose/keyframe events on a timer) | Disk, capture screen | Selected when `requireOptionalNativeModule('VirtumetryCapture')` returns null, i.e. in Expo Go. **This is what makes phases before Apple-membership testable** |
| **Capture screen / coverage** (TS) | Guidance, "good enough" verdict, pre-check, quote display, approval of max credits | Capture source, API (`GET /v1/quote`) | Expo Router screen + Reanimated HUD |
| **Upload manager** (TS) | Turning a finished session on disk into objects on R2, resumable, app-scoped (not tied to any view's lifecycle; VirtSpace lesson in `UploadManager.swift`) | Backend (presigns, `:missing`, `:complete`), R2 (PUT) | `expo-file-system` `File.createUploadTask(url, {sessionType:'background', httpMethod:'PUT', headers})` |
| **Library / scan state** (TS) | List + detail, states, retry/cancel/delete actions | Backend | Fetch + poll on focus. No state library needed (`useSyncExternalStore` or a tiny store) |
| **Viewer** (TS, DOM component) | Splat rendering with LOD/budget, collider walk, floorplan overlay, measure | Signed asset URLs only | One `'use dom'` component used inside the app (Expo DOM webview, works in Expo Go) and rendered as plain DOM on the share page. Renderer choice is in STACK.md |
| **Backend API** (Fastify) | Auth, ownership checks, presigns, scan CRUD, share links, webhook intake | Neon, R2, job queue | Fork of VirtSpace `src/routes/*` |
| **Worker** | Job kinds `pack`, `submit`, `track`, `purge` | Neon, R2, ReconProvider | Fork of VirtSpace `src/worker.ts` + `queue.ts` (lease, heartbeat, SKIP LOCKED, backoff, DLQ kept as-is) |
| **ReconProvider** | Vendor-neutral reconstruction contract | Echo-3 HTTP, or fixtures | `mock` and `echo3` now. `selfhosted` later fits the same shape |
| **Budget ledger** | Daily credit cap, atomic reservation, compensating release | Neon | VirtSpace `budget.ts` kept; reservation keyed on `submission_key` (see state machine) |

---

## Recommended Project Structure

```
Virtumetry/
├── .planning/
├── virtumetry/                     # Expo app (SDK 58) — also builds the web share page
│   ├── modules/
│   │   └── virtumetry-capture/     # local Expo module: ios/*.swift, src/index.ts, expo-module.config.json
│   ├── src/
│   │   ├── app/                    # routes only
│   │   │   ├── (auth)/sign-in.tsx
│   │   │   ├── (app)/_layout.tsx   # auth-guarded: library, capture, scan/[id], viewer/[id]
│   │   │   └── s/[slug].tsx        # PUBLIC share route, outside the auth guard
│   │   ├── capture/                # source interface, FixtureCaptureSource, coverage.ts, precheck.ts
│   │   ├── upload/                 # uploadManager.ts, sessionStore.ts (reads Documents/sessions)
│   │   ├── api/                    # client.ts, types.ts (hand-copied contract types)
│   │   └── viewer/                 # Viewer.dom.tsx ('use dom'), floorplan.ts, measure.ts
│   └── app.json
├── backend/                        # fork of VirtSpace backend, stitcher/ + worldlabs + depth removed
│   ├── src/
│   │   ├── provider/{types,mock,echo3,index}.ts
│   │   ├── bundle/{manifest,convert,exif,pack}.ts   # session manifest → Echo-3 capture_bundle
│   │   ├── routes/{scans,uploads,share,public,webhooks,auth,...}.ts
│   │   ├── worker.ts  queue.ts  budget.ts  storage/
│   │   └── db/schema.ts
│   └── test/fixtures/tiny-session/ # ~30 small frames + frames.jsonl, committed
└── (no web/ in v1)                 # the share page is an Expo Router web route; add web/ only if SSR/OG tags are needed
```

### Structure Rationale

- **Share page inside the app repo:** Expo Router web export plus a DOM-component viewer gives one viewer codebase for phone and browser. A separate `web/` package would mean maintaining two viewers. Deploy `npx expo export -p web` to Cloudflare Pages or EAS Hosting. Ceiling: no server-rendered OG preview cards. Add `web/` or an edge function when link previews matter.
- **No npm workspaces:** Metro and workspaces cause friction, and the shared contract is small. Hand-copy `api/types.ts` and keep zod validation on the backend. Upgrade path: a `packages/contract` workspace if the copy starts to drift.
- **Local Expo module, not a separate npm package:** it is only used by this app, and autolinking picks up `modules/` automatically.
- **Fixtures:** a tiny committed fixture runs in CI. Full-size fixture sessions (hundreds of MB) and recorded Echo-3 outputs go under `fixtures/` in a **dev** R2 bucket, never in git.

---

## Contracts

### On-disk session format (canonical; also the fixture format and the backend pack input)

```
Documents/sessions/{sessionId}/
  session.json    { sessionId, schema: 1, device, appVersion, imageWidth, imageHeight,
                    startedAtISO, tzOffset, gateConfig }
  frames.jsonl    one line per KEPT frame:
                  { i: 1, file: "frames/000001.jpg", t: <ARFrame.timestamp s>,
                    wallMs: <epoch ms>, T_arkit: [16 floats, column-major camera.transform],
                    K: { fx, fy, cx, cy }, tracking: "normal", blurPx: 12.3, expS: 0.008 }
  frames/000001.jpg …            (1-indexed, contiguous, identical size, no EXIF Orientation)
```

The phone stores **raw ARKit values**. The backend turns them into Echo-3 files. The schema is versioned so old fixtures keep working.

### Capture module TS surface (keep it this small)

```ts
interface CaptureSource {
  isAvailable(): boolean;
  start(cfg: { minDtS: number; minMoveM: number; minRotDeg: number; maxBlurPx: number }): Promise<{ sessionId: string }>;
  stop(): Promise<{ sessionId: string; frameCount: number }>;
  cancel(): Promise<void>;
  addListener(e: 'pose' | 'keyframe' | 'tracking' | 'thermal', cb: (p: any) => void): Subscription;
}
// <CapturePreview style={...} />  native view; a placeholder <View> in the fixture source
```

### ReconProvider (backend)

```ts
interface ReconProvider {
  readonly mode: 'mock' | 'echo3';
  limits(): Promise<{ minFrames: number; maxFrames: number }>;             // free
  quote(frameCount: number): Promise<{ credits: number; available?: number; etaS?: number }>; // free
  submit(req: SubmitBody, idempotencyKey: string): Promise<{ requestId: string }>; // SPENDS
  status(requestId: string): Promise<{ state: 'pending'|'processing'|'completed'|'failed'|'cancelled';
                                       error?: { code: string; message: string }; issues?: unknown[] }>;
  ensureExport(requestId: string, type: 'mesh-simplified' | 'floorplan'): Promise<'ready'|'pending'|'failed'>;
  artifacts(requestId: string): Promise<Artifact[]>;   // permanent API URLs, resolved fresh per download
  open(artifact: Artifact): Promise<ReadableStream>;   // follows the 302 to a ~5-min signed URL, streams
  cancel(requestId: string): Promise<void>;            // safe to retry
  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookEvent | null;
}
```

`mock`: validates the ZIP by reading its central directory **through the presigned Range URL**, which also tests R2 Range support for free. It completes after a configurable delay, serves recorded outputs from `fixtures/` (at first a public sample SPZ, later a real recorded Echo-3 run), and can POST a correctly signed webhook to our own endpoint so the HMAC path gets exercised. Reconciliation by display name (VirtSpace `findWorldByDisplayName`) is **deleted**. Echo-3's `Idempotency-Key` replaces it.

---

## Where the ZIP Is Built: Backend (decided)

| | Phone builds ZIP | **Backend builds ZIP (recommended)** |
|---|---|---|
| Upload unit | One 200–800 MB file | One ~0.4–0.7 MB JPEG per frame (400–1200 frames) |
| Resume after kill/network loss | Restart the whole file, or implement multipart on the phone | Re-PUT only the missing frames (idempotent same-key PUT) |
| Disk on phone | 2x (frames + zip) | 1x |
| Native code | Needs a zip library or Swift code | None |
| Format bugs (EXIF, pose sign, naming) | Need an EAS rebuild | Railway deploy |
| Pre-flight validation (VirtSpace lesson: World Labs 422s failed silently) | On device only | Authoritative, server-side, before any money moves |
| Mock / fixtures / future self-hosted | Separate path | Same pipeline |

**Pack job:** list `captures/{cid}/frames/`, check it against `frames.jsonl`, stream each JPEG from R2, insert EXIF, then stream into a **store-only** ZIP (JPEGs don't compress), piped into an R2 multipart upload (`@aws-sdk/lib-storage` `Upload`). Memory stays bounded and nothing is buffered whole. Validate on the way through: identical dimensions, long edge ≤ 1920, short edge ≥ 360, contiguous 1-indexed names, strictly increasing timestamps, `fx/fy ∈ [100, 10000]`, `0 < cx < w`, frame count within `limits()`. Any violation fails as `failed/validate` with 0 credits spent.

**Per-frame presigned PUTs, not chunked archives.** VirtSpace already has the full pattern (`presignFrameUploads`, `uploads:refresh`, exact `Content-Length` signing). Changes needed:
- Presign **on demand in batches** (`POST /v1/scans/:id/uploads {indices:[...]}`) instead of returning 1000 URLs in the create response.
- Raise the PUT presign TTL from 900 s to around 6 h. Background tasks queued by iOS can start long after they were enqueued, and R2 allows up to 7 days. The 403 → re-presign path stays as a backstop.
- Add `GET /v1/scans/:id/uploads:missing`, implemented with ListObjectsV2 on the prefix (a new `listKeys(prefix)` on `StorageDriver`). **R2 is the source of truth for what has been uploaded**, not client bookkeeping.

**Range-capable presigned GET for Echo-3:** `presignDownload(bundleKey, 6 * 3600)`. That is well above Echo-3's ≥2.5 h requirement and below R2's 7-day maximum. It must use the `*.r2.cloudflarestorage.com` S3 endpoint, because R2 presigned URLs do not work on custom domains. S3-style presigned GETs honour `Range` since the header isn't signed. R2's presign page doesn't state this explicitly, so the mock provider's Range read of the central directory is the check (MEDIUM).

---

## Background Uploads on SDK 58: Use expo-file-system, Reconcile From the Server

From the SDK 58 docs (HIGH): `File.createUploadTask(url, options)` with `UploadOptions.sessionType` defaults to `'background'` on iOS, so the native transfer continues while the app is suspended. **However, "the JavaScript UploadTask instance is not restored if the app is terminated or relaunched."** Promises and progress only work while the original JS runtime is alive.

Consequence: you do **not** need the native module to own uploads. You only need to stop trusting client-side completion callbacks:

1. Enqueue **all** remaining frame PUTs at once. VirtSpace learned this: serial uploads stop once the app is suspended, because the next task is never created.
2. On every launch and foreground: for each local session not yet confirmed complete, call `uploads:missing`. Re-enqueue what's missing. If nothing is missing, call `:complete`. A frame that finished in the background after a kill counts automatically. One that was in flight gets re-PUT to the same key, which is harmless.
3. Upload `frames.jsonl` + `session.json` **last**. The server's `:complete` checks that every listed frame exists.
4. Delete the local session only after the server reports `packing` or later. Raw frames on the phone are the only copy until then.

Limits to state honestly:
- If the user swipes the app away, iOS cancels background-session tasks. That is OS behaviour, and step 2 recovers on the next launch.
- Whether background sessions run correctly *inside Expo Go*, where Expo Go owns the session identifier, is unverified (LOW). Only the reconciliation path needs to work in Expo Go. Background survival gets verified in the first dev build.
- Upgrade path, only if measurement shows losses: move uploads into the capture module (port `BackgroundUploadCoordinator` from VirtSpace `Core/Upload/FrameUploader.swift`, including `handleEventsForBackgroundURLSession`). Do not do this up front.

Upload is free. The **spend gate is separate**: the user approves "up to N credits" (N = 900 + frameCount, confirmed by `GET /v1/quote`, which proxies `process-quote`) on the review screen, and that approval is stored at scan create. The upload can then finish, and the pipeline can submit, without the user waiting on the screen.

---

## Data Flow

### Capture → ready (happy path)

```
[Walk room]
  Swift gate/blur/JPEG ─▶ Documents/sessions/{sid}/ (frames.jsonl append per frame)
  Swift events ─▶ TS coverage HUD ─▶ "good enough" ─▶ stop()
      ↓
[Review] TS precheck (count, blur ratio, coverage) + GET /v1/quote → user approves ≤ N credits
      ↓
POST /v1/scans  (Idempotency-Key: sid, {frame_count, approved_max_credits})  → world row status=uploading
      ↓
POST /uploads {indices} → presigned PUTs → background PUT ×N ─▶ R2 captures/{cid}/frames/
PUT manifest last ─▶ POST /v1/scans/:id:complete (server verifies all keys) → status=packing, enqueue pack
      ↓
[pack]   R2 frames ─▶ EXIF + convert poses ─▶ store-ZIP ─▶ R2 bundles/{cid}/capture_bundle.zip
         → status=submitting, enqueue submit
      ↓
[submit] quote ≤ approved? → reserve ledger → POST /v1/worlds (Idempotency-Key) → persist request_id
         → status=processing, enqueue track
      ↓
[track]  every ~60 s (snoozed; the webhook nudges it to run now) GET status
         COMPLETED → ensureExport(mesh-simplified), wait for floorplan READY
         → stream artifacts ─▶ R2 worlds/{wid}/v{n}/ → status=ready (single UPDATE with all keys)
      ↓
[App] library poll sees ready → Viewer loads signed URLs (TTL ~1 h)
```

### Webhook flow (accelerator only, never authoritative)

```
SpAItial ─POST─▶ /v1/webhooks/spaitial  (raw body; no JSON parse before HMAC)
   verify X-Spaitial-Signature = "sha256=" + HMAC(webhook_secret, rawBody), constant-time
   INSERT webhook_deliveries(delivery_id) ON CONFLICT DO NOTHING   ── duplicate → 200, stop
   UPDATE jobs SET run_after=now() WHERE kind='track' AND world_id=(lookup by request_id) AND phase='queued'
   reply 200 within milliseconds  (SpAItial needs 2xx in < 30 s, retries ×5)
```

Only the `track` job writes world state. It always re-reads `status()` from the API. That means one writer, out-of-order and duplicate webhooks don't matter, local dev works without a tunnel (polling only), and the mock never needs webhooks.

### Share flow

```
Owner: POST /v1/scans/:id/share → share_slugs(slug = 22-char base64url of 16 random bytes) → https://<web>/s/{slug}
Visitor: GET /s/{slug} (static web app) → GET /v1/public/s/{slug}
   → 404 if missing / revoked_at set / world not ready / world deleted
   → { title, floorplan meta, assets: { splat, collider, floorplan }: presigned GETs, TTL ~1 h }
Owner: DELETE /v1/scans/:id/share → revoked_at=now()  (existing signed URLs die within their TTL)
```

The `share_slugs` table already exists in the VirtSpace schema. R2 needs a CORS rule allowing GET + Range from the web origin. Assets stay in a **private** bucket. A public bucket with unguessable keys could not be revoked.

---

## Echo-3 Job State Machine

### World (scan) status, as seen by the app

```
uploading ─▶ packing ─▶ submitting ─▶ processing ─▶ importing ─▶ ready
    │           │            │             │             │
    ▼           ▼            ▼             ▼             ▼
  failed{stage, code, message, retryable, charged}      cancelled
```

Columns added to `worlds`: `approved_max_credits`, `quoted_credits`, `submission_key uuid`, `submit_body jsonb`, `provider_request_id` (unique index), `failure_stage`, `failure_code`, `failure_message`, `charged bool`, and asset keys (`splat_key`, `collider_key`, `floorplan_key`, `floorplan_raw_key`, `floorplan_meta jsonb`, `cameras_key`, `thumbnail_key`). `captures` gets `manifest_key`, `bundle_key`, `bundle_bytes`, `image_w/h`. New table: `webhook_deliveries(delivery_id pk, request_id, event, received_at)`.

### submit job: the only money path

```
1  world.provider_request_id set?            → done; ensure a track job exists. (resume)
2  submission_key null?                       → UPDATE … SET submission_key=gen_random_uuid() WHERE submission_key IS NULL
3  quote = provider.quote(frames)             → required > approved_max or !has_enough → failed/submit (charged=false), park dead
4  reserveCredits(required, key=submission_key)  ON CONFLICT(submission_key) DO NOTHING  (budget cap → park dead)
5  submit_body null?                          → build {model:'echo-3', output_format, input:{type:'capture_bundle',
                                                 zip:{type:'url', zip_url: presign(6h)}}, webhook:{url}}; PERSIST it
6  provider.submit(submit_body, submission_key)    ← body sent BYTE-IDENTICAL on every retry
      202 → persist request_id + status=processing + enqueue track   (one transaction)
      timeout / 5xx / 429        → retryable (same key + same body ⇒ provider replays the original 202)
      400/422 INVALID_INPUT etc. → release reservation; failed/submit; park dead
      402 INSUFFICIENT_CREDITS   → release; failed/submit (code shown to owner)
      409 IDEMPOTENCY_KEY_REUSED → park dead + alert (body drifted = our bug; NEVER mint a new key automatically)
```

Why step 5 exists: the presigned ZIP URL changes on every presign. Echo-3 rejects the same key with a different body (`409 IDEMPOTENCY_KEY_REUSED`), so a naïve retry that re-presigns would hit that error. Persisting the exact body keeps retries safe. If the very first send never reached SpAItial and the URL has expired by the time of a retry, Echo-3 fails async validation, which is documented as 0 credits charged.

This replaces VirtSpace's `pending:` marker + display-name reconciliation + "a generate failure is non-retryable" logic. With a provider-side idempotency key, an ambiguous failure becomes **retryable** rather than "park for a human". **Open risk:** the idempotency retention window isn't documented. Keep every automatic submit retry within ~1 h (cap backoff at 15 min for `submit`, 4 attempts), and confirm the window with SpAItial before the first paid run.

### track job: long-running, lease-friendly

Processing takes 30 min–2 h, so do **not** hold a lease and poll in-process (VirtSpace's `runGeneration` loop with a 900 s ceiling). Add one queue primitive:

```ts
// queue.ts — reschedule without consuming the attempt budget
snoozeJob(jobId, seconds): UPDATE jobs SET phase='queued', locked_at=NULL, locked_by=NULL,
  attempts = attempts - 1, run_after = now() + seconds * interval '1 second' WHERE id=$1
```

```
status()  PENDING/PROCESSING → snooze 60 s (status=processing)
          FAILED             → failed/processing, charged=false, store error.code + validation.issues,
                               compensating release in ledger
          CANCELLED          → cancelled, release
          COMPLETED          → status=importing:
              ensureExport('mesh-simplified')  (POST; 200 if READY, 202 if started — free)
              floorplan is auto-started: GET until READY (snooze while pending)
              for each artifact not yet stored at worlds/{wid}/v{n}/<name>:
                  open() → stream → R2 multipart   (idempotent per key; resumes artifact-by-artifact)
              single UPDATE: all asset keys + status=ready + charged=true
          no terminal state after 6 h → alert, keep polling. Never resubmit, never auto-cancel.
```

Output URLs are permanent API proxy routes that 302 to ~5-minute signed URLs. Store the API route and resolve right before each download, streaming straight into R2. VirtSpace's `downloadAsset(): Buffer` must become a stream, because mesh PLYs can be large. SpAItial's output retention isn't documented, so import immediately on completion. After import, optionally `DELETE` the SpAItial world for privacy (decide in the retention policy).

### User actions and the never-double-charge rules

| Action | Allowed in | Effect | Money |
|---|---|---|---|
| Retry upload | `uploading`, `failed/upload` | Re-run reconciliation | Free |
| Retry pack | `failed/pack`, `failed/validate` (if fixable server-side) | Re-enqueue pack | Free |
| Retry processing | `failed/processing`, `failed/submit` (non-409) | **New** `submission_key` + new `submit_body`, fresh quote, **explicit re-approval in the app** | New charge only if it succeeds (failed/cancelled Echo-3 runs spend 0 credits per SpAItial billing docs) |
| Retry import | `failed/import` | Re-enqueue track (resumes at COMPLETED) | Free |
| Cancel | before `processing` | Drop jobs, status=cancelled | Free |
| Cancel | `processing` | `POST …/cancel` (safe to retry). `409 REQUEST_NOT_CANCELLABLE` means it finished, so import anyway | 0 if cancelled |
| Delete | any | Cancel first if processing, soft-delete, enqueue purge | — |

No automatic path ever creates a new `submission_key`. Only a user's Retry-processing does. VirtSpace's `frames:done` replay guard (flip status only from allowed states, in one statement) carries over to `:complete` and `:retry`.

---

## Auth Boundaries

| Boundary | Mechanism |
|---|---|
| App → API | `POST /v1/auth/apple {identityToken}` → backend verifies with Apple JWKS (VirtSpace `verifyAppleToken`), checks the `apple_sub` against an **owner allowlist env** (no public sign-up in v1), and issues its own session JWT (jose is already a dependency). **Do not** send the Apple identity token on every request as VirtSpace does: Apple identity tokens are short-lived (~10 min), so sessions would break. The JWT audience list must include Expo Go's bundle id during Expo Go phases (`expo-apple-authentication` works in Expo Go per the v58 docs; check the exact `aud` claim on device). Keep `AUTH_MODE=dev` for local/CI only. It already refuses to start under `NODE_ENV=production` |
| App → R2 | Presigned PUT per object, scoped to `captures/{cid}/frames/{i}.jpg`, exact Content-Length signed |
| Echo-3 → R2 | One presigned GET for the bundle, 6 h |
| SpAItial → API | HMAC on the raw body + `delivery_id` dedupe. No other auth. The route is excluded from the auth hook and rate-limited separately |
| Browser → API | `/v1/public/s/:slug` only: read-only, returns signed GETs, no PII (no owner name/email/location) |
| Worker → Echo-3 | Bearer `spt_live_…` key in Railway env, **only in the prod service**. Dev/CI run `PROVIDER_MODE=mock`, and `echo3` mode refuses to boot without an explicit `ALLOW_PAID_PROVIDER=1` (VirtSpace lesson: agents burned quota) |

---

## R2 Storage Layout

```
captures/{captureId}/frames/000001.jpg …     raw frames as uploaded (no EXIF)        purge: ready + 7 d, or on delete
captures/{captureId}/frames.jsonl, session.json                                    same
bundles/{captureId}/capture_bundle.zip        exactly what Echo-3 received          purge: ready + 7 d, or on delete
worlds/{worldId}/v{assetVersion}/
    splat.{spz|sog}  collider.ply  floorplan.png  floorplan_raw.png
    floorplan.json   cameras.json  thumbnail.jpg                                   kept until world deleted
fixtures/  (dev bucket only)  sessions/{name}/…   echo3-outputs/{name}/…
```

Separate buckets for dev and prod, matching the separate Neon DB and Railway project. VirtSpace's `purge` job kind is reused with an explicit retention clock (VirtSpace lesson: frames were kept forever despite the promised purge).

---

## Architectural Patterns

### Pattern 1: Fixture-replay capture source
**What:** A TS implementation of the capture interface that replays a recorded session from disk with realistic timing.
**When:** Always in Expo Go. In dev builds, available from a debug menu.
**Trade-offs:** The viewport preview is fake, but every TS layer (coverage, pre-check, upload, state machine, viewer) runs unchanged on device before the Apple membership is bought.

### Pattern 2: Server truth reconciliation for uploads
**What:** Don't track completion in the client. Ask R2 (via the API) what's missing.
**When:** Background transfers whose JS callbacks can be lost.
**Trade-offs:** One ListObjectsV2 per resume, which is negligible at this scale.

### Pattern 3: Persist-before-spend + provider idempotency key
**What:** Persist `submission_key` and the exact `submit_body` before the first POST, and persist `request_id` in the same transaction as the next state.
**When:** Every money-spending call.
**Trade-offs:** None worth mentioning. This is the whole credit-safety story, and it is simpler than VirtSpace's reconciliation.

### Pattern 4: Webhook-as-nudge, poll-as-truth
**What:** Webhooks only shorten the next poll's `run_after`.
**Trade-offs:** Up to ~3 s of status caching, which SpAItial documents. Status updates are not instant, which doesn't matter for a 30 min–2 h job.

### Pattern 5: Snooze, don't sleep
**What:** Long waits are rescheduled jobs (`snoozeJob`), not in-process loops holding a lease.
**Trade-offs:** Needs one new queue function. It removes the lease/heartbeat race VirtSpace had to patch (§10 R6) for this job kind.

---

## Anti-Patterns

### Anti-Pattern 1: Converting poses/EXIF in Swift
**What people do:** Do the OpenCV conversion and EXIF writing on device, "closest to the data".
**Why it's wrong:** One sign error costs an EAS build, an install and a fresh capture to verify, against a free tier of 15 builds a month.
**Do this instead:** Raw ARKit values to disk. Convert in `backend/src/bundle/convert.ts`, covered by a vitest that round-trips a known pose.

### Anti-Pattern 2: Re-presigning inside a retried create
**What people do:** Build the POST body fresh on each attempt.
**Why it's wrong:** A new presigned URL makes a different body, which triggers `409 IDEMPOTENCY_KEY_REUSED`. The tempting "fix" is a new key, and that is how you double-charge.
**Do this instead:** Persist `submit_body` once and resend it verbatim.

### Anti-Pattern 3: Webhook handler that mutates world state
**Why it's wrong:** At-least-once delivery, possible reordering, and a 30 s response limit. Two writers race.
**Do this instead:** Verify, dedupe, nudge, 200.

### Anti-Pattern 4: Holding a lease for a 2-hour poll
**Why it's wrong:** Lease expiry vs heartbeat races, plus a dead worker for hours.
**Do this instead:** `snoozeJob`.

### Anti-Pattern 5: Buffering artifacts in memory
**Why it's wrong:** Mesh/PLY outputs can run to hundreds of MB, and a Railway worker gets OOM-killed. VirtSpace's `downloadAsset` returns a `Buffer`.
**Do this instead:** fetch → `ReadableStream` → lib-storage multipart.

### Anti-Pattern 6: Upload tied to a screen
**Why it's wrong:** The VirtSpace root cause is documented in `UploadManager.swift`: navigation cancelled the flow mid-way and stranded the world.
**Do this instead:** An app-scoped singleton started from the root layout and resumed on `AppState` → active.

### Anti-Pattern 7: Auth guard wrapping the share route
**Do this instead:** `s/[slug].tsx` sits outside the `(app)` group.

---

## Integration Points

### External Services

| Service | Pattern | Notes |
|---|---|---|
| SpAItial Echo-3 | REST + HMAC webhooks | `POST /v1/worlds` → 202 `{request_id, status_url, response_url, cancel_url}`. Status `GET /v1/worlds/requests/{id}/status` (PENDING/PROCESSING/COMPLETED/FAILED; poll ≥5–10 s, cached ~3 s). Exports `POST/GET /v1/worlds/requests/{id}/exports/{mesh-simplified|floorplan}`, floorplan auto-started; floorplan JSON has `world_xz_from_pixel`/`pixel_from_world_xz` (row-major 3x3, pixel centres +0.5). Artifacts 302 → ~5-min URLs. `output_format` is chosen per request (spz default, sog, ply). Raw SPZ is RDF (y-down); converted sog/ply are already +Y up. Exports and failed/cancelled runs cost 0 credits |
| Cloudflare R2 | S3 API via existing `storage/s3.ts` | Presign max 7 days. Presign only on the S3 endpoint, not custom domains. Add `listKeys` and a streaming multipart upload. CORS for the web origin |
| Neon | Existing drizzle client | New project/DB. Never `SET` session vars through the pooler (VirtSpace lesson) |
| Apple Sign In | `expo-apple-authentication` → backend JWKS verify | Works in Expo Go |
| Push (APNs) | **Deferred.** VirtSpace `push.ts` is a stub | The library polls on foreground. Add `expo-notifications` once dev builds exist |

### Internal Boundaries

| Boundary | Communication | Notes |
|---|---|---|
| Swift module ↔ TS | Expo Modules API: async functions + events + one native View | Events throttled to ≤10 Hz. No pixel data crosses the bridge |
| TS capture ↔ upload manager | Filesystem (`Documents/sessions/{id}`) + session id | The disk format is the contract, so either side can be swapped for fixtures |
| App ↔ Viewer DOM component | Serializable props (signed URLs, floorplan meta) + top-level async actions (`onMeasure`) | Props re-render the whole DOM tree, so keep them stable. Per the docs, low-power mode throttles webview frame rate |
| API ↔ worker | Postgres `jobs` table only | Same process image, two Railway services (as in VirtSpace) |
| Worker ↔ provider | `ReconProvider` interface | No Echo-3 types leak outside `provider/echo3.ts` |

---

## Suggested Build Order

Constraints: Windows only, EAS free tier, **no Apple Developer membership until the native phase**. So phases 1–5 must run in Expo Go (iPhone) + web + backend tests.

| # | Phase | Testable via | Depends on | Notes |
|---|---|---|---|---|
| 1 | **Backend fork & isolation**: copy VirtSpace backend, strip stitcher/World Labs/depth, new Neon/Railway/R2 (dev + prod buckets), CI green, paid-provider boot guard | vitest, Railway | — | Mostly deletion |
| 2 | **Session format + bundle pipeline**: `frames.jsonl` schema, `convert.ts` (ARKit→OpenCV), EXIF insert, streaming store-ZIP to R2, validator, Range presign check, `snoozeJob`, `ReconProvider` + new mock | vitest with the tiny committed fixture | 1 | Defines the contract every later phase uses. **Fixture source:** convert a public posed RGB dataset (ARKit-recorded, ≥360 px short edge) into the session format. No Echo-3 spend needed |
| 3 | **Auth + scan API + app shell**: Apple sign-in → session JWT + allowlist, scans CRUD, upload presign/missing/complete, library with states | Expo Go + vitest | 1 | Real auth from day one (VirtSpace lesson) |
| 4 | **Upload manager + fixture capture source**: "import fixture scan" → background PUTs → reconcile → pack → mock submit/track → ready | Expo Go end to end, $0 | 2, 3 | Proves the whole loop without native code |
| 5 | **Viewer, floorplan, measure, share page**: DOM-component viewer with LOD, collider walk, floorplan overlay, public `/s/[slug]`, revoke | Expo Go + browser, using a public sample splat, then recorded outputs | 3 (4 for real data) | Can run in parallel with 4. Performance on iPhone 17 Pro needs early measurement |
| 6 | **Live Echo-3 provider**: `echo3.ts`, submit/track/import, webhook route, budget caps, cancel/retry UX | Mocked HTTP contract tests, then **one paid run** with the converted dataset bundle (an async validation failure costs 0) | 2, 4 | Record that run's outputs into `fixtures/echo3-outputs` and point the mock at them. Confirm the idempotency window with SpAItial first |
| 7 | **Native capture module** (buy Apple Developer here): port engine, gate, blur, JPEG, manifest, preview view, then one EAS dev build | EAS dev build on iPhone | 2 (format), 4 (pipeline) | **Batch** all native work. Gate thresholds come from JS. Coverage stays in TS, already built against the fixture source in 4. Budget about 3–5 builds |
| 8 | **Hardening**: retention/purge clocks, privacy manifest + consent, background-upload survival verified on device, budget alerts, delete-from-SpAItial policy | Device + vitest | all | — |

**Ordering rationale:**
- The session format (phase 2) comes first because the native module, the fixture source, the upload manager and the pack job all meet at it. Getting it right early means phase 7 only has to *produce* files that already work end to end.
- Live Echo-3 (6) comes after the mock loop (4) so the first real dollars test the provider adapter, not plumbing bugs.
- Native (7) comes last among features because it is the only phase that needs money (Apple $99), EAS builds, and the device. By then every downstream consumer is proven, so a bug found in phase 7 can only be in Swift.

**Research flags for phases:**
- Phase 2: find and convert a suitable public posed dataset (resolution, ARKit poses, timestamps). Confirm the exact `per_frame_intrinsics.json` / `camera_trajectory.json` schemas on docs.spaitial.ai.
- Phase 5: splat renderer LOD on iPhone 17 Pro in a webview, and SPZ vs SOG (this decides `output_format`). See STACK.md.
- Phase 6: Echo-3 idempotency window, rate limits page, whether `mesh-simplified` is free (the billing page lists "Mesh" only), and output retention on SpAItial's side.
- Phase 7: ARKit 1920x1440 video-format availability on iPhone 17 Pro, and portrait vs landscape storage (`orientation.json: {"orientation":"identity"}` applies to upright portrait frames). Review SpAItial's open "Capture iOS prototype" repo before porting.
- Phases 1, 3, 4: standard patterns already proven in VirtSpace. Little extra research needed.

---

## Scaling Considerations

| Scale | Adjustments |
|---|---|
| 1 owner (v1) | One API + one worker on Railway, polling 60 s. Nothing else |
| 10–100 brokers | Per-user budget (today it's a global daily cap), multiple workers (SKIP LOCKED already handles it), push notifications, R2 lifecycle rules in place of the purge job |
| 1k+ | Echo-3's 10 creates/min becomes a queue concern (add a token bucket on `submit`). Splat CDN (R2 custom domain + signed-URL alternative such as WAF HMAC). Multi-room `zips[]` |

**First bottleneck:** upload time on cellular for 200–800 MB. Mitigate with Wi-Fi-preferred guidance and keyframe discipline. Echo-3 recommends 3–5 frames/s, so don't over-capture.
**Second:** worker memory on artifact import. Avoided by streaming from the start.

---

## Sources

- docs.spaitial.ai: `/api/capture-worlds` (bundle format, limits, process-quote, async validation = 0 credits), `/api/worlds` (Idempotency-Key replay / `409 IDEMPOTENCY_KEY_REUSED`, statuses, cancel, 302 artifact URLs), `/api/webhooks` (events, `X-Spaitial-Signature: sha256=…` over raw body, `X-Spaitial-Delivery-ID`, 5 retries, 30 s), `/api/exports` (export endpoints, floorplan affine fields, coordinate frames), `/billing/credits-and-plans` (exports free; failed/cancelled spend 0). HIGH
- https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/: `File.createUploadTask`, `sessionType` default `'background'`, JS task not restored after termination. HIGH
- https://docs.expo.dev/guides/dom-components/: `'use dom'` supports Expo Go, runs as plain DOM on web, `@expo/dom-webview` default on SDK 56+. HIGH
- https://docs.expo.dev/versions/v58.0.0/sdk/apple-authentication/: included in Expo Go. HIGH (audience claim in Expo Go: verify on device)
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/: 7-day max, S3 endpoint only, CORS. HIGH. Range on presigned GET: MEDIUM (standard S3 behaviour, not stated on the page)
- VirtSpace source: `backend/src/{queue,worker,budget,auth}.ts`, `provider/types.ts`, `routes/worlds.ts`, `db/schema.ts`, `storage/*`. iOS `Core/Capture/{UploadManager,CaptureUploader}.swift`, `Core/Upload/FrameUploader.swift`, `Features/Capture/Engine/ARKitCaptureSource.swift`. HIGH
- https://radiancefields.com/spaitial-echo-3-api-opens-to-every-developer-account, https://apis.io/asyncapis/spaitial/spaitial-webhooks-asyncapi/ (corroborating, third party). MEDIUM

---
*Architecture research for: Virtumetry (Expo + ARKit capture → Echo-3 reconstruction → splat viewer/share)*
*Researched: 2026-11-23*
