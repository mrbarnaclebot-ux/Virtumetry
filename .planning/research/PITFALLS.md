# Pitfalls Research

**Domain:** Expo (SDK 58) iPhone app: ARKit walk-through capture, then paid SpAItial Echo-3 cloud reconstruction, then Gaussian splat viewing. Developed on Windows with no Mac, on the EAS free plan.
**Researched:** 2026-11-23
**Confidence:** MEDIUM-HIGH. Echo-3 rules come from the official docs, fetched today (HIGH). VirtSpace lessons come from that project's own ledger and handoff (HIGH for this owner and stack). ARKit and iOS behaviour come from VirtSpace device experience plus training data (MEDIUM). Items that need an experiment are flagged.

Phase names below are descriptive, because the roadmap is not written yet:
**Backend port**, **Mock provider + fixtures**, **App shell (Expo Go)**, **Native capture module**, **Upload pipeline**, **Echo-3 live**, **Viewer / walk / measure / share**, **Privacy + hardening**.

---

## Critical Pitfalls

### Pitfall 1: A semantically wrong bundle passes validation, gets billed, and returns garbage

**What goes wrong:**
Echo-3 checks structure: names, dimensions, EXIF, matrix shape, orthonormality and the bottom row. If structure fails, the job ends as `FAILED` and costs 0 credits. Some errors pass every one of those checks and still produce a broken room, and that run is billed at 900 + frames credits (about $15-19):
- poses in the wrong convention;
- intrinsics left at sensor resolution after resizing;
- pixels rotated to portrait while the poses and intrinsics are not.

**Why it happens:**
- The ARKit to OpenCV conversion has four traps:
  - **Inversion:** ARKit `camera.transform` is `world_from_camera` and has to be inverted.
  - **Multiply side:** `diag(1,-1,-1,1)` must be multiplied on the left (`D · inv(T)`). That flips the camera axes. Multiplying on the right flips the world axes instead and still produces a valid rotation.
  - **Transpose:** `simd_float4x4` is column-major. Echo-3 wants row-major. Writing `columns.0` as row 0 transposes the matrix.
  - **Units:** ARKit is already in metres. Scaling it breaks metric scale.
- `ARCamera.intrinsics` describe `camera.imageResolution` in the sensor's landscape orientation. They are not the preview, and they are not a portrait frame.

**How to avoid:**
- **Avoid resizing and rotation altogether.** Pick the 1920x1440 ARKit video format, which is what Echo-3's own Swift sample does. Save `capturedImage` in native landscape sensor orientation with no EXIF rotation, and write the intrinsics exactly as ARKit reports them. With this setup no scaling or rotation code needs to exist.
- If a different format is ever needed, multiply `fx`, `fy`, `cx` and `cy` by the same factor and update `width_px` and `height_px`. Poses do not change. Rotating pixels would also mean rotating the intrinsics (swap fx/fy, `cx' = H - cy`) and the pose (90° about camera Z). Don't do it.
- Write one pure conversion function, `arkitToOpenCV(T) -> rowMajor[16]`, with a check that fails if the logic breaks:
  - a camera at (0, 1.5, 0) looking down world -Z must give translation `t = R·(-C)`, with +Z forward and +Y down;
  - the bottom row is `[0,0,0,1]`;
  - det = +1.
- Keep a backend-side validator (TypeScript, runs on Windows) that mirrors all of Echo-3's validation rules. Add semantic checks it does not do:
  - the per-frame camera centre path is continuous (no jumps over about 0.5 m between adjacent keyframes);
  - the camera forward vector agrees with the motion direction on average;
  - intrinsics match the JPEG width and height.
- Spend the first real credits on the cheapest valid run: `min_frames` from `GET /v1/captures/limits`, so about $9 plus frames. Do this before any long scan.

**Warning signs:**
- The room comes back mirrored, upside down, or as a smeared "fog ball".
- `cameras.json` in the output disagrees strongly with the submitted trajectory.
- The floor plan is rotated or mirrored compared with reality.

**Phase to address:** Native capture module (conversion and format). Mock provider + fixtures (validator). Echo-3 live (minimum-cost first run).

---

### Pitfall 2: Double submit or blind retry spends $15-19 per mistake

**What goes wrong:**
Several paths can each launch a second billed reconstruction:
- a worker crashes between `POST /v1/worlds` and saving `request_id`;
- the app replays "upload done" after a lost response (VirtSpace R20: `frames:done` replay re-billed);
- a 5xx or timeout is retried with a new key;
- the user double-taps "Process".

**Why it happens:**
- Echo-3 idempotency only protects a reused key with a byte-identical body. A different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- A retry after `FAILED` requires a new key on purpose.
- How long Echo-3 remembers a key is not documented.

**How to avoid:**
- Derive `Idempotency-Key` from the scan id and the attempt number, and save it in the job row before the HTTP call. A resumed worker reuses the same key and body, so the call replays the original 202 response and does not create a new job.
- Build the request body deterministically. The presigned ZIP URL is part of the body, so mint it once and store it. Re-presigning on retry changes the body, which causes a 409 with the same key or a double bill with a new key.
- Treat a timeout or 5xx on create as "unknown". Retry only with the same key and the same body. Never mint a new key automatically.
- Retrying after `FAILED` needs an explicit user action with a cost confirmation. That action increments the attempt number, which produces a new key.
- Make the scan state flip a conditional transaction (`UPDATE … WHERE status IN (…) RETURNING`) in the same transaction as the enqueue. This is VirtSpace R20/R27.
- Treat 503 (intake full or paused) and 429 as "not submitted". Back off using `Retry-After` plus jitter, and reuse the key.

**Warning signs:**
- Two `request_id`s for one scan.
- The credit balance drops more than the quote said.
- A `409 IDEMPOTENCY_KEY_REUSED` appears in logs. That means the body is not deterministic.

**Phase to address:** Backend port (state machine, carry R1/R4/R20/R27 forward). Echo-3 live.

---

### Pitfall 3: The presigned ZIP URL expires or doesn't support Range, and the job fails 30+ minutes later

**What goes wrong:**
Echo-3 reads ZIP entries individually using HTTP Range requests. The URL must stay valid and unchanged for at least 2.5 h, or until the job finishes. If it doesn't, the job fails with `ZIP_URL_*`, `ZIP_RANGE_UNSUPPORTED` or `CAPTURE_INGEST_TIMEOUT`. The failure is free, but it burns hours and a retry cycle.

**Why it happens:**
- The R2 presign default is copied from the upload code, which used 900 s presigns in VirtSpace.
- A worker CDN/proxy URL is used instead of a direct R2 presign.
- A lifecycle rule or the purge job deletes the ZIP while the job is still processing.

**How to avoid:**
- Presign a direct R2 `GET` for 24 h. R2 supports Range natively.
- The ZIP must use Stored compression, since JPEGs don't compress further. Stream it to R2 and never hold it in memory: 1,000 frames is about 400 MB.
- Purge the ZIP only after the job reaches a terminal state.
- Before submitting, run a preflight on the URL from the worker: a `GET` with `Range: bytes=0-15` must return `206` with `Accept-Ranges: bytes`.

**Warning signs:** `ZIP_*` validation issues, or jobs failing at about the same elapsed time every run.

**Phase to address:** Echo-3 live (worker ZIP packer). Mock provider + fixtures (the mock should enforce the same URL rules).

---

### Pitfall 4: EXIF timestamp rules are broken by how the timestamp is created

**What goes wrong:**
Any of these produces `EXIF_MISSING` or `EXIF_TIMESTAMPS_NOT_INCREASING`:
- `DateTimeOriginal`, `SubSecTimeOriginal` and `OffsetTimeOriginal` must be strictly increasing and must sit within the first 64 KiB of the JPEG;
- duplicate milliseconds;
- `Date()` jumping backwards after an NTP correction;
- a missing `OffsetTimeOriginal`;
- an embedded thumbnail, or a large XMP/maker-note block, pushing EXIF past 64 KiB.

**Why it happens:**
- Timestamps get stamped at encode time on a background queue instead of from `ARFrame.timestamp`.
- ImageIO defaults can write a thumbnail.

**How to avoid:**
- Compute `bootEpoch = Date().timeIntervalSince1970 - ProcessInfo.systemUptime` once per session. Each frame's wall time is `bootEpoch + frame.timestamp`. That is monotonic by construction.
- Write SubSec with 3 digits. Keyframes are at least 0.12 s apart, so milliseconds never collide, but assert `ts[i] > ts[i-1]` anyway before writing.
- Always write `OffsetTimeOriginal`.
- Don't write a thumbnail, GPS or XMP.
- The backend validator re-reads the EXIF of every frame before zipping.
- Note: `ProcessInfo.systemUptime` is an Apple "required reason" API. See Pitfall 17.

**Warning signs:** The validator flags non-increasing timestamps. Timestamps cluster at encode-batch times instead of at capture times.

**Phase to address:** Native capture module. Mock provider + fixtures (validator).

---

### Pitfall 5: Passing frames or high-rate AR state across the JS bridge

**What goes wrong:**
ARKit runs at 60 Hz. Sending pixel buffers, base64 JPEGs or per-frame poses to JS freezes the UI, drops ARKit frames (ARKit warns about retaining `ARFrame`s), heats the phone and causes memory spikes. Expo Modules events at 60 Hz block React rendering, even with the New Architecture.

**Why it happens:**
"Keep logic in TypeScript" instincts. It is also tempting to draw the coverage guidance in React.

**How to avoid:**
- Native owns the hot path. Select keyframes with the motion gate (≥0.12 s, and ≥7 cm or 10°, plus the predicted-blur gate), encode JPEGs with ImageIO on a serial queue, append intrinsics and poses to on-disk JSON, and keep coverage stats natively.
- JS receives a throttled summary at most about every 5-10 Hz: tracking state, keyframe count, coverage %, blur rejections, thermal state, elapsed time, and estimated credits.
- Give JS file paths, never bytes.
- Copy `capturedImage` and release the `ARFrame` immediately. Never hold more than 1-2 frames.

**Warning signs:**
- ARKit logs "delegate is retaining N ARFrames".
- The JS FPS meter drops during capture.
- The keyframe rate falls below 3/s while walking.

**Phase to address:** Native capture module.

---

### Pitfall 6: The ARSession lifecycle is tied to a React view

**What goes wrong:**
- React remounts the native view. Causes include navigation transitions, typed-route re-renders, Fast Refresh, a parent re-render in React Compiler mode, or a modal.
- The remount re-creates the `ARSCNView`/`ARView`, which restarts or pauses the session mid-scan.
- On iOS 27 this exact pattern crashed VirtSpace: R16, a recursive unfair-lock abort when the AR view was re-made while the session was paused.
- A restarted session resets the world origin, so all earlier poses become inconsistent.

**Why it happens:**
Expo Modules make it natural to create the session inside the native view's init.

**How to avoid:**
- One `ARSession` per capture is owned by a module-level capture controller, not by the view. The view only attaches to the running session.
- Keep the capture screen as a full-screen modal route that is never re-keyed.
- Handle `sessionWasInterrupted`, `sessionInterruptionEnded` and `sessionShouldAttemptRelocalization` explicitly. These are the VirtSpace R31 lessons.

**Warning signs:**
- The keyframe index resets.
- The pose path has a jump back to the origin.
- A crash on navigating away and back during capture.

**Phase to address:** Native capture module.

---

### Pitfall 7: Tracking loss, relocalization and drift silently corrupt the trajectory

**What goes wrong:**
- `trackingState` becomes `.limited` because of fast motion, blank walls, low light, or when relocalization starts. Poses during this state are unreliable.
- After relocalization the world origin can jump, so the trajectory is internally inconsistent.
- Over a 3-5 minute walk, ARKit visual-inertial odometry drifts by centimetres to decimetres. The first and last views of the same wall disagree.
- Echo-3 accepts the bundle anyway and bills it.

**Why it happens:**
The trajectory is recorded unconditionally, and the capture UI doesn't react to the tracking state.

**How to avoid:**
- Only accept keyframes while `trackingState == .normal`.
- On `.limited`, pause keyframing and show coaching: "slow down", "point at something textured", "more light".
- If a relocalization or interruption happened, mark the session `pose_discontinuity = true`. Then either:
  - drop `camera_trajectory.json` (it is optional, and Echo-3 then estimates poses itself), or
  - force a restart.
  Decide which with an A/B experiment.
- Coach a loop: end where you started. Keep room scans to about 2-4 minutes.
- Set `worldAlignment = .gravity`, as in Echo-3's own sample.

**Warning signs:**
- A large camera-centre jump between consecutive keyframes.
- Doubled walls in the result.
- Floor-plan walls that are not closed.

**Phase to address:** Native capture module. The A/B experiment is a research flag for Echo-3 live.

---

### Pitfall 8: No Mac, so native Swift errors are only discovered on EAS, and the 15-build monthly quota burns

**What goes wrong:**
Swift can't be compiled on Windows. Each typo, missing import or wrong Expo Modules API call costs one of 15 iOS builds a month, in a low-priority queue that can wait tens of minutes. Three failed iterations in one day is 20% of the month.

**Why it happens:**
The edit, build, test loop goes straight to EAS.

**How to avoid:**
- **Compile-check Swift on a free macOS CI runner before using EAS.** A GitHub Actions `macos-latest` job runs `npx expo prebuild -p ios` and then `xcodebuild -workspace … -scheme … -sdk iphoneos CODE_SIGNING_ALLOWED=NO build`. It catches compile errors for zero EAS builds.
  - Free for public repos.
  - Private repos: macOS minutes bill at 10x against 2,000 free minutes, so about 200 macOS minutes, or about 10-15 runs a month. Verify the current multiplier.
- Run `npx expo prebuild --clean -p ios` locally on Windows to check what config plugins produce in `Info.plist`, entitlements and the Podfile. Nothing in `ios/` gets committed.
- Run `npx expo-doctor` and `npx expo config --type introspect` before every build.
- Put all native work into one or two build batches per phase. After that, iterate in JS through the dev client and Metro, and EAS Update later.
- Set `runtimeVersion: { policy: "fingerprint" }` so it is obvious when a change needs a new binary.
- Keep the Swift surface small: capture controller, uploader, view. Put every decision that can live in JS/TS (thresholds, copy, state machine) in JS.

**Warning signs:** More than 3 EAS iOS builds in the first week of the native phase. Builds failing at "Run fastlane" with Swift errors.

**Phase to address:** Native capture module. Set up macOS CI in the phase just before it, so it is ready on day one.

---

### Pitfall 9: The Expo Go phase plan collides with what Expo Go can actually do

**What goes wrong:**
- **Native modules:** importing the custom capture module crashes Expo Go.
- **Auth:** Sign in with Apple in Expo Go returns tokens for Expo Go's bundle id, not yours, so the backend can't verify the audience. A paid account is also required for your own capability.
- **SDK mismatch:** Expo Go in the App Store follows the newest SDK. If SDK 59 ships before the native phase, the store build of Expo Go may stop opening an SDK 58 project.

**How to avoid:**
- Use `requireOptionalNativeModule`, plus a JS `FakeCaptureSource` that replays a recorded fixture bundle (frames, poses, intrinsics). The whole scan, review, upload and library flow then runs in Expo Go.
- Choose a v1 auth method that works in Expo Go and on Windows, for example email OTP or a magic link plus a bearer token stored in SecureStore. Alternatively, schedule Sign in with Apple after the Developer Program purchase.
- Check Expo's SDK release timing. If SDK 59 is imminent, buy the Apple Developer membership and move to a dev build earlier rather than upgrade the SDK in the middle of the plan.

**Warning signs:** "Cannot find native module" in Expo Go. Expo Go showing a "project is incompatible with this version" screen.

**Phase to address:** App shell (Expo Go).

---

### Pitfall 10: The "uploads survive app kill" requirement is impossible as stated, and Expo's upload task is not restored

**What goes wrong:**
- `expo-file-system` SDK 58 supports `sessionType: 'background'`, so a transfer can continue while the app is suspended.
- However, its `UploadTask` (promise, progress, completion) is not restored after the app is terminated. The docs give no recovery path.
- iOS cancels all background transfers when the user force-quits (swipes away) the app. Only system termination keeps transfers alive.
- iOS also defers background tasks under scheduler budget policies. An Apple forum thread reports background `URLSession` uploads stalling for this reason.

**How to avoid:**
- Rewrite the requirement as: "survives lock, suspension and system termination; resumes on next launch after a force-quit."
- Make the upload ledger server-authoritative. On every launch and foreground, the app asks `GET /scans/:id/upload-status` for the frames that are missing, then enqueues only those. This is idempotent per frame: object key = `scans/{id}/images/Image_NNNNNN.jpg`.
- Enqueue all frames at once, not one after another (VirtSpace R25).
- Refresh expired presigns on 403 instead of counting them as failures.
- Because the capture module is native anyway, implement uploads with a Swift background `URLSession` that has a fixed identifier. It reattaches after relaunch and implements `handleEventsForBackgroundURLSession`. Fall back to the Expo task only if that proves unnecessary.
- Cap each presigned PUT by content length (VirtSpace R7).

**Warning signs:**
- Scans stuck in "uploading" after the phone was locked overnight.
- Progress resets to 0 after relaunch.
- Duplicate objects in R2.

**Phase to address:** Upload pipeline.

---

### Pitfall 11: The budget cap is racy or enforced in the wrong place

**What goes wrong:**
The budget is checked by reading and then writing (VirtSpace R9). Two submissions both pass at the limit. A dead job's reservation stays counted, or is never counted. The cap lives in app code that a bug or an agent can bypass.

**How to avoid:**
- Reserve credits with one conditional `UPDATE budgets SET reserved = reserved + :quote WHERE reserved + spent + :quote <= cap RETURNING …` before calling Echo-3.
- Release the reservation on `FAILED` or `CANCELLED`. Echo-3 refunds those automatically, so mirror that behaviour.
- Reconcile against `available_credits` from `process-quote` daily.
- Set Echo-3 Auto top-up OFF. The provider-side balance is the final hard cap, so keep it low.
- Make mock provider the default in every non-production environment. `PROVIDER_MODE=live` must be refused unless an explicit env flag is set and the environment is production.

**Warning signs:** The `reserved` sum doesn't match active jobs. Spend exceeds the daily cap.

**Phase to address:** Backend port. Echo-3 live.

---

### Pitfall 12: Production data pollution by agents or dev builds (repeat of VirtSpace)

**What goes wrong:**
In VirtSpace, a simulator "read-only" launch resumed a pending session and uploaded 28 frames into production. Agent runs exhausted the quota. In Expo the same risk takes three forms:
- an `EXPO_PUBLIC_API_URL` that defaults to production;
- an EAS build profile that inherits production env;
- the dev client resuming a pending upload against production.

Separately, a session `SET` through the Neon pooler made production read-only (incident 2026-09-17).

**How to avoid:**
- **Separate databases:** a new Neon project and a new Railway project, with separate dev and production Neon branches. VirtSpace production is never referenced.
- **Per-profile URLs:** EAS environments (`development`, `preview`, `production`) each have their own API URL. Dev and preview builds hard-fail on a production URL unless an explicit override is set (VirtSpace R5).
- **No secrets in the app:** anything `EXPO_PUBLIC_*` is embedded in the bundle, so never put secrets in it.
- **Database access rules:**
  - migrations and advisory locks use only the direct (non-`-pooler`) host;
  - never issue a session-level `SET` through the pooler;
  - inspect data with `BEGIN READ ONLY … ROLLBACK`;
  - integration tests run only on a Neon branch or CI Postgres.

**Warning signs:** Unknown scans in the production library. Production `DATABASE_URL` in a local `.env`.

**Phase to address:** Backend port (first task).

---

## Moderate Pitfalls

### Pitfall 13: Exposure, white balance and motion blur across a walk

**What goes wrong:**
- **Auto exposure** swings between a window and a dark corner. The splat gets brightness-inconsistent "floaters" and blotchy walls.
- **Full exposure lock** blows out half the room. VirtSpace R38: locking on shot 0's window made the whole room underexposed.
- **Blur:** long exposures in dim rooms produce motion blur that the 64 px rule rejects, so the keyframe count collapses.

**How to avoid:**
- Lock white balance at start, using ARKit's `configurableCaptureDeviceForPrimaryCamera` to get the `AVCaptureDevice`.
- Let exposure float but cap the exposure duration, for example ≤1/60 s, so ISO rises instead of blur.
- Store ISO and exposure per frame.
- Run a low-light preflight using ARKit light estimation.
- Gate keyframes with Echo-3's own predicted-blur formula, using `ARCamera.exposureDuration` with fx, angular speed and lateral speed.
- Exact AE policy (float vs lock vs bracket) is unverified for Echo-3. Settle it with one A/B on the same room.

**Phase to address:** Native capture module. Experiment in Echo-3 live.

### Pitfall 14: Thermal throttling and storage in long sessions

**What goes wrong:**
ARKit, the camera and JPEG encoding at 3-5 fps for 3+ minutes heat the iPhone. At `.serious`, ARKit lowers the frame rate and tracking degrades. Scaniverse warns that scans over 180 s may fail. 1,000 frames at about 400 KB is about 400 MB on disk.

**How to avoid:**
- Watch `ProcessInfo.thermalState`. At `.serious`, warn the user and stop keyframing; at `.critical`, end the scan.
- Encode with ImageIO (hardware-accelerated). No CIFilter chains.
- Preflight free disk space (frames × 0.5 MB × 2).
- Store frames in a directory excluded from backup, and sweep orphaned sessions at launch (VirtSpace R31).
- Show elapsed time and estimated credits live, which naturally keeps scans short.

**Phase to address:** Native capture module.

### Pitfall 15: Mirrors, windows, glass and people produce phantom geometry

**What goes wrong:**
- **Reflective surfaces:** mirrors reconstruct as a "room behind the wall", glass and TV screens become floaters, and shiny floors double the room.
- **People:** moving people leave ghosts, and they are also a privacy problem.
- Echo-3's gap completion may "fill in" plausibly but wrongly. That is a real-estate truthfulness issue: see Pitfall 21.

**How to avoid:**
- Pre-scan checklist copy: cover or avoid mirrors, close blinds on bright windows, nobody walking around, the scanner's feet not in frame.
- In review, show "captured" vs "completed" areas if Echo-3 outputs allow it (unknown, research flag).

**Phase to address:** App shell (copy). Viewer / walk / measure / share.

### Pitfall 16: Webhook trust, replay and ordering

**What goes wrong:**
- **Signature scope:** `X-Spaitial-Signature` is HMAC-SHA256 over the raw body. No signed timestamp or replay window is documented, so a captured delivery can be replayed.
- **Delivery:** it is at-least-once, retried 5 times. No ordering guarantee is documented.
- **Framework:** a JSON-parsing framework breaks HMAC by re-serializing the body.
- **Timeouts:** a slow handler (downloading outputs inline) exceeds 30 s, which triggers retries.

**How to avoid:**
- Register a raw-body parser for the webhook route only, compare digests in constant time, and keep a unique index on `delivery_id`.
- **Treat the webhook as a hint only.** Return 2xx immediately, enqueue "refresh request X", and have the worker `GET` the authoritative status from the Echo-3 API. Replays and reordering then become harmless.
- Use monotonic status transitions: never move from `ready` back to `processing`.
- Keep slow polling (every 5-10 min, plus at startup) as a backstop for lost webhooks. Processing takes 30 min to 2 h, so never write a "stuck" timeout shorter than about 3 h.

**Phase to address:** Echo-3 live.

### Pitfall 17: The privacy manifest and required-reason APIs are incomplete

**What goes wrong:**
- **Missing declarations:** the timestamp math uses `systemUptime` (System Boot Time API). File timestamps and UserDefaults/AsyncStorage are also "required reason" APIs. Missing declarations trigger warnings or rejections at TestFlight or App Store upload.
- **Over-declaration:** VirtSpace R32 declared location collection that nothing performed.

**How to avoid:**
- Declare everything in `app.json` under `ios.privacyManifests` (Expo writes `PrivacyInfo.xcprivacy`).
- Declare only what is actually collected: photos/video of the user's space, user id, crash data.
- Purpose strings: `NSCameraUsageDescription` only. No location. `NSPhotoLibraryAddUsageDescription` only if "Save" ships.
- Run the check at the first TestFlight build, even though v1 is owner-only.

**Phase to address:** Privacy + hardening. The camera string goes in the Native capture module phase.

### Pitfall 18: WebView WebGL memory limits and context loss on large splats

**What goes wrong:**
- **Choppy full resolution:** on VirtSpace, a full-resolution splat made movement choppy on the iPhone 17 Pro.
- **Process kill:** iOS kills the WKWebView content process under memory pressure, which leaves a permanent black viewer if nothing handles it (VirtSpace R31).
- **Bridge transfer:** passing a 50-200 MB splat into the WebView as base64 through `postMessage` doubles memory and stalls the UI.
- **Local files:** `fetch()` on `file://` is blocked in WKWebView.
- Echo-3 room splats with 1,000 frames are likely larger than Marble's.

**How to avoid:**
- Serve SOG with LOD or a splat budget, not the full PLY. Generate a phone-tier asset on the backend (for example with PlayCanvas `splat-transform`) during re-hosting.
- Load from an HTTPS URL plus an HTTP cache, or from a local file served properly. Never through the bridge.
- Handle `onContentProcessDidTerminate` in react-native-webview by reloading. Also handle `webglcontextlost` in the page.
- Put walk controls inside the web page, not round-tripped through RN (VirtSpace §9: joystick latency).

**Phase to address:** Viewer / walk / measure / share.

### Pitfall 19: Output coordinate frames get flipped wrong

**What goes wrong:**
- **Wrong flip:** SPZ, SOG and PLY outputs are RDF with Y down, and the viewer frame is (x, -y, -z). Applying the wrong flip gives an upside-down or mirrored room.
- **Mirroring is hard to notice:** VirtSpace shipped mirrored panos for months (R17).
- **Floor plan:** the pixel-to-world affine uses its own axes. Measurements are off if the Y flip or units are mishandled.
- **Collider:** `mesh-simplified` must get the same transform as the splat.

**How to avoid:**
- Write a chirality test: scan something with text on it once, and assert that the text reads correctly in the viewer.
- Put a known tape-measured distance (for example a door width) in the fixture and assert that the measure tool is within 2-3 %.
- Put one transform in one place for splat, collider and floor plan.

**Phase to address:** Viewer / walk / measure / share.

### Pitfall 20: Provider output URLs are stored instead of re-hosted

**What goes wrong:**
Echo-3 download routes `302` to signed URLs that expire after 5 minutes. Storing the redirect target breaks after 5 minutes. Depending on provider URLs also keeps lock-in and leaves the share page dependent on SpAItial.

**How to avoid:**
- Store the permanent API proxy URL, not the redirect target.
- Re-host every output to R2 immediately on completion: splat, mesh, floor plan, affine, `cameras.json`.
- The app and the share page only ever see our URLs.
- Downloads have their own 120/min bucket. Download sequentially.
- Follow redirects manually and check each hop against a host allowlist. Never send the API key to the redirect target (VirtSpace R29).

**Phase to address:** Echo-3 live.

### Pitfall 21: Licensing, pricing and lock-in surprises

**What goes wrong:**
- **Licence:** Standard plan outputs are non-commercial. A broker pilot on Standard breaks the licence. It is unknown whether worlds made under Standard become commercial after upgrading.
- **Price:** "launch pricing" ($49.99 for 7,500 credits / $99.99 for 15,000) is labelled as temporary, with no end date. A per-room cost model built on today's price may be wrong.
- **New API:** the API launched publicly in Nov 2026, so fields and error codes may churn.

**How to avoid:**
- Keep the provider interface (mock / echo-3 / future self-hosted).
- Keep the raw bundle in our format plus Echo-3's format, so a self-hosted gsplat or Brush backend can re-run old scans. That is a reason to keep raw frames longer, which has to be balanced against retention (Pitfall 22).
- Snapshot `openapi.json` in the repo and diff it on a weekly CI job using free GET endpoints (`limits`, `process-quote`).
- Ask SpAItial in writing about Standard-to-Pro output rights and training use of inputs before any non-owner scan.

**Phase to address:** Echo-3 live (interface, snapshot). Later milestone (commercial).

---

## Privacy / Legal Pitfalls (private homes, later listings)

### Pitfall 22: Raw frames are kept forever, despite promising otherwise

**What goes wrong:**
VirtSpace's spec promised purge-after-stitch and never implemented it. Raw frames of private homes include:
- faces;
- family photos;
- documents, mail and screens;
- children's rooms.

Under GDPR, scans of other people in their own homes are personal data. Data minimisation and storage limitation apply.

**How to avoid:**
- Decide the retention policy in v1, write it in the terms, and implement it in the same phase.
- Use R2 object lifecycle rules (a native platform feature) for `scans/*/images/` and the ZIP. For example, delete 30 days after `ready`. Pick N so a re-run is still possible.
- Account and scan deletion cascades: Neon rows, R2, and `DELETE /v1/worlds/requests/{id}` at SpAItial (supported per their docs).
- Keep on-device frames until the server confirms upload, then delete them.
- No GPS in EXIF.

**Phase to address:** Privacy + hardening. The lifecycle rule ships in the Upload pipeline phase.

### Pitfall 23: Third-party disclosure and consent

**What goes wrong:**
Frames leave the device for our backend and for SpAItial, which is an EU/German company. Their training and data-use terms are not verified. People in frame have not consented. Later, brokers scan homes where tenants live.

**How to avoid:**
- Show a versioned consent screen before the first upload (VirtSpace WP3 pattern) that names SpAItial.
- Pre-scan copy: "make sure nobody is in the room; remove personal documents."
- Read SpAItial's ToS/DPA for input retention and training before App Store or public release.
- Public share links: unguessable, revocable, `noindex`. A public link to the inside of a home is a burglary and stalking risk.
- For listings later: tenant consent workflow, face and photo blurring, and an App Store UGC moderation duty once public browsing exists.

**Phase to address:** Privacy + hardening. Share links in Viewer / walk / measure / share.

### Pitfall 24: Real-estate truthfulness (later milestone, design for it now)

**What goes wrong:**
- **Gap fill:** Echo-3 "completes what you missed." A listing tour with invented geometry or surfaces can be misrepresentation.
- **Measurements:** floor-plan measurements are approximate. US square-footage standards (ANSI Z765) and EU listing rules expect accuracy claims to be qualified.

**How to avoid:**
- Keep metadata for which regions were observed vs completed, if Echo-3 exposes it (unknown).
- Label measurements as approximate.
- Get legal review before the listings milestone.

**Phase to address:** Note in v1 viewer copy. Real work in the listings milestone.

---

## Minor Pitfalls

### Pitfall 25: Portrait UI vs landscape sensor frames

**What goes wrong:**
- **UI rotation:** if the UI rotates mid-scan, the guidance flips.
- **Orientation rule:** Echo-3 requires one consistent device orientation for the whole capture, and EXIF Orientation absent or 1.
- **Undocumented case:** `orientation.json` documents only `{"orientation":"identity"}` for upright portrait frames. The correct value for frames stored in landscape sensor orientation is not documented.

**How to avoid:** Lock the capture screen to portrait. Store sensor-native frames. Confirm the `orientation.json` semantics with SpAItial or their open Capture iOS prototype repo before the first live run (research flag).

### Pitfall 26: Crash diagnosis without Xcode

**What goes wrong:** `xcrun devicectl` crash pulls are impossible on Windows.

**How to avoid:** Add `@sentry/react-native`, with native crash capture and dSYM upload through the EAS build hook, in the first dev build. Fallbacks are iPhone Settings > Privacy > Analytics Data (`.ips` files shared to a PC) and TestFlight crash reports.

### Pitfall 27: Metro dev-client connectivity from Windows

**What goes wrong:** Windows Firewall or a different subnet blocks the dev client from reaching Metro.

**How to avoid:** Use `npx expo start --tunnel`, or allow Node through the private-network firewall.

### Pitfall 28: An EAS Update lands on an incompatible binary

**What goes wrong:** An update is pushed to a binary whose native code differs, which crashes at launch.

**How to avoid:** Use the fingerprint runtime policy, plus separate channels per build profile.

### Pitfall 29: Apple Developer purchase timing

**What goes wrong:** Enrollment can take 1-2 days. Device UDID registration (`eas device:create`) and enabling Developer Mode on the iPhone are extra steps.

**How to avoid:** Buy at the start of the phase before the native one, not on the day the native phase starts.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip `camera_trajectory.json` entirely | No pose-conversion bugs | Possibly worse reconstruction, and metric scale may depend on Echo-3's own estimate | As a fallback when poses are discontinuous. A/B it |
| Use Expo `UploadTask` instead of a native background session | No Swift uploader | Lost progress after kill. Needs a server reconcile anyway | Acceptable if the server-authoritative reconcile exists |
| Keep raw frames indefinitely | Re-run with a better provider later | Privacy liability, R2 cost, broken promises | Only with an explicit, disclosed N-day lifecycle |
| Dev auth / shared token in v1 | Fast | VirtSpace never left it ("deferred forever") | Never past the first phase. Real auth is a v1 requirement |
| Full-resolution splat in the app | Best detail | Choppy on iPhone 17 Pro, WebView kills | Desktop share page only |
| Mock provider that only returns canned success | Easy | Never exercises `FAILED`, validation issues, 402/409/429/503 or webhook duplicates | Never. The mock must script failure cases |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Echo-3 create | New key on retry, or re-presigned URL in the body | Saved key + saved body. New key only for a user-confirmed retry after `FAILED` |
| Echo-3 quote | Quoting once at UI time | Quote again right before submit (`has_enough`). Handle 402 `INSUFFICIENT_CREDITS` as a user-visible state, not an error retry |
| Echo-3 limits | Hard-coding 5,000 frames / min frames | Read `GET /v1/captures/limits` and enforce it in-app before upload |
| Echo-3 webhooks | Parsing JSON before HMAC, processing inline | Raw body, constant-time compare, dedupe `delivery_id`, ack, then fetch status |
| Echo-3 status | 3 s polling | Status is cached 3 s. Poll every 5-10 min as a backstop only. General limit is 60/min |
| Echo-3 downloads | Storing the signed redirect URL | Store the API URL, re-host to R2 immediately |
| R2 | 900 s presign for Echo-3 GET | 24 h presign, Range preflight, purge only after terminal state |
| Neon | Session `SET` / advisory lock via pooler | Direct host for migrations and locks. `BEGIN READ ONLY` for inspection |
| EAS | Building on every native tweak | macOS CI compile check first, batched builds, fingerprint |
| Expo Go | Importing the native module unconditionally | `requireOptionalNativeModule` + fake capture source |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| JPEG encode on the main or ARKit delegate queue | Dropped ARFrames, UI jank | Serial encode queue, copy the buffer, release the frame | Immediately at 3-5 fps |
| ZIP built in memory on the worker | Worker OOM | Stream Stored ZIP to R2 multipart | Above about 500 frames |
| Per-frame progress events to JS | JS thread saturated | Throttle to ≤10 Hz summaries | Immediately |
| 1,000 individual tiny API calls for presigns | Slow upload start, rate limits | Batch presign (one request returns N URLs) | Above about 200 frames |
| Full splat in WKWebView | Choppy, black viewer | LOD / SOG phone tier | Above about 1-1.5 M splats on iPhone (VirtSpace: full-res choppy) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Echo-3 key or webhook secret in `EXPO_PUBLIC_*` or app.json | Anyone with the IPA spends your credits | Server-side only (Railway env vars) |
| Unsigned or unverified webhooks trusted as state | Forged "completed" or replayed events | HMAC + dedupe + fetch authoritative status |
| Guessable share slugs, no revoke | Interiors of private homes exposed | 128-bit random slugs, revocable, `noindex`, expiry option |
| Presigned PUT without a size cap | R2 abuse / cost | Signed `ContentLength` (VirtSpace R7) |
| Dev auth fallback in production | Anyone is anyone (VirtSpace R2/R24) | Refuse to boot with dev auth under production |
| Following provider redirects with the API key attached | Key leak (VirtSpace R29) | Manual redirects, host allowlist per hop |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No cost shown until after upload | $15-19 surprise | Live credit estimate during capture. Confirm the quote before processing |
| Processing shown as a spinner with a fake ETA | Looks broken over 30 min to 2 h | Phase states + `estimated_duration_seconds` + push or "we'll keep working, close the app" |
| Generic "failed" | User re-scans blindly | Map `validation.issues` codes to plain fixes. Validation failures cost 0, say so |
| Coaching only after the scan | Bad scans discovered after paying | Live tracking, blur and coverage feedback, plus a pre-upload quality gate (frame count, blur ratio, coverage, pose continuity) |
| "Retry" re-bills silently | Lost money | Retry shows the cost again and needs confirmation |

## "Looks Done But Isn't" Checklist

- [ ] **Capture:** frames look right in Photos. Verify the validator passes all Echo-3 rules *and* the pose and intrinsics semantic checks on a real device bundle.
- [ ] **Pose conversion:** unit test passes. Verify the output `cameras.json` from the first live run agrees with the submitted trajectory.
- [ ] **Background upload:** works with the app in the foreground. Verify phone locked mid-upload, system kill, and force-quit then relaunch (resume from the server ledger).
- [ ] **Idempotency:** key sent. Verify a worker killed right after `POST /v1/worlds` resumes without a second `request_id` (scripted test against the mock).
- [ ] **Webhook:** happy path works. Verify duplicate, out-of-order and forged deliveries, and a lost webhook (polling backstop).
- [ ] **Budget:** cap set. Verify two concurrent submits at the limit result in exactly one passing.
- [ ] **Mock provider:** returns success. Verify it also scripts `FAILED`/validation, 402, 409, 429, 503 and duplicate webhooks.
- [ ] **Viewer:** fixture renders. Verify a real Echo-3 room on iPhone 17 Pro at a smooth frame rate, WebView kill recovery, chirality and measurement accuracy.
- [ ] **Retention:** policy written. Verify the R2 lifecycle rule exists, and that delete cascades to SpAItial.
- [ ] **Isolation:** dev build runs. Verify it refuses a production URL, and that no VirtSpace resource appears in any env.
- [ ] **Privacy manifest:** builds. Verify required-reason entries (`systemUptime`, file timestamps, UserDefaults) and that there is no location key.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Billed garbage from a pose or intrinsics bug | MEDIUM ($15-19 per run) | Fix the converter. Re-submit the *stored raw bundle* (keep raw frames until the first result is accepted). Ask SpAItial support for credit goodwill |
| Double-billed job | MEDIUM | Cancel the duplicate if it is still `PENDING`/`PROCESSING` (`/cancel` refunds). Add the missing guard |
| URL expiry / validation fail | LOW (free) | Fix the presign or ZIP. New key (the job is `FAILED`). Re-submit |
| EAS quota exhausted mid-month | HIGH (blocks native work) | Continue JS-only work in the dev client. Use macOS CI to keep compiling. Buy the pay-as-you-go build add-on if blocked |
| Production polluted | MEDIUM | Delete by `created_by`/tag. Rotate dev tokens. Add the URL guard |
| Expo Go incompatible after an SDK bump | MEDIUM | Move to a dev build early (requires the Apple membership) |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 12 Prod isolation / Neon pooler | Backend port | New Neon/Railway projects; dev builds refuse production URL; migrate on direct host |
| 2 Double submit, 11 Budget race | Backend port + Echo-3 live | Kill-mid-submit test; concurrent-submit test |
| 1 Semantic bundle errors, 4 EXIF | Mock provider + fixtures (validator) + Native capture module | Validator on a real device bundle; converter self-check |
| 9 Expo Go limits, auth choice | App shell (Expo Go) | Full flow runs in Expo Go on the fake capture source |
| 8 EAS quota / no Mac | Before Native capture module | macOS CI compiles the module green before the first EAS build |
| 5 Bridge, 6 Session lifecycle, 7 Tracking, 13 Exposure, 14 Thermal | Native capture module | 3-min device scan: ≥3 kf/s, no frame retention warnings, no restart on navigation |
| 10 Background upload | Upload pipeline | Lock / system-kill / force-quit test matrix |
| 3 Presign/Range, 16 Webhooks, 20 Re-host, 21 Lock-in | Echo-3 live | Range preflight; webhook dedupe and replay tests; R2 has all outputs |
| 18 WebGL memory, 19 Coordinate frames | Viewer / walk / measure / share | Smooth on iPhone 17 Pro; text-chirality and tape-measure checks |
| 17 Privacy manifest, 22 Retention, 23 Consent | Privacy + hardening (lifecycle rule earlier) | Manifest present; lifecycle rule live; deletion cascade test |
| 24 Real-estate truthfulness | Listings milestone | Legal review |

## Research Flags (need experiments or vendor answers)

1. AE policy (float with exposure cap vs lock) for Echo-3 quality. One A/B on the same room.
2. Trajectory vs no trajectory when tracking was interrupted. A/B.
3. `orientation.json` value for landscape sensor-native frames. Check SpAItial's open Capture iOS prototype repo or ask support.
4. SpAItial data terms: input retention and training use; whether Standard-plan outputs gain commercial rights after upgrading.
5. Whether Echo-3 outputs distinguish observed vs completed regions.
6. Whether the private-repo macOS minute multiplier on GitHub Actions is still 10x (affects the compile-check budget).
7. SDK 59 release timing vs Expo Go compatibility for an SDK 58 project.

## Sources

- SpAItial docs (fetched 2026-11-23, HIGH): [Mobile capture (Echo-3)](https://docs.spaitial.ai/api/capture-worlds), [Webhooks](https://docs.spaitial.ai/api/webhooks), [Credits and billing](https://docs.spaitial.ai/api/credits-billing), [Worlds / idempotency](https://docs.spaitial.ai/api/worlds), [Rate limits](https://docs.spaitial.ai/api/rate-limits), [Getting started](https://docs.spaitial.ai/api/getting-started)
- Expo SDK 58 FileSystem (fetched, HIGH): https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/ (UploadTask not restored after termination; legacy upload APIs deprecated)
- Expo background task SDK 58: https://docs.expo.dev/versions/v58.0.0/sdk/background-task/
- Apple forums, background URLSession stalls (MEDIUM): https://developer.apple.com/forums/thread/849761
- VirtSpace (HIGH, owner's own post-mortems): `HANDOFF.md` (pooler incident, prod pollution, World Labs 422, full-res choppy), `spec-doc.md` §9, §10 ledger R1-R42, §13 and §14, `CLAUDE.md` (agent isolation, cost guardrails), `docs/research/live-mapping.md` (Scaniverse 180 s warning, iOS 26.4 LiDAR drift regression), `docs/research/reconstruction-vs-generation.md`
- Training data (LOW-MEDIUM, verify during the phase): ARKit `capturedImage`/intrinsics orientation, simd column-major layout, force-quit cancels background transfers, required-reason API categories, GitHub macOS minute multiplier.

---
*Pitfalls research for: ARKit capture to Echo-3 reconstruction to splat viewer (Expo, Windows, no Mac)*
*Researched: 2026-11-23*
