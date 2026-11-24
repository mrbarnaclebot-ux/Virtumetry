---
phase: 05-viewer-floor-plan-measure-share
reviewed: 2026-11-25T00:00:00Z
depth: standard
iteration: 2
diff_base: 13976a6
files_reviewed: 7
files_reviewed_list:
  - backend/src/routes/share.ts
  - virtumetry/src/app/r/[slug].tsx
  - virtumetry/src/app/world/[id]/index.tsx
  - virtumetry/src/app/world/[id]/share.tsx
  - virtumetry/src/lib/api.ts
  - virtumetry/src/viewer/engine.ts
  - virtumetry/src/viewer/world-viewer.tsx
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 05: Code Review Report (Iteration 2)

**Reviewed:** 2026-11-25
**Depth:** standard (review-fix commits, 13976a6..HEAD)
**Files Reviewed:** 7, plus the 3 touched test files and `backend/src/throttle.ts`
**Status:** issues_found

## Summary

All six iteration-1 findings are fixed, and I found no regressions of the kinds I was asked to check:
- **No mid-session refetch loop.** `useWorld` turns off focus and reconnect refetch. It has `gcTime: 0` and only one observer (the world screen; the share modal doesn't use it). `refetch()` runs only after `crash`, Reload, or `load_failed`, which are all points where the viewer is already dead or failed. A healthy walk never refetches.
- **No canvas remount loop.** The key `${attempt}:${splatUrl}` comes only from a prop and a state that the engine effect never writes. The effect cleanup removes the `webglcontextlost` and `webglcontextrestored` listeners *before* `engine.dispose()` → `forceContextLoss()`. So the forced loss can't trigger `onError('context_lost')` and start a crash remount (native) or the "Reload page" block (web).
- **The throttle reservation is released.** `record()` runs synchronously after `isBlocked()`, and a correct password calls `reset()`. A missing password returns 401 before it reserves a slot. A wrong password keeps its slot, which is the intended behaviour.
- **The password length matches.** The backend has `SHARE_PASSWORD_MIN = 6` (zod `.min`, counting UTF-16 length). The app has `MIN = 6` (`password.length`) with matching copy. The visitor gate in `r/[slug].tsx` has no length check, so existing 4–5 character links still open.
- The 3 touched jest suites pass (40/40).

Two new warnings remain. Both are gaps around the edges of the CR-01 and WR-01 fixes.

## Iteration 1 findings

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| CR-01 | Owner viewer reuses expired presigned URLs | Resolved | `staleTime` 50 min and `gcTime 0`. `freshen()` runs before crash and Reload, and `load_failed` refetches once the URLs are 50 min old. The new `splatUrl` reruns the engine effect. One leftover gap: the lazily loaded floor plan image (see WR-01 below). |
| WR-01 | "Reconnecting viewer…" overlay never clears | Resolved | Any error other than `context_lost` dispatches `ready`. Test added. |
| WR-02 | Engine dispose leaks SparkRenderer / WebGL context | Resolved | `scene.remove` + `spark.dispose()` + `forceContextLoss()`, with a fresh canvas for each engine. Small robustness gap noted in IN-01. |
| WR-03 | Walk keys stuck after blur | Resolved | `stop()` runs on `blur`, on `visibilitychange` and in cleanup, and the listeners are removed symmetrically. |
| WR-04 | Throttle race / 4-char floor | Resolved | The race is closed by reserving the slot before scrypt. The pg test covers the parallel burst. The floor was raised to 6, not the suggested 8, and no daily cap was added (see IN-02). |
| WR-05 | Web re-open never refreshes `openedAt` | Resolved | `openedAt` resets on success. `reopened` is now only an in-flight guard (reset in `finally`). `REOPEN_MS` still blocks an immediate repeat. A failed re-open leaves `openedAt` alone, so the next user-driven Try again can retry. That retry is bounded by user action and the per-IP limits. |

Iteration-1 Info items IN-01..IN-08 were not applied (see 05-REVIEW-FIX.md). They carry over unchanged and are not repeated here.

## Warnings

### WR-01: The floor plan image is fetched lazily and never refreshed. After URL expiry it disappears for the rest of the mount.

**File:** `virtumetry/src/viewer/world-viewer.tsx:90,498,526-534`
**Issue:** The splat, collider and cameras are all fetched as soon as the viewer loads. The floor plan `<img src={props.floorplanUrl}>` is different: it only renders when the visitor first opens the plan (`ready && showPlan && planOpen`). If that first open happens after the presign expires, the image gets a 403. That takes 1 h in the app, but only **15 min on the web share page** (`PUBLIC_ASSET_TTL_SECONDS`), so it is the common case there. `onError` then sets `planFailed = true`. That hides the plan button for the rest of the mount (`showPlan` includes `!planFailed`). It never tells the host screen, so neither CR-01's refetch nor WR-05's re-open runs. `planFailed` is also never reset when `floorplanUrl` changes, so even a later URL refresh from a `load_failed` doesn't bring the plan back. CR-01 said the fix should cover "every path". This one is left.
**Fix:** The smallest fix is to fetch the image while the URL is still fresh, and to reset the failure flag whenever the URL changes:
```ts
// in the load effect, right after the splat loads (URL is minutes old at most):
const fp = propsRef.current.floorplanUrl;
if (fp) new Image().src = fp; // warms the HTTP cache; <img> later hits the cache, not R2
// and:
useEffect(() => setPlanFailed(false), [props.floorplanUrl]);
```
A more robust option is to decode it into a blob URL at load time. Either way, add a test in the viewer or screen suite.

### WR-02: The crash path waits for the network before showing "Reconnecting viewer…", and the refetch includes retry backoff

**File:** `virtumetry/src/app/world/[id]/index.tsx:64-66,74-77`; `virtumetry/src/lib/api.ts:93`
**Issue:** `crash` now runs `freshen().then(() => dispatch({ type: 'crash' }))`. When the URLs are older than 50 min, `refetch()` uses `useWorld`'s `retry` (up to 2 retries with the default 1 s and 2 s backoff). That leaves the dead WKWebView on screen for the whole fetch with no feedback: `reconnecting` is still false, and `domUp` is already true. On a weak connection, which is common after a long walk, that is several seconds of a blank or frozen screen. The user is likely to press Back, which is the outcome D-13b exists to prevent. For `context_lost`, the WebView is still alive. The fresh `splatUrl` reaches the live viewer one render before the `mountKey` bump, so it disposes its engine and starts a download that gets thrown away straight after. That is harmless but wasteful.
**Fix:** Show the overlay right away and mount the new viewer only once the URLs are settled. For example, add a `refreshing` flag:
```ts
const [refreshing, setRefreshing] = useState(false);
const crash = useCallback(() => {
  const at = Date.now();
  if (!urlsStale()) return dispatch({ type: 'crash', at });
  setRefreshing(true);
  void refetch().finally(() => { setRefreshing(false); dispatch({ type: 'crash', at }); });
}, [urlsStale, refetch]);
// render: if (refreshing) show the "Reconnecting viewer…" block instead of <WorldViewer>
```
Rendering the overlay instead of the viewer while `refreshing` also removes the wasted context-loss download. Do the same for the Reload button (see IN-03).

## Info

### IN-01: dispose() uses one try block, so a throw from Spark skips the renderer cleanup

**File:** `virtumetry/src/viewer/engine.ts:358-366`
**Issue:** `splat.dispose()`, `spark.dispose()`, `renderer.dispose()` and `renderer.forceContextLoss()` all share one `try`. The comment says a lost context "may refuse to dispose". If Spark throws in that case, `renderer.dispose()` and `forceContextLoss()` never run, which is the leak WR-02 was fixing.
**Fix:** Put `renderer.dispose(); renderer.forceContextLoss();` in a `finally`, or give each call its own try.

### IN-02: The password floor is 6 and no daily cap was added

**File:** `backend/src/routes/share.ts:36-38,149`
**Issue:** With `SHARE_FAIL_MAX` 10 per 60 s per slug, a 6-digit numeric PIN takes about 69 days to exhaust. That is acceptable for v1, but it is below the suggested 8, and no long-window cap exists. Separately, and already true before this fix: anyone who knows the slug can keep it in a 429 state. That also blocks visitors who have the correct password and the web page's automatic re-open, because `keptPassword` then gets a 429 that is silently ignored.
**Fix:** This is a policy decision. Either raise the floor to 8 or add a per-slug daily window, and decide whether a correct password should bypass the lockout.

### IN-03: Tapping "Reload viewer" twice during the refresh queues two reloads

**File:** `virtumetry/src/app/world/[id]/index.tsx:135`
**Issue:** `onRetry={() => void freshen().then(() => dispatch({ type: 'reload' }))}` has no in-flight guard. While the (possibly retrying) refetch is pending, the capped message stays on screen, and each tap adds another `reload`. Each one bumps `mountKey`, which causes an extra WebView remount. The `refreshing` flag from WR-02 fixes this too.

---

_Reviewed: 2026-11-25_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
