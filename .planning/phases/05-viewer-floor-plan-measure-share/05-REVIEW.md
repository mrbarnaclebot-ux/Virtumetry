---
phase: 05-viewer-floor-plan-measure-share
reviewed: 2026-11-25T00:00:00Z
depth: standard
files_reviewed: 37
files_reviewed_list:
  - .dockerignore
  - Dockerfile
  - backend/drizzle/0004_share_links.sql
  - backend/scripts/make-demo-room.ts
  - backend/src/config.ts
  - backend/src/db/schema.ts
  - backend/src/pipeline.ts
  - backend/src/provider/index.ts
  - backend/src/provider/mock.ts
  - backend/src/provider/types.ts
  - backend/src/routes/index.ts
  - backend/src/routes/share.ts
  - backend/src/routes/worlds.ts
  - backend/src/share-password.ts
  - virtumetry/app.json
  - virtumetry/package.json
  - virtumetry/src/app/(tabs)/index.tsx
  - virtumetry/src/app/_layout.tsx
  - virtumetry/src/app/r/[slug].tsx
  - virtumetry/src/app/world/[id]/index.tsx
  - virtumetry/src/app/world/[id]/share.tsx
  - virtumetry/src/app/world/_layout.tsx
  - virtumetry/src/components/library-row.tsx
  - virtumetry/src/lib/api.ts
  - virtumetry/src/lib/public-share.ts
  - virtumetry/src/lib/shares.ts
  - virtumetry/src/viewer/coords.ts
  - virtumetry/src/viewer/engine.ts
  - virtumetry/src/viewer/floorplan.ts
  - virtumetry/src/viewer/load-viewer.ts
  - virtumetry/src/viewer/measure.ts
  - virtumetry/src/viewer/progress.ts
  - virtumetry/src/viewer/recovery.ts
  - virtumetry/src/viewer/tokens.ts
  - virtumetry/src/viewer/types.ts
  - virtumetry/src/viewer/walk.ts
  - virtumetry/src/viewer/world-viewer.tsx
findings:
  critical: 1
  warning: 5
  info: 8
  total: 14
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-11-25
**Depth:** standard
**Files Reviewed:** 37 (diff base 5815141)
**Status:** issues_found

## Summary

The public share surface holds up. Slugs are 128-bit and regex-gated before any DB hit. Missing, revoked, not-ready and deleted links all return the same 404. scrypt params are bounded and compared with `timingSafeEqual`. `/s/:slug` escapes the title and URL in every attribute and in the `<script>` JSON, and its redirect target is built only from config plus the validated slug, so there is no open redirect. CORS covers `/v1/public` only and sends no credentials. Revoke is idempotent, and the open counter re-checks `revoked_at` in the same UPDATE. The coordinate math is correct: F·inv(C)·F, the quaternion branches, fallback yaw and walk yaw/right/forward.

The real defects are in the **owner viewer's lifecycle**. The presigned URLs are cached forever, so every recovery path (crash remount, Reload, Try again, re-entering the screen) dead-ends once the 1 h TTL passes. The crash-reconnect overlay also never clears if the remount fails. Smaller issues: engine teardown leaks GPU/Spark resources on the web page, desktop walk keys get stuck on blur, and the password throttle can be raced and has a low floor.

## Critical Issues

### CR-01: Owner viewer reuses expired presigned URLs on every recovery path

**File:** `virtumetry/src/lib/api.ts:77-88` (with `virtumetry/src/app/world/[id]/index.tsx:62-68,112-139`)
**Issue:** `useWorld` sets `staleTime: Infinity`, `refetchOnMount: false` and turns off focus/reconnect refetch. The backend signs the asset URLs for `DOWNLOAD_TTL_SECONDS = 3600`. After 60 minutes, every way the viewer reloads still uses the dead URLs:
- a WebView crash remount (`crash` bumps `mountKey`, D-13b),
- "Reload viewer" after the cap,
- the viewer's own "Try again" button (`setAttempt`),
- leaving and re-entering the screen within the default 5-minute `gcTime`, because the cached data comes back with its old URLs and no refetch.

Each of these hits R2, gets a 403 and lands in `load_failed`. The owner screen's `onError` ignores `load_failed`, so nothing ever refreshes the URLs. Long walk sessions on an iPhone are exactly when memory-pressure crashes happen, so the D-13 recovery feature fails in the case it was built for. The web share page has a re-open path for this (`REOPEN_MS`). The owner screen has none.
**Fix:** Keep the URLs stable during a mount, but refresh them before any remount once they are old:
```ts
// index.tsx
const { data, dataUpdatedAt, refetch } = useWorld(id);
const URL_TTL_MS = 50 * 60_000;
const fresh = () => (Date.now() - dataUpdatedAt > URL_TTL_MS ? refetch() : Promise.resolve());
const crash = useCallback(() => { void fresh().then(() => dispatch({ type: 'crash', at: Date.now() })); }, [dataUpdatedAt]);
const onError = useCallback(async (e) => {
  setDomUp(true);
  if (e.code === 'context_lost') crash();
  else if (e.code === 'load_failed' && Date.now() - dataUpdatedAt > URL_TTL_MS) await refetch(); // new splatUrl → viewer effect reruns
}, [crash, dataUpdatedAt]);
```
Also set `gcTime: 0` on `useWorld`, or `refetchOnMount: 'always'`, so re-entering the screen never reuses old URLs.

## Warnings

### WR-01: "Reconnecting viewer…" overlay never clears when the remount fails to load

**File:** `virtumetry/src/app/world/[id]/index.tsx:74-80,140-146`; `virtumetry/src/viewer/recovery.ts:36-39`
**Issue:** `reconnecting` is set on `crash` and on `reload`, and only `ready` clears it. `ready` is dispatched only from `onProgress` and `onReady`. If the remounted viewer fails before its first progress event (a 403 from an expired URL, see CR-01, or any network error), `fetchWithProgress` throws before calling `onPct`. Only `onError('load_failed')` arrives, and that calls `setDomUp(true)` but never dispatches `ready`. The opaque RN overlay (no `pointerEvents="none"`) then covers the viewer's own "Couldn't load this room / Try again" UI forever. Back is the only way out.
**Fix:** Clear the overlay on any terminal signal from the viewer:
```ts
const onError = useCallback(async (e) => {
  setDomUp(true);
  if (e.code === 'context_lost') crash();
  else dispatch({ type: 'ready' }); // reveal the viewer's error + Try again
}, [crash]);
```

### WR-02: Engine dispose leaks the SparkRenderer and WebGL context (web share page remounts)

**File:** `virtumetry/src/viewer/engine.ts:347-355`
**Issue:** `dispose()` frees the controls, collider geometry, splat and renderer, but it never calls `spark.dispose()`, never removes `spark` from the scene and never calls `renderer.forceContextLoss()`. In the app, each remount replaces the whole WebView, so this mostly doesn't matter there. On the web page the same document remounts the engine on every "Try again" (`<canvas key={attempt}>`) and every `viewerKey` bump in `r/[slug].tsx`. Each remount then leaves behind a live WebGL context plus Spark's GPU targets and sort/LoD workers. iOS Safari caps live contexts and kills the oldest, which can fire `webglcontextlost` storms. Memory pressure can then cause the very crash the page reports.
**Fix:**
```ts
dispose() {
  disposed = true;
  cancelAnimationFrame(raf);
  controls.dispose();
  frameListeners.clear();
  firstFrame.length = 0;
  collider?.geometry.disposeBoundsTree?.();
  collider?.geometry.dispose();
  if (splat) { scene.remove(splat); splat.dispose(); }
  scene.remove(spark); spark.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  bytes = null;
},
```

### WR-03: Desktop walk keys stay held after window blur, so the camera walks forever

**File:** `virtumetry/src/viewer/world-viewer.tsx:263-295`
**Issue:** `held` only changes on `keydown`/`keyup`. If the visitor holds W and then alt-tabs, clicks the browser chrome or opens a system dialog, the `keyup` never reaches the window. `held` keeps `'f'` and the engine keeps walking every frame until the same key is pressed and released again.
**Fix:** Clear input on blur and when the tab is hidden:
```ts
const stop = () => { held.clear(); engineRef.current?.setWalkInput(STILL); };
window.addEventListener('blur', stop);
document.addEventListener('visibilitychange', stop);
// remove both in cleanup
```

### WR-04: Concurrent requests race past the per-slug password throttle; 4-character floor is brute-forceable

**File:** `backend/src/routes/share.ts:182-191,36`
**Issue:** `failures.isBlocked(slug)` is checked before the `await verifySharePassword(...)`, and `record()` runs only after scrypt finishes. A burst of N parallel wrong guesses all pass the check, so `SHARE_FAIL_MAX` (10 per window) only counts sequential guesses. Per-IP limits (20/min) times many IPs set the real ceiling. Even without the race, 10 guesses/min is 14,400/day, and the owner may choose a 4-character password (`min(4)`, same rule in the UI). A 4-digit PIN falls in under a day. For scans of private homes, that is weak.
**Fix:** Count the attempt before doing the work, and raise the floor:
```ts
if (failures.isBlocked(slug)) return reply.code(429)...;
failures.record(slug);                      // reserve the attempt up-front
const ok = await verifySharePassword(pw, hash);
if (!ok) return reply.code(401).send({ error: 'wrong_password' });
failures.reset(slug);
```
Also set `min(8)` in `createBody` and in the share sheet, or add a longer daily window (for example 50 failures/day per slug).

### WR-05: Web share re-open never refreshes `openedAt`, so a second expiry gets no recovery

**File:** `virtumetry/src/app/r/[slug].tsx:128-143`
**Issue:** The `onError` re-open calls `openPublicShare` directly and not `open()`. That leaves `openedAt.current` at the original time and `reopened.current = true` for the rest of the page's life. A visitor who keeps the tab open past a second 15-minute window, then hits a load failure (the viewer's "Try again" after a network drop, or a crash remount on native), gets no refresh. They see "Couldn't load this room" while the link is still live. The rate limits already bound abuse, so the one-shot latch adds failure without adding safety.
**Fix:** Reset the clock on every successful re-open, and latch only for the current window:
```ts
const data = await openPublicShare(slug, keptPassword.current);
openedAt.current = Date.now();
reopened.current = false;
```
To guard against loops, rely on the `Date.now() - openedAt.current < REOPEN_MS` check, which already blocks an immediate repeat.

## Info

### IN-01: og:image presign (7 days) outlives revocation

**File:** `backend/src/routes/share.ts:235-238,254`
**Issue:** Revoking stops new opens, but every thumbnail URL already handed to a messaging-app crawler stays valid for up to 7 days. Under the privacy constraint (private homes), revocation leaves the thumbnail public for that week. D-20 accepted this. It should be stated in the revoke copy or the retention policy, or the TTL shortened (for example 24 h, since crawlers fetch right away).

### IN-02: Railway dev API allows `http://localhost:8081` as a CORS origin

**File:** `backend/src/routes/share.ts:156`
**Issue:** The localhost origin is added whenever `NODE_ENV !== 'production'`, and the Railway dev env runs with `NODE_ENV=development`. The risk is low because there are no credentials and the endpoints are public. A tighter gate is `!isProdLike(config)`.

### IN-03: open_count increments before presigning and on every re-open

**File:** `backend/src/routes/share.ts:196-209`; `virtumetry/src/app/r/[slug].tsx:88-100,135`
**Issue:** If `presignDownload` throws, the count is already incremented and the visitor gets a 500. The 14-minute re-open and React StrictMode's double effect in dev also each count as an open. Presigning first and then counting would make the number reflect real deliveries.

### IN-04: Renaming a world doesn't update a cached viewer title

**File:** `virtumetry/src/lib/api.ts:77-88,100-102`
**Issue:** Rename invalidates `['worlds']` but not `['world', id]`. With `staleTime: Infinity`, the viewer and share title show the old name until the cache entry is garbage-collected. Invalidate `['world', id]` in the rename mutation's `onSettled`.

### IN-05: The viewer holds the splat bytes twice at peak, then keeps a full copy

**File:** `virtumetry/src/viewer/progress.ts:15-35`; `virtumetry/src/viewer/engine.ts:64,181`
**Issue:** `fetchWithProgress` holds every chunk plus the merged buffer, and then the engine keeps `bytes` for context-loss rebuild alongside Spark's decoded copy. With real Echo-3 splats (hundreds of MB), that raises the chance of the WebView memory kills that D-13 recovers from. Consider preallocating when Content-Length is known, and documenting the ceiling.

### IN-06: Walk floor height is fixed at mode entry; horizontal surfaces never block

**File:** `virtumetry/src/viewer/walk.ts:32-63`; `virtumetry/src/viewer/engine.ts:157-159`
**Issue:** `walk.floorY` is computed only on enter or teleport. `resolveCapsule` ignores triangles whose closest-point offset is vertical, so table tops and low cabinets inside the capsule height are walked through. This follows D-09 (horizontal push-out only), but it is worth a `ponytail:` note naming the ceiling: no stairs, multi-level floors or furniture tops.

### IN-07: Production image ships the 4 MB demo-room fixture

**File:** `Dockerfile:31-32`; `.dockerignore:20`
**Issue:** The fixture is dev-only data, and it is baked into every image, including production. It is harmless because `MOCK_OUTPUTS_SET` is a fixed enum, but it is dead weight in prod. Copying it in a dev-only stage would avoid that.

### IN-08: `/s/:slug` builds og:url from the localhost default when PUBLIC_BASE_URL is unset

**File:** `backend/src/routes/share.ts:222-242`
**Issue:** The landing page and public routes check only `WEB_SHARE_ORIGIN`, not `shareConfigured()`. On a prod-like deploy where `PUBLIC_BASE_URL` was removed after links were created, existing links render `og:url="http://localhost:3000/s/..."`. Gating the landing page on `shareConfigured(config)` would keep it consistent with share creation.

---

_Reviewed: 2026-11-25_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
