---
phase: 05-viewer-floor-plan-measure-share
fixed_at: 2026-11-25T00:00:00Z
review_path: .planning/phases/05-viewer-floor-plan-measure-share/05-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 05: Code Review Fix Report

**Fixed at:** 2026-11-25
**Source review:** .planning/phases/05-viewer-floor-plan-measure-share/05-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (CR-01, WR-01..WR-05)
- Fixed: 6
- Skipped: 0
- Info findings: none applied (see the note at the end)

## Fixed Issues

### CR-01: Owner viewer reuses expired presigned URLs on every recovery path

**Files modified:** `virtumetry/src/lib/api.ts`, `virtumetry/src/app/world/[id]/index.tsx`, `virtumetry/src/__tests__/world-screen.test.tsx`
**Commit:** 205db80
**Status:** fixed: requires human verification (lifecycle logic)
**Applied fix:**
- `useWorld`: `staleTime` is now `WORLD_URL_FRESH_MS` (50 min, below the 1 h presign TTL) and `gcTime: 0`. The cache entry is dropped on unmount, so re-entering the screen always fetches fresh URLs before the viewer mounts. Focus and reconnect refetch stay off, so nothing refetches in the background mid-walk.
- Owner screen: a `freshen()` helper refetches the world only when its `dataUpdatedAt` is older than 50 min. It runs before the crash remount (`crash` now awaits `freshen()` before dispatching), before "Reload viewer", and on `onError('load_failed')`. On `load_failed`, the new `splatUrl` reruns the viewer's load effect. The viewer's own "Try again" then uses the fresh URLs.
- Tests: a stale `load_failed` refetches and the viewer gets the new URL; a fresh `load_failed` does not refetch; a crash or Reload after 50 min remounts on the new URLs; re-entry never mounts on cached URLs. The old "never refetches on remount" test now expects a refetch on re-entry.

### WR-01: "Reconnecting viewer…" overlay never clears when the remount fails to load

**Files modified:** `virtumetry/src/app/world/[id]/index.tsx`, `virtumetry/src/__tests__/world-screen.test.tsx`
**Commit:** 0f9c820
**Status:** fixed: requires human verification (state handling)
**Applied fix:** `onError` now dispatches `ready` for any error that isn't `context_lost`. That lifts the opaque overlay and shows the viewer's own "Couldn't load this room / Try again". This happens before the stale-URL refetch from CR-01. Added a test: crash, then `load_failed`, then the overlay is gone.

### WR-02: Engine dispose leaks the SparkRenderer and WebGL context

**Files modified:** `virtumetry/src/viewer/engine.ts`, `virtumetry/src/viewer/world-viewer.tsx`
**Commit:** dc46039
**Status:** fixed: requires human verification (engine is not run by jest; check in web UAT)
**Applied fix:**
- `dispose()` now does the following: clears `firstFrame`, calls `disposeBoundsTree` on the collider, removes the splat and spark from the scene, then disposes splat, spark and renderer and calls `renderer.forceContextLoss()`. These calls sit in a try/catch like `rebuild()`, because a lost context may throw. It then nulls `splat` and `bytes`.
- One extra change was needed. The `<canvas>` is now keyed by `` `${attempt}:${splatUrl}` `` instead of `attempt`. Without it, a `splatUrl` change (CR-01's refresh, or the web page's re-open) would build the new engine on a canvas whose context had just been force-lost.
- No unit test: `engine.ts` is excluded from jest by design (the header says "never imported by jest").

### WR-03: Desktop walk keys stay held after window blur

**Files modified:** `virtumetry/src/viewer/world-viewer.tsx`
**Commit:** 2012514
**Applied fix:** In walk mode, a `stop()` function clears `held` and sends `STILL`. It runs on window `blur` and on document `visibilitychange`, and in the effect cleanup. No jest test: the DOM viewer is mocked in every screen test. Check it in desktop UAT (hold W, alt-tab, come back: the camera should be still).

### WR-04: Concurrent requests race past the per-slug password throttle; 4-character floor

**Files modified:** `backend/src/routes/share.ts`, `backend/test/integration/share.pg.test.ts`, `virtumetry/src/app/world/[id]/share.tsx`, `virtumetry/src/__tests__/share-sheet.test.tsx`, `.planning/phases/05-viewer-floor-plan-measure-share/05-UI-SPEC.md`
**Commit:** ab9e999
**Status:** fixed: requires human verification (security logic; covered by pg test)
**Applied fix:**
- `/v1/public/shares/:slug/open` checks `isBlocked`, then calls `failures.record(slug)` synchronously before the async scrypt verify. A correct password then calls `reset`. A missing password (401 `password_required`) uses no slot. In Node, check and record run without an await between them, so N parallel guesses can no longer all pass the check.
- The minimum password length is now 6 in both places: backend `SHARE_PASSWORD_MIN = 6` (zod `min`), and the app's share sheet `MIN = 6`, helper "Use at least 6 characters." and placeholder "At least 6 characters". The UI-SPEC copy rows and the decision table were updated to match. Existing 4–5 character links still open, because only creation is gated.
- Tests: new pg test sends 5 parallel wrong guesses with `SHARE_FAIL_MAX=2` and expects exactly two 401s and three 429s. Fixtures were moved to 6+ character passwords, and the rejected-length case is now `'abcde'`. The share-sheet test now uses `'abcde'` (blocked) and `'abcdef'` (sent). `npm run test:pg -- test/integration/share.pg.test.ts` passed (24/24).

### WR-05: Web share re-open never refreshes `openedAt`

**Files modified:** `virtumetry/src/app/r/[slug].tsx`, `virtumetry/src/__tests__/share-web-route.test.tsx`
**Commit:** b6c5a95
**Status:** fixed: requires human verification (state handling)
**Applied fix:** A successful re-open now sets `openedAt.current = Date.now()`. `reopened` is now only an in-flight guard, reset in `finally`. The `REOPEN_MS` check still blocks an immediate repeat inside the same window. The existing test was extended: a second `load_failed` in the same window does not re-open, and one 30 min later re-opens again and passes the newer URL to the viewer.

## Info findings (not applied)

None of these was a safe one-liner:
- IN-04 is resolved by CR-01: `gcTime: 0` means no stale viewer entry is left after rename. Invalidating `['world', id]` while the viewer is mounted would refetch and reload the viewer mid-walk.
- IN-02 (`!isProdLike`) would remove `localhost:8081` from the Railway dev API's CORS list, which local web dev against Railway dev may rely on. That is the owner's decision.
- IN-01 (shorter og:image TTL) is a policy change against D-20.
- IN-03, IN-05, IN-06, IN-07 and IN-08 are structural changes, not one-liners.

---

_Fixed: 2026-11-25_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
