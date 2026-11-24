---
phase: 04-0-capture-to-world-loop
reviewed: 2026-11-24T00:00:00Z
depth: standard
files_reviewed: 55
files_reviewed_list:
  - backend/src/routes/scans.ts
  - backend/src/routes/worlds.ts
  - backend/src/routes/deps.ts
  - backend/src/routes/index.ts
  - backend/src/server.ts
  - backend/src/budget.ts
  - backend/src/bundle/pack.ts
  - backend/src/bundle/validate.ts
  - backend/src/capture-config.ts
  - backend/src/config.ts
  - backend/src/pipeline.ts
  - backend/src/provider/mock.ts
  - backend/src/storage/index.ts
  - backend/src/storage/local.ts
  - backend/src/storage/s3.ts
  - backend/scripts/budget-reset-dev.ts
  - backend/package.json
  - Dockerfile
  - .dockerignore
  - virtumetry/src/app/(tabs)/index.tsx
  - virtumetry/src/app/_layout.tsx
  - virtumetry/src/app/capture/[id].tsx
  - virtumetry/src/app/capture/_layout.tsx
  - virtumetry/src/app/capture/prep.tsx
  - virtumetry/src/app/capture/scan.tsx
  - virtumetry/src/capture/capture-config.ts
  - virtumetry/src/capture/cost.ts
  - virtumetry/src/capture/coverage.ts
  - virtumetry/src/capture/fixture-assets.ts
  - virtumetry/src/capture/fixture-source.ts
  - virtumetry/src/capture/precheck.ts
  - virtumetry/src/capture/prep-flags.ts
  - virtumetry/src/capture/readiness.ts
  - virtumetry/src/capture/rules.ts
  - virtumetry/src/capture/source.ts
  - virtumetry/src/capture/store.ts
  - virtumetry/src/capture/types.ts
  - virtumetry/src/components/app-tabs.web.tsx
  - virtumetry/src/components/coverage-map.tsx
  - virtumetry/src/components/library-row.tsx
  - virtumetry/src/components/readiness-pill.tsx
  - virtumetry/src/lib/api.ts
  - virtumetry/src/library/display-state.ts
  - virtumetry/src/upload/manager.ts
  - virtumetry/src/upload/reconcile.ts
  - virtumetry/src/upload/uploader.ts
  - virtumetry/package.json
  - backend/test/integration/scans.pg.test.ts
  - backend/test/integration/scans-e2e.pg.test.ts
  - backend/test/helpers/pipeline.ts
  - backend/test/bundle/validate.test.ts
  - virtumetry/src/__tests__/upload-reconcile.test.ts
  - virtumetry/src/__tests__/upload-manager.test.ts
  - virtumetry/src/__tests__/capture-quote.test.tsx
  - virtumetry/src/__tests__/library.test.tsx
findings:
  critical: 4
  warning: 7
  info: 7
  total: 18
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-11-24
**Depth:** standard
**Files Reviewed:** 55
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

Money safety holds. No credit is reserved before `:complete` validation. `approved_max_credits >= quote` is enforced at create, and submit re-checks `quote <= approvedMaxCredits`. The presign path allowlist (`FRAME_PATH`, index <= `capture.frameCount`, manifest names only, keys built server-side) is tight. Every `:id` route goes through `findOwnedWorld`, which returns 404 for other owners and for malformed ids. Validation failures at `:complete` leave zero ledger rows, and tests cover this.

The defects are in durability and lifecycle. Some of them break the "survives force-quit / server-reconciled" promise:
- The local scan index is written non-atomically, and a corrupt index silently drops every local scan.
- Scan create is not atomic, so a world can be left without its capture row.
- A local scan can be discarded mid-upload, or its server world deleted. After that, reconcile spins forever on 404/409.
- The fixture scenario switcher can show "Good" while it replays a different scenario.

The upload manager also has no foreground retry. A background `URLSession` that waits for connectivity can hold the single-pass lock for as long as it waits.

## Critical Issues

### CR-01: `POST /v1/scans` creates the world and capture in separate statements; a failure strands a charged world forever

**File:** `backend/src/routes/scans.ts:183-217`
**Issue:** `chargeScanQuota` runs, then the `worlds` insert, then the `captures` insert, then the `r2FramesPrefix` update. These are four separate statements with no transaction. Suppose the capture insert fails, for example on a transient Neon connection drop. The world already exists in `uploading` with no capture row. Every retry with the same Idempotency-Key replays that world (line 172, 200 OK). From then on, `uploads`, `uploads:missing` and `:complete` all answer `404 capture_not_found`. The app's reconcile throws `ApiError(404)` on every pass, the scan stays on "Uploading…" for 24 h until the stale reaper fails it, and the daily scan quota stays spent. Separately, if the world insert throws a non-unique error (line 203 `throw err`), the quota charge is never released.
**Fix:** Do the charge, the world insert and the capture insert (with `r2FramesPrefix` computed from a pre-generated id) in one `db.transaction`. Release the quota on any error, not only on a unique violation:
```ts
const capId = randomUUID();
const world = await db.transaction(async (tx) => {
  const [w] = await tx.insert(worlds).values({ ... }).returning();
  await tx.insert(captures).values({ id: capId, worldId: w!.id, frameCount, imageW, imageH, r2FramesPrefix: `captures/${capId}` });
  return w!;
}).catch(async (err) => {
  await releaseScanQuota(db, userId);
  if (!isUniqueViolation(err)) throw err;
  ...replay winner...
});
```

### CR-02: The local scan index is written non-atomically; a torn write silently loses every saved scan

**File:** `virtumetry/src/capture/store.ts:160-177`
**Issue:** `set()` calls `indexFile().writeSync(JSON.stringify(next))`. On iOS, expo-file-system implements this as `content.write(to: url, atomically: false, ...)` (`node_modules/expo-file-system/ios/FileSystemFile.swift:117`), which truncates and then writes in place. The upload manager rewrites the index on every progress update (`manager.ts:30`, up to 2 Hz), so the index is being rewritten at exactly the moment a force-quit happens. If the file is torn, `load()` catches the `JSON.parse` error and returns `[]` (lines 166-168). The next `set()` then overwrites the file with that empty list plus the new entry. Every unuploaded or mid-upload scan disappears from the app. Its session directory (private home photos) stays on disk, but nothing references it, so it can't be uploaded or discarded. This is data loss on the exact path Phase 4 says it survives.
**Fix:** Write to `index.json.tmp`, then `move()` it over `index.json`, which is an atomic rename. On a parse failure, keep the corrupt file (rename it to `index.corrupt.json`) and rebuild the entries from the `sessions/<id>/session.json` directories instead of returning `[]`. Also stop persisting `progress` to disk on every tick. It is already held in memory in `manager.ts`.

### CR-03: Discard or Delete during an upload strands the scan: reconcile has no 404/409 handling and loops forever

**File:** `virtumetry/src/app/(tabs)/index.tsx:56-63`, `virtumetry/src/upload/reconcile.ts:157-166`, `virtumetry/src/app/capture/[id].tsx:169-183`
**Issue:**
1. The Library row menu offers **Discard** for every local row, including `uploading` and `paused` rows that already have a `serverWorldId` and a charged scan quota. Discarding deletes the files and the index entry while a reconcile pass may still be uploading from that directory. The server world is orphaned in `uploading` and shows up as an "Uploading…" server row until the 24 h reaper fails it.
2. The server row of a scan that is still uploading is also shown (see WR-01) with a **Delete** action. After a soft delete, `findOwnedWorld` returns nothing, so `getMissing` returns 404. If `serverWorldId` was never stored, `createScan` returns 409 `idempotency_key_world_deleted` instead. `reconcile` handles neither: `apiFetch` throws `ApiError`, `passOnce` logs a warning, and the scan is retried on every pass forever. The local row comes back (its server status is now `undefined`, `index.tsx:108-109`) and stays on "Uploading…" forever, and its photos are never deleted even though the delete dialog says "This removes it from your phone".
**Fix:** In `reconcile`, treat `ApiError` 404 from `getMissing`/`presignUploads`/`completeScan` and 409 `idempotency_key_world_deleted` from `createScan` as terminal. Delete the local files and entry (or mark the scan `failed` with a code), and never retry. In the Library, only offer Discard when `uploadState` is `saved`, `blocked` or `failed`. When deleting a server world, also call `discardLocalScan` for any local scan whose `serverWorldId` matches.

### CR-04: The fixture scenario switcher can show "Good" while it replays the previous scenario

**File:** `virtumetry/src/app/capture/scan.tsx:63,89-92`, `virtumetry/src/capture/source.ts:459-464`, `virtumetry/src/capture/fixture-source.ts:340,358-360`
**Issue:** `getCaptureSource()` returns a module-level `FixtureCaptureSource` singleton, and that singleton keeps `this.scenario` across screens. `ScanScreen` always mounts with `useState<FixtureScenario>('good')` and only calls `src.setScenario` when the user taps a segment. After one "Jump" or "Gap" run, the next scan shows **Good** selected but replays `pose-jump`/`tracking-gap`. The owner's UAT then fails checks (CAMERA_JUMP or TRACKING_GAP) on what the UI calls a good scan. This is wrong behaviour on the main Phase 4 path, because Expo Go always uses the fixture source.
**Fix:** Sync the source on mount: `useEffect(() => { if (isFixtureSource(src)) src.setScenario(scenario); }, [src, scenario]);`. Alternatively, initialise the state from the source with a `scenario` getter, or pass the scenario into `start()` instead of keeping it as mutable singleton state.

## Warnings

### WR-01: A scan that is still uploading shows twice in the Library (local row plus server row)

**File:** `virtumetry/src/app/(tabs)/index.tsx:105-114`
**Issue:** Local scans are hidden only when their server status is past `uploading`, but `data.worlds` is appended unfiltered. While a scan uploads, the local row ("Uploading · 47%") and the server row (both "Untitled scan", server progress `null`, so "Uploading…") appear together. The server row's Delete action then sets off CR-03. `library.test.tsx:193-203` misses this because the local and server fixtures have different titles and the test never asserts that the server `Bedroom` row is absent.
**Fix:** Build a set of `serverWorldId`s for the local scans that are shown, and filter those ids out of `data.worlds`. Add an assertion to the test.

### WR-02: Approval is not durable; the `approved` state exists but is never set

**File:** `virtumetry/src/app/capture/[id].tsx:293-301`, `virtumetry/src/upload/manager.ts:13`
**Issue:** `approve` saves `approvedMaxCredits`, then awaits `createScan`, and only then sets `uploadState: 'uploading'`. If the request succeeds on the server but the response is lost (network drop or force-quit), the scan stays `saved`. The manager ignores it (it is not in `ACTIVE`), and the Library shows "Saved on phone · Not uploaded". If the user then discards it, a charged server world is orphaned. `'approved'` is in `ACTIVE` and in `LocalUploadState`, but nothing assigns it, so it is dead code. It was meant for exactly this case.
**Fix:** Set `uploadState: 'approved'` together with `approvedMaxCredits` before the network call. Then let the manager's idempotent `createScan` (`reconcile.ts:157-161`) finish the job, and drop the inline `createScan` from the mutation, or keep it only as a fast path.

### WR-03: No retry while in the foreground; a waiting background upload holds the manager lock

**File:** `virtumetry/src/upload/manager.ts:60-95`, `virtumetry/src/upload/reconcile.ts:184-196`
**Issue:** Passes run only on start, on `AppState → active`, and on `kick`. After a `paused` result (network) or an `incomplete` result (a 403 from an expired URL, a 5xx, or a 409 from `:complete`), nothing retries while the app stays in the foreground. The screen says "Waiting for connection", but it waits for an app switch, not for the connection. In the other direction, iOS background `URLSession` tasks (the `File.upload` default) wait for connectivity instead of failing, so `uploader.put` can stay pending for hours. `running` then stays `true`, every later trigger only sets `again`, and no other scan makes progress. The "pause when every put throws" branch is effectively unreachable on iOS. If the owner then leaves the app closed for more than 24 h, the stale reaper fails the world (`UPLOAD_STALE`) and Phase 4 has no retry path.
**Fix:** Schedule a backoff re-run (for example 15 s, 30 s, 60 s, capped) after a `paused` or `incomplete` result while `started`. Pass an `AbortSignal` with a per-batch timeout to `File.upload`, or use `sessionType: 'foreground'` for foreground passes, so that one stuck task cannot hold `running` indefinitely.

### WR-04: The whole presign batch (up to 200 PUTs) is fired at once with no live progress, contrary to D-21

**File:** `virtumetry/src/upload/reconcile.ts:183-184`, `virtumetry/src/upload/uploader.ts:244-251`
**Issue:** D-21 specifies limited in-JS concurrency (~4) and "uploaded/total plus live task progress". The code starts up to 200 `File.upload` calls in one `Promise.allSettled` and never passes `onProgress`. Progress therefore only moves when a whole batch settles, which for the 30-frame fixture means about 0% → 94% → 100%. A single 403 also discards the success accounting for the rest of the batch until the next pass. The comment "no JS concurrency cap" contradicts the decision without recording a decision change.
**Fix:** Use a small pool (4-6) over the batch and pass `onProgress` into `uploader.put` so per-byte progress reaches `setProgress`. If the uncapped background-session design is intentional, record that in CONTEXT/SUMMARY and at least pass `onProgress`.

### WR-05: Capture session directories leak when the scan screen is cancelled while starting or unmounted while recording

**File:** `virtumetry/src/app/capture/scan.tsx:68-74,94-111,135-142`, `virtumetry/src/capture/fixture-source.ts:376-430`
**Issue:** `cancel()` during `phase === 'starting'` (frames.length is 0) calls `discardAndClose` → `src.cancel()`. At that point `this.dir` is still null, because `start()` is still awaiting the asset resolution on line 380. When `start()` resolves, it creates the directory and arms the replay timer after the screen has closed, and it writes a full session that is never indexed. If the screen unmounts while recording (JS reload, Android back, navigation), there is no cleanup either: the timer keeps writing frames into an unindexed directory. Neither case is visible in the UI or can be deleted from it, and these directories hold room photos (CLAUDE.md privacy constraint).
**Fix:** Add a cancellation token in `FixtureCaptureSource.start()` and check it after the `await`. Add an unmount effect in `ScanScreen` that calls `src.cancel()` when the phase is not `idle` and the scan was not stopped. At start-up, sweep `sessions/` for directories missing from `index.json`.

### WR-06: Unbounded integers in the create body turn into 500s

**File:** `backend/src/routes/scans.ts:34-42`
**Issue:** `approved_max_credits`, `image_w` and `image_h` have no upper bound, but they are stored in Postgres `integer` columns (`schema.ts:102`, `captures`). A value above 2^31-1 passes zod, the quota has already been charged, and the insert throws (22003, out of range), which the client sees as 500. The quota is not released (see CR-01). Nothing ever checks `image_w`/`image_h` against `session.json` either.
**Fix:** `approved_max_credits: z.number().int().min(1).max(2_000_000_000)` (or a tighter multiple of the quote), and `image_w/h: z.number().int().min(1).max(MAX_LONG_EDGE)`. Optionally assert at `:complete` that `capture.imageW/H` equals `session.imageWidth/Height`.

### WR-07: Local entries are never pruned, and "removes it from your phone" is not true for blocked or failed scans

**File:** `virtumetry/src/app/(tabs)/index.tsx:91-96,105-110`, `virtumetry/src/upload/reconcile.ts:136-147`
**Issue:** `done` entries stay in `index.json` forever. They are hidden only while their world is in the first 100 server rows, so after a server Delete (or past row 100) they come back as "Uploaded · Processing started" with only a Discard action. `blocked`/`failed` scans keep their photos (T-04-28) and are hidden behind the server row. The server row's Delete dialog says "This removes it from your phone", but it only calls `deleteWorld`. The local photos remain, and the local row comes back as "Failed · Didn't pass checks".
**Fix:** On a successful `deleteWorld`, discard any local scan with a matching `serverWorldId`. Drop `done` entries once the server reports the world (or after N days), not only hide them.

## Info

### IN-01: The `:complete` failure_message is a list of codes, not human text (D-17)

**File:** `backend/src/routes/scans.ts:328-329`
**Issue:** `failWorld(..., codes[0], codes.join(', '))` stores "CAMERA_JUMP, TRACKING_GAP" as `failure_message`. The app never renders it (T-04-17), so users are not affected, but it does not match D-17 and the per-issue `message` texts are thrown away.
**Fix:** Store `err.issues.map((i) => i.message).join('; ')` (it is already sanitised and truncated by `failWorld`).

### IN-02: A scan that fails validation still uses up the daily scan quota

**File:** `backend/src/routes/scans.ts:183,326-333`
**Issue:** The quota is charged at create and never released when `:complete` fails at `validate`. With the production `DAILY_SCAN_QUOTA` of 10, a run of failed checks locks the owner out for the day.
**Fix:** If this is intended, document it. Otherwise call `releaseScanQuota` in the validation-failure branch.

### IN-03: `budget:reset-dev` deletes mock rows for every user, including in-flight reservations

**File:** `backend/scripts/budget-reset-dev.ts:14-21`
**Issue:** The header and D-24 say "for the owner", but the DELETE has no `world_id`/owner filter. Deleting a `reserve` row for a submission that is still running also removes the `'already'` guard in `reserveCredits`, so a resumed submit reserves again.
**Fix:** Delete only `kind='reserve'` rows whose world is terminal (with their `release` pairs), or document that it must run with no active jobs.

### IN-04: Stop computes precheck and readiness from render-time state and stores the result permanently

**File:** `virtumetry/src/app/capture/scan.tsx:114-131`
**Issue:** `stop()` reads `frames`/`ready`/`cov` from the last render, so a keyframe that arrives between that render and `src.stop()` is counted in `frameCount` but not in `precheck`. If `/v1/capture/config` has not loaded yet, the bundled defaults (`minFrames: 50`) block the 30-frame fixture. That verdict is stored in `precheckIssues` and never recomputed, so Upload stays disabled for that scan.
**Fix:** Keep the frames in a ref that the listener updates, and recompute precheck on the review screen from the current config, or re-check it at approve time.

### IN-05: `stop()` has no error handling

**File:** `virtumetry/src/app/capture/scan.tsx:114-117`
**Issue:** If `src.stop()` or `addLocalScan` throws (for example when the disk is full while writing `index.json`), `phase` stays `stopping`, the shutter stays disabled, and the screen can't be used.
**Fix:** Wrap the body in `try/catch`, reset the phase, and show an alert.

### IN-06: Presigned PUT URLs stay valid for 6 h after the world leaves `uploading`

**File:** `backend/src/routes/scans.ts:29,253-264`
**Issue:** After `:complete` has validated, a client still holding URLs can overwrite `session.json`/`frames.jsonl`/frames before or during pack. Pack re-validates (minus `expectedFrameCount`), so no credit is at risk, and only the owner can do this. The checked inputs are still not immutable.
**Fix:** Pass `expectedFrameCount: cap.frameCount` in `handlePack` as well, and consider a shorter TTL with re-presign (reconcile already re-presigns on every pass).

### IN-07: `expo-camera` was added without a config plugin or camera usage string

**File:** `virtumetry/package.json:12`, `virtumetry/app.json`
**Issue:** Expo Go supplies its own permission strings, so this is fine for Phase 4. The first dev build (Phase 8) will need `expo-camera` in `plugins` with `cameraPermission` text, and that is a native change that costs a build.
**Fix:** Add the plugin entry now so it lands in the same batched native build.

---

_Reviewed: 2026-11-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
