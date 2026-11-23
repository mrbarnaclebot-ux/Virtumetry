# Stack Research

**Domain:** iOS walk-through room capture (ARKit) to cloud Gaussian-splat reconstruction (SpAItial Echo-3), with splat viewing in the app and on a public web share link
**Researched:** 2026-11-23
**Confidence:** MEDIUM-HIGH overall. Versions come from the npm registry (checked 2026-11-23) and the Expo, Spark, Better Auth and SpAItial docs. The few training-data-only claims are marked LOW.

**Scope note:** The backend stack (Node 24, Fastify 5, Drizzle 0.45, `pg`, Neon, R2 through `@aws-sdk/client-s3`, zod 4, jose 6, vitest, Railway) is copied from VirtSpace and is **not re-researched here**. This file covers only what the backend needs added or changed.

---

## TL;DR (prescriptive)

| Question | Answer | Confidence |
|---|---|---|
| ARKit capture | **A local Expo module** (`npx create-expo-module@latest --local` creates `virtumetry/modules/vm-capture/`), Swift only. It has two parts: a `Module` that owns a singleton `ARSession`, and a `View` that shows the camera preview. Frames go to disk as JPEGs on the native side. JS only gets throttled events (counts, coverage, quality) and file paths. Don't use any existing RN AR library. | HIGH |
| Splat viewer | **Spark 2.x (`@sparkjsdev/spark@2.4.0`) + `three@0.187`** in an **Expo DOM component** (`'use dom'`). The same component is the web share page, because on web it renders as a normal component. | MEDIUM-HIGH |
| Auth | **Better Auth 1.7.x** mounted in the Fastify backend with the Drizzle adapter on Neon. Use Sign in with Apple (native idToken flow, `expo-apple-authentication`) and keep `DEV_AUTH_TOKEN` for tests. For brokers later, use the organization plugin. | MEDIUM |
| Web share page | **Expo Router web in the same app**, route `src/app/r/[slug].tsx`, deployed with `eas deploy` (Expo Hosting free tier, `*.expo.app` URL). Revisit when you need a custom domain or the marketplace (SEO). | MEDIUM |
| ZIP to R2 | **`yazl@3.3.1`** with `compress:false`, plus **`@aws-sdk/lib-storage` `Upload`** for streaming multipart into R2. Echo-3 gets a presigned GET URL from the existing presigner, valid for 6 h or more. | HIGH |
| Webhook | **`node:crypto` HMAC-SHA256 over the raw body**, using a scoped Fastify buffer content-type parser, a constant-time compare, and a unique constraint on `delivery_id`. No new dependency. | HIGH |
| Testing | **`jest-expo@58` + Jest 30 + `@testing-library/react-native@14`** for the app, and the existing vitest for the backend. **No Maestro in v1**: it isn't on the EAS Free plan, and iOS needs a Mac. Move pose math into TS so it can be tested on Windows. | HIGH |

---

## Recommended Stack

### Core Technologies (app additions to the existing SDK 58 starter)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Expo Modules API (local module) | `expo-modules-core` 58.1.0 (installed). Scaffold with `create-expo-module@58.0.5 --local` | Swift ARKit capture engine and camera preview view | Expo's docs call `--local` "the recommended way to create a local Expo module". It autolinks from `modules/` and needs no npm publishing. Its Swift DSL (`Function`/`AsyncFunction`/`Events`/`View`/`Prop`/`OnCreate`/`OnDestroy`) covers everything needed. You also port VirtSpace's Swift capture engine almost directly. |
| `expo-dev-client` | ~58.0.21 | Development build that contains the capture module | Expo Go can't load custom native code. With a dev client, one EAS build covers many JS iterations, which matters with only 15 iOS builds a month. |
| `@sparkjsdev/spark` | 2.4.0 (peer `three >=0.180`) | Gaussian splat renderer | MIT, from World Labs, built on three.js/WebGL2. It loads **SPZ, SOG, PLY, splat and ksplat**, and Echo-3 outputs SPZ/SOG/PLY. Spark 2.x adds continuous LoD with a per-device splat budget (**iOS default `lodSplatCount` = 1.5M**, scaled by `lodSplatScale`) and a streamable `.RAD` LoD format that loads over HTTP Range. That directly fixes VirtSpace's "full-res splats were choppy on iPhone 17 Pro" problem. |
| `three` | 0.187.0 (+ `@types/three` 0.187.0) | Scene, camera, controls, mesh loading for colliders | Spark's host engine. Use it imperatively inside the DOM component. Don't add `@react-three/fiber`, because one canvas with imperative setup is simpler and avoids a reconciler inside a WebView. |
| `three-mesh-bvh` | 0.9.18 | Collision and raycast against Echo-3's `mesh-simplified` PLY | The standard way to do fast capsule collision ("walk mode") and raycast picking ("measure distance") on a three.js mesh. Load the mesh with three's own `PLYLoader`. |
| Expo DOM components (`'use dom'`) | Built in. SDK 56+ uses `@expo/dom-webview` 58.0.2 by default, no install needed | Hosts the three/Spark viewer inside the native app | One viewer codebase runs in the app and on the web page. On web the `dom` prop is ignored and it's a plain component. It works in **Expo Go**, so you can build the viewer before buying the Apple Developer membership. Props must be serializable (pass URLs, not data), and native actions are async functions. |
| `better-auth` + `@better-auth/expo` | 1.7.27 | Accounts and sessions (app client and Fastify server) | Self-hosted on your existing Neon DB through the Drizzle adapter (peer `drizzle-orm ^0.45.2` matches VirtSpace). No per-MAU vendor cost. It has a first-party Expo plugin (sessions in SecureStore), a native **idToken** sign-in for Apple, and an organization plugin for brokers later. |
| `expo-apple-authentication` | ~58.0.3 | Native Sign in with Apple sheet that returns an identity token | Apple-native and one tap. VirtSpace already verifies Apple JWTs with jose, so this flow is proven in your codebase. |
| `expo-file-system` | ~58.0.14 | Background uploads of frame files to presigned R2 PUT URLs | The SDK 58 `File.upload` / `File.createUploadTask` use `sessionType: 'background'` by default (iOS background `URLSession`). The native transfer continues while the app is suspended. **But the JS task object is not restored after the app is terminated**, so the resume logic has to be server-reconciled (see Patterns). |
| `expo-secure-store`, `expo-network` | ~58.0.3 / ~58.0.5 | Required peers of `@better-auth/expo` | Required by Better Auth's Expo client. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@tanstack/react-query` | 5.108.3 | Server state: library list, status polling with backoff, retry | Use it from the library and status phase on. Polling every scan's status by hand is exactly what it removes. |
| `expo-keep-awake` | ~58.0.4 | Keep the screen on during capture | Capture screen only. |
| `expo-notifications` | ~58.1.9 | "Your room is ready" push (VirtSpace backend has an APNs stub) | Only once real processing runs (30 min to 2 h). Needs the Apple Developer account and an EAS build. |
| `expo-build-properties` | ~58.0.12 | Raise the iOS deployment target if the capture module needs newer ARKit APIs | Only if the Swift code needs an API above SDK 58's default iOS minimum. Otherwise skip it. |
| `@playcanvas/splat-transform` | 3.12.0 | Node CLI/library to inspect, convert and decimate splats (SPZ/SOG/PLY) | Backend, optional: to make thumbnails/previews or a decimated fallback. SpAItial's own docs reference it for reading SPZ. |

**Backend additions (into the copied VirtSpace backend):**

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| `yazl` (+ `@types/yazl`) | 3.3.1 | Streaming ZIP writer | Use `compress:false` (JPEGs don't compress), and pass `size` to `addReadStreamLazy`. **`end()` then reports `calculatedTotalSize` exactly before any bytes stream**, which is useful for budget/limit checks (8 GiB) and for logging. ZIP64 is automatic. It is small, has no native deps, and is feature-complete (last release Nov 2024 is not a concern). |
| `@aws-sdk/lib-storage` | 3.1175.0 (match `client-s3`) | `Upload` streams a Readable into R2 as multipart | Handles part sizing and retries. Use a fixed `partSize` (e.g. 16 MiB), because R2 requires equal part sizes except the last one. |
| `better-auth` | 1.7.27 | Server side of auth | Mounted at `/api/auth/*` (see Patterns). |
| `@fastify/cors` | 11.4.3 | CORS for the web share page and the Better Auth handler | Better Auth's Fastify guide requires CORS to be registered *before* the auth route. |
| Echo-3 client | none, use Node 24 `fetch` | `POST /v1/worlds`, quote, limits, status | **SpAItial has no official npm SDK** (their docs list only an agent "skill"). Write a thin typed client behind VirtSpace's provider interface, next to `mock.ts`. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| EAS CLI (`npx eas-cli@latest`) | `eas build --profile development --platform ios`, `eas device:create`, `eas update`, `eas deploy` | The only way to compile Swift from Windows. Batch native changes. JS-only changes ship through the dev client or `eas update`. |
| `jest-expo` + `jest` + `@types/jest` | 58.0.15 / **30.x** (SDK 58 requires Jest 30) | App unit tests on Windows. Install with `npx expo install jest-expo jest @types/jest --dev`, add `"jest": { "preset": "jest-expo" }`, and add `"types": ["jest"]` in tsconfig. |
| `@testing-library/react-native` | 14.1.0 | Component and router tests | v14+ is required for Expo Router testing on SDK 58. |
| vitest (backend) | keep VirtSpace's `^2.1` on copy | Backend tests | Latest is 5.1.1. **Don't upgrade during the copy.** Upgrade in a separate commit once the ~348 tests pass. Better Auth's peer range allows vitest 2 to 5. |
| Rust toolchain (optional, backend Docker only) | Spark `build-lod` CLI | Only if you pre-build `.RAD` LoD files server-side (see Variants). |

---

## Installation

```bash
# --- App (run inside virtumetry/) — always via expo install for SDK-matched versions
npx expo install expo-dev-client expo-file-system expo-secure-store expo-network \
  expo-apple-authentication expo-keep-awake
npx expo install better-auth @better-auth/expo @tanstack/react-query
npx expo install three @sparkjsdev/spark three-mesh-bvh
npx expo install @types/three jest-expo jest @types/jest @testing-library/react-native -- --dev

# Native capture module (creates virtumetry/modules/vm-capture, autolinked)
npx create-expo-module@latest --local
# later: npx expo install expo-notifications   (when push is real)

# --- Backend (run inside backend/)
npm i yazl @aws-sdk/lib-storage better-auth @fastify/cors
npm i -D @types/yazl
```

Camera permission: **no config plugin needed.** Set `ios.infoPlist.NSCameraUsageDescription` in `app.json`, and add `ios.privacyManifests` there for the privacy manifest. Write a config plugin only if the capture module later needs entitlements or plist keys that `app.json` can't express. (Ladder: a native app.json field beats a custom plugin.)

---

## Key Patterns (stack-level; details belong in ARCHITECTURE.md)

**1. Capture module boundary: never send pixels over the bridge.**
- The Swift `Module` owns `ARSession` (`ARWorldTrackingConfiguration`). Pick a 4:3 video format around 1920x1440, so the long edge is ≤1920 and you never resize. The `View` (`ARSCNView` or a RealityKit `ARView` without content) attaches to that same session. It is a preview only.
- In `session(_:didUpdate:)`, keyframe gating (≥0.12 s and ≥7 cm or 10°, predicted blur ≤64 px from angular velocity × exposure) runs **natively at frame rate**. Accepted frames are copied out of the `CVPixelBuffer` immediately. Holding `ARFrame`s starves ARKit ("delegate is retaining N ARFrames"). The JPEG is then encoded with ImageIO `CGImageDestination` on a serial background queue, writing EXIF `DateTimeOriginal`, `SubSecTimeOriginal` and **no rotation tag** (Echo-3 requirement). Output path is `Documents/scans/<scanId>/images/Image_000001.jpg`.
- Write raw per-frame records (timestamp, ARKit `camera.transform` 4x4, `camera.intrinsics` 3x3, image size, tracking state) to a JSON lines file next to the images.
- JS gets `Events` throttled to about 5 Hz: `{ frameCount, coverage, trackingState, lastRejectReason }`. Finishing returns the scan directory path. Uploads then read files straight from disk with `expo-file-system`.
- **Do the ARKit to OpenCV conversion (invert, × diag(1,-1,-1,1)) in TypeScript, not Swift.** You can't unit-test Swift on Windows. The pose math is the easiest thing to get subtly wrong, and in TS it can be tested with vitest/jest against fixture bundles. Do it in the backend at ZIP-build time, so a bug fix needs no app build.
- Expo Go fallback: `requireOptionalNativeModule('VmCapture')` returns null in Expo Go. Wire a fixture-backed fake capture source so every screen after capture can be developed before the Apple account exists.

**2. Background upload with server reconciliation.** Upload each JPEG plus the records file with a presigned PUT (`File.upload`, background session). Because JS tasks don't survive app termination, on every launch call something like `GET /v1/scans/:id/upload-status`, which uses R2 `ListObjectsV2` or a DB manifest, and re-upload only the missing keys. Uploads are idempotent per key. A force-quit by the user cancels iOS background sessions, but the next-launch reconcile covers it.

**3. ZIP build (worker job).** For each frame: `GetObject` stream to yazl `addReadStreamLazy(name, {compress:false, size, mtime})`. Then `zip.outputStream` goes to `new Upload({client, params:{Bucket, Key, Body}, partSize})`, and `calculatedTotalSize` is checked against limits first. Then presign GET with an expiry of 6 h or more. Echo-3 needs ≥2.5 h. R2 presigned URLs allow up to 7 days and serve Range natively.

**4. Webhook verification.**
```ts
// inside an encapsulated Fastify plugin for POST /v1/webhooks/spaitial only
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
if (!secretEquals(header, expected)) return reply.code(401).send();   // VirtSpace helper, constant-time
// INSERT … ON CONFLICT (delivery_id) DO NOTHING → if no row inserted, 200 and stop
```
SpAItial signs the **raw body only, with no timestamp**, so replay protection rests on the `delivery_id` dedupe. Their docs say deliveries are retried up to 5 times with a 30 s timeout per attempt, and **HTTPS public hosts only** (private/loopback rejected). In local dev you rely on polling. Exercise webhooks only on the Railway staging service.

**5. Better Auth on Fastify.** A catch-all `GET|POST /api/auth/*` turns the Fastify request into a Fetch `Request`, calls `auth.handler`, and copies the response back. The authed preHandler calls `auth.api.getSession({ headers: fromNodeHeaders(req.headers) })` and sets `req.userId`. That replaces VirtSpace's `auth.ts` Apple path while keeping its dev-token path for tests. The app sends `Cookie: authClient.getCookie()` with `credentials: 'omit'`, as the Better Auth Expo docs prescribe for separate backends. Add the `virtumetry://` scheme to `trustedOrigins`.

**6. Viewer.** Load the splat with `new SplatMesh({ url, lod: true })`. Spark builds the LoD in the browser, and its iOS budget defaults apply. Load the `mesh-simplified` PLY with `PLYLoader` + `three-mesh-bvh` for walk-mode collision and measure raycasts. Echo-3's frame is RDF y-down, and the viewer frame is (x,-y,-z), so rotate the root by π about X once. Pass only `{ splatUrl, meshUrl, mode }` props into the DOM component.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Local module (`modules/`) | **Inline modules** (`experiments.inlineModules`, Swift next to app code) | Inline modules are **experimental** (SDK 56+, "API subject to breaking changes"). Don't stake the core feature on them while every native change costs an EAS build. |
| Local module | Standalone npm package | Only if a second app ever reuses the capture engine. |
| Spark + three in a DOM component | **PlayCanvas engine 2.24** (streamed SOG LoD, `splatBudget`, WebGPU) | A real option: its LoD tooling (`splat-transform`) is pure Node, so it's easier to run in the backend than Spark's Rust `build-lod`. Switch if Spark's in-browser LoD load time is unacceptable *and* you don't want Rust in the backend image. PlayCanvas unified rendering / LoD streaming is still marked **beta**, and the engine is a much heavier API than three. |
| Spark in a DOM component | Native **RealityKit `GaussianSplatComponent`** (WWDC26) | Not for v1. Apple's docs list iOS 27 availability, but there are reports of the symbol missing on iOS in Xcode (LOW confidence it ships on iOS today). It needs Apple7+ GPUs, it means a second viewer for web, and every iteration costs a cloud build. Revisit if the WebView viewer can't hold frame rate. |
| DOM component | `react-native-webview` 14.0.1 loading the hosted share URL | If you want the app viewer to be literally the live web page, with zero bundling. You lose offline viewing and EAS Update control, and auth for private rooms gets awkward. |
| Better Auth | **Clerk** (`@clerk/expo` 4.17, `@clerk/fastify` 3.1) | If you'd rather pay for hosted user management, prebuilt UI and a broker/org dashboard and never touch auth tables. The cost is a vendor dependency, a per-MAU cost at marketplace scale, and users living outside your DB. |
| Better Auth | Keep VirtSpace's jose Apple-JWT + mint your own session JWT | Smallest diff for owner-only v1. But refresh/revocation, email login for brokers and orgs all have to be hand-written later. VirtSpace's "auth deferred forever" lesson argues for adopting a real library now. |
| Better Auth | Supabase Auth | Only if you also move to Supabase. It adds a second Postgres or identity silo next to Neon for no gain. |
| Expo Router web + Expo Hosting | Separate **Vite** app in `web/` (tiny static SPA) on **Cloudflare Pages** (free custom domain) | When you need a custom domain on the free plan, or the share page bundle size matters. Expo Router web ships app routes too, so it needs `.web.tsx` stubs for native-only screens. |
| Expo Router web | **Next.js** on Vercel | Marketplace milestone: SEO'd listing pages, per-listing OG images, ISR. Overkill for one share route. |
| yazl | `archiver` 8.0.0 (`store: true`) | Fine and maintained (May 2026), but heavier (glob, tar and lazystream deps), with no upfront exact size. Use it if you already use it elsewhere. |
| `lib-storage` multipart | Single `PutObject` with `ContentLength = calculatedTotalSize` | Works for bundles under 5 GiB with no multipart state. But a mid-stream failure restarts the whole upload. Multipart retries parts. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@reactvision/react-viro` 3.2.3 (ViroReact) | **Actively maintained** (Nov 2026, SDK 58 and New Arch compatible), but it is an AR *scene renderer*. It doesn't expose raw `ARFrame` pixel buffers, per-frame intrinsics and camera transforms in a disk-writing, keyframe-gated pipeline. You would fight it, and it adds a huge native dependency. | Custom local Expo module |
| `@viro-community/react-viro` | Abandoned, last publish June 2024 | Same as above |
| `react-native-arkit` | Dead, last publish June 2022 (0.9.0), old architecture | Same as above |
| `expo-gl` + ARKit (`expo-three-ar`) | Expo's ARKit bridge was removed years ago, so no path exists | Same as above |
| `expo-camera` / VisionCamera for capture | No ARKit world-tracking poses. Echo-3 works best with poses, and you need ARKit intrinsics per frame | ARKit module |
| Passing frames as `Uint8Array`/base64 over JS | 60 Hz × ~3 MB YUV frames over the bridge will drop tracking and blow memory | Native JPEG to disk; JS gets paths + metadata |
| `@mkkellogg/gaussian-splats-3d` | Effectively unmaintained (last publish Jan 2025), no LoD/streaming. Superseded by Spark | Spark 2.x |
| `@react-three/fiber` inside the DOM component | Extra reconciler and bundle in a WebView for one canvas | Imperative three in `useEffect` |
| Inline modules for capture | Experimental API | Local module |
| Maestro on EAS | Not included on EAS Free. Maestro has no official real-iOS-device support, and iOS simulator runs need macOS | Manual on-device QA checklist + jest; optional Maestro on a local Android emulator later |
| Generic body parser + `JSON.stringify(req.body)` for HMAC | Re-serialized JSON ≠ signed bytes, so verification fails randomly | Scoped raw-buffer content-type parser |
| `===` for signature compare (SpAItial's own Node example uses it) | Timing leak | VirtSpace's `secretEquals` (SHA-256 + `timingSafeEqual`) |
| Upgrading VirtSpace deps (vitest 2 to 5, TS 5 to 6) during the copy | Mixes "did the copy work" with "did the upgrade work" | Copy verbatim, get green, upgrade separately |

## Stack Patterns by Variant

**If Spark's in-browser `lod: true` takes too long on first open (measure on the 17 Pro with a real Echo-3 SPZ):**
- Pre-build `.RAD` in the backend worker with Spark's `build-lod --quality` (Rust, compiled in a multi-stage Dockerfile). Load with `new SplatMesh({ url, paged: true })` from a **single** `.rad` over HTTP Range, which means one presigned URL, not `--rad-chunked` (many chunk URLs = many presigns).
- Or switch the build step to `@playcanvas/splat-transform` (pure Node) if Rust in the image is unwanted.

**If the share page needs a custom domain before paying for Expo Starter ($19/mo):**
- Use `npx expo export --platform web` with `web.output: "single"` or `"static"`, and host the `dist/` folder on Cloudflare Pages (free, custom domain).
- Because the starter's `app.json` currently sets `web.output: "server"`, change it only if no `+api.ts` routes are used. Don't use Expo API routes, because the API lives in Fastify.

**If you load splat assets cross-origin from R2 on the web page:**
- Configure R2 bucket CORS: allow GET/HEAD from the share origin, allow the `Range` header, and expose `Content-Range`, `Accept-Ranges` and `Content-Length`. Without this, Spark streaming and paged loads fail only on web.

**Brokers milestone:**
- Better Auth `organization` plugin (broker agency = org, members = agents). Add email OTP or Google for non-Apple users. Listings become their own Next.js app (see Alternatives).

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `expo@~58.0.26` | `react-native@0.88.1`, `react@19.3.0`, TS ~6.0.3 | Starter baseline. Let `npx expo install` pick every `expo-*` version. |
| `jest-expo@58` | `jest@30` | Hard requirement from SDK 58 on. RNTL ≥14 for Expo Router. |
| `@sparkjsdev/spark@2.4.0` | `three >=0.180.0` (use 0.187) | Pin `three` exactly. Spark has broken on three minor bumps before (LOW, training data). |
| `@better-auth/expo@1.7.27` | `better-auth ^1.7.27`, `expo-secure-store >=12.5`, `expo-network >=8.0.7`, `expo-linking`, `expo-web-browser`, `expo-constants` | Keep both packages at the same version in app and backend. Docs state New Architecture is required (SDK 58 is New-Arch-only anyway). Metro package exports are on by default, don't disable them. |
| `better-auth@1.7.27` | `drizzle-orm ^0.45.2`, `drizzle-kit >=0.31.4`, `vitest 2–5` | Matches VirtSpace's backend versions as-is. |
| `@aws-sdk/lib-storage` | same minor as `@aws-sdk/client-s3` | Bump both together. |
| `@reactvision/react-viro@3.2.3` | expo 58, RN 0.88 | Listed only to confirm it's compatible but not chosen. |
| Expo DOM components | `@expo/dom-webview` (default SDK 56+) | To use `react-native-webview` instead, pass `dom={{ useExpoDOMWebView: false }}`. |

## EAS Free Plan / Windows Constraints Applied

- **15 iOS builds a month, low-priority queue, 45-min timeout, 1 macOS concurrency.** Native-touching work (capture module, `expo-apple-authentication`, notifications, the dev client itself) should land in as few dev-client builds as possible. Spark/three, auth UI, library and share page are all JS and iterate in Expo Go or through `eas update`.
- **Before the Apple Developer membership:** viewer (DOM component works in Expo Go), library, upload flow against fixtures (fake capture source), backend, and share page are all buildable. Sign in with Apple in Expo Go returns tokens whose audience is Expo Go's bundle id, not yours. Accept that audience only in dev config, or use `DEV_AUTH_TOKEN` until the dev build exists (LOW, verify).
- **60 CI minutes a month on EAS Workflows:** run app jest and backend vitest on GitHub Actions instead (VirtSpace already has CI). Use EAS minutes only for builds.
- **Expo Hosting free tier:** 100K requests/month, 1M CPU-ms, 1 GB storage, **no custom domain**. Fine for owner-only share links. Splat bytes should come from R2, not Hosting.
- **Windows:** jest-expo, vitest, `eas` CLI, `expo export --platform web` and `eas deploy` all run on Windows. Swift can only be compiled and checked through EAS builds, so keep Swift thin and keep math and logic in TS.

## Sources

- npm registry (`npm view`, 2026-11-23): versions and last-publish dates for every package above. HIGH
- https://docs.expo.dev/llms.txt: doc index and LLM-misconception corrections. HIGH
- https://docs.expo.dev/modules/get-started.md: `--local` is the recommended local module path. HIGH
- https://docs.expo.dev/modules/inline-modules-tutorial.md: inline modules are experimental, SDK 56+. HIGH
- https://docs.expo.dev/modules/module-api.md: Swift DSL, `Data`↔`Uint8Array`, `URL` from string. HIGH
- https://docs.expo.dev/guides/dom-components.md: `'use dom'`, `@expo/dom-webview` default SDK 56+, serializable props, Expo Go support, WebGL/low-power note. HIGH
- https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/: `File.upload`/`createUploadTask`, `sessionType:'background'` default, JS task not restored after termination. HIGH
- https://docs.expo.dev/eas/hosting/introduction.md and https://expo.dev/pricing: Hosting modes, `eas deploy`, Free plan limits (builds, CI minutes, no Maestro, Hosting quotas, no custom domains). HIGH
- https://docs.expo.dev/develop/unit-testing.md: jest-expo, Jest 30 on SDK 58, RNTL 14. HIGH
- https://sparkjs.dev/, https://sparkjs.dev/docs/new-features-2.0/, https://sparkjs.dev/docs/lod-getting-started/: formats, LoD budgets (iOS 1.5M), `.RAD`, `build-lod` needs Rust, `paged: true`. HIGH
- https://worldlabs.ai/blog/spark-2.0 and https://radiancefields.com/world-labs-releases-spark-v2.0: Spark 2.0 release April 2026. MEDIUM
- https://developer.playcanvas.com/user-manual/gaussian-splatting/building/lod-streaming/ and https://blog.playcanvas.com/new-in-supersplat-webgpu-and-streaming-bring-huge-performance-wins: PlayCanvas streamed SOG LoD (beta), `splatBudget`. MEDIUM
- https://developer.apple.com/documentation/realitykit/gaussiansplatcomponent.md and https://developer.apple.com/videos/play/wwdc2026/279: RealityKit splats, iOS 27 listing, Apple7 GPU. MEDIUM (iOS availability disputed)
- https://www.better-auth.com/docs/integrations/expo and https://www.better-auth.com/docs/integrations/fastify: Expo plugin, `getCookie`, idToken sign-in, Fastify handler, CORS ordering. HIGH
- https://docs.spaitial.ai/api/llm-skills: webhook headers, raw-body HMAC `sha256=` hex, no timestamp, 5 retries/30 s, HTTPS-only, no test keys, no npm SDK. HIGH
- https://github.com/thejoshwolfe/yazl: `compress:false`, `size`, `calculatedTotalSize`, ZIP64, DOS mtime. HIGH
- Maestro real iOS device support: https://www.browserstack.com/guide/maestro-real-ios-device-testing, https://github.com/mobile-dev-inc/Maestro/pull/2856. MEDIUM
- VirtSpace backend `package.json`, `README.md`, `src/auth.ts`, `src/storage/s3.ts` (local copy): existing stack, Apple JWT verify, `secretEquals`, presigner. HIGH

---
*Stack research for: ARKit capture → Echo-3 reconstruction → Gaussian splat viewing (Expo SDK 58)*
*Researched: 2026-11-23*
