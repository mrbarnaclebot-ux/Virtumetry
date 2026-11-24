---
phase: 04-0-capture-to-world-loop
reviewed: 2026-11-24T00:00:00Z
depth: standard
iteration: 3
files_reviewed: 15
files_reviewed_list:
  - virtumetry/src/capture/fixture-source.ts
  - virtumetry/src/lib/api.ts
  - virtumetry/src/upload/manager.ts
  - virtumetry/src/upload/reconcile.ts
  - virtumetry/src/app/(tabs)/index.tsx
  - virtumetry/src/app/capture/[id].tsx
  - virtumetry/src/app/capture/scan.tsx
  - virtumetry/src/library/display-state.ts
  - backend/src/routes/scans.ts
  - backend/src/routes/worlds.ts
  - virtumetry/src/__tests__/capture-fixture-source.test.ts
  - virtumetry/src/__tests__/upload-reconcile.test.ts
  - virtumetry/src/__tests__/library.test.tsx
  - virtumetry/src/__tests__/library-actions.test.tsx
  - virtumetry/src/__tests__/capture-quote.test.tsx
findings:
  critical: 0
  warning: 1
  info: 5
  total: 6
status: issues_found
---

# Phase 4: Code Review Report (iteration 3)

**Reviewed:** 2026-11-24
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

This re-review covers fix commits `69a5cea`, `ec50caf` and `2d0e822`, checked against the iteration-2 findings. `npx jest --ci` passes: 19 suites, 211 tests. The backend error codes that the app now matches on were checked against `backend/src/routes/scans.ts` and `worlds.ts`. Every 404 or 409 on the scan and world routes carries one of the codes the app expects.

**Iteration-2 status:**
- **CR-01: resolved.** `stop()` and `start()` both clear `this.dir`, so `cancel()` can only delete a directory created by the current start. The regression test (start, stop, pending start, cancel, then the first directory still exists) covers the reported path. Stop is disabled while starting (`scan.tsx:259`), and a cancel during `stopping` can no longer delete the directory being saved.
- **WR-01: resolved.** `ApiError.code` is read from the JSON body, and a non-JSON proxy body leaves it undefined. `reconcile` treats a scan as gone only on `world_not_found`, `capture_not_found` or `idempotency_key_world_deleted`. `useDeleteWorld` now requires `world_not_found`. A proxy or tunnel 404 stays retryable.
- **WR-02: the retry loop is resolved, but the fix opened a new dead end (WR-01 below).** The inline revert is now guarded by `serverWorldId`. The Library offers Delete whenever a server id exists, so a local-only Discard can no longer orphan a world. However, a background refusal is now terminal `failed`, and a refusal that would clear on its own (the daily quota) can only be escaped by deleting the photos.
- **WR-04:** accepted override, unchanged.

**Money and quota safety:** no regression. Nothing reserves credits before `:complete`. All of create's 400 refusals happen before `chargeScanQuota` (`scans.ts:159-185`), so a `failed` scan with no server id was never charged. A `rate_limited` 429 is still retried.

**Upload loops:** none. Refused creates and gone worlds leave `ACTIVE`. Other errors back off up to 5 minutes, as before.

## Warnings

### WR-01: A background create refusal that would clear on its own becomes terminal; the only way out deletes the photos

**File:** `virtumetry/src/upload/reconcile.ts:54-56,111-118`, `virtumetry/src/app/(tabs)/index.tsx:62-68`, `virtumetry/src/app/capture/[id].tsx:414-433`

**Issue 1: a temporary refusal kills the scan.** `refusedCreate` covers 429 `scan_quota_exceeded`, which is the daily limit of 10 scans (`config.ts:96`). The server returns it with a `retry_at`. It also covers 400 `approval_below_quote`, which a fresh quote and a new approval would fix. Both now set `uploadState: 'failed'`.

A local `failed` row with no server id leaves the owner two options:
- Discard, which deletes the photos (the menu at `index.tsx:62-68`).
- Back to Library from a dead-end Upload screen (`[id].tsx:414-433`). Nothing reopens Review or Quote, because `openScan` routes every non-`saved` state to `upload`.

So a scan that would succeed tomorrow has to be thrown away and captured again. For the same refusal, the inline path reverts to `saved`, and the iteration-2 review recommended `saved` here too.

A realistic path: approve while offline (the scan stays `approved`), reach the daily quota with other scans, and the manager's create then gets a 429 `scan_quota_exceeded`.

**Issue 2: the refusal write ignores a world created meanwhile.** It does not check whether a server world has been stored in the meantime. The inline path got this guard; the manager path did not.

The race: the manager pass and the inline approve call `createScan` with the same key at the same time while the quota is at its last slot. The winner takes the slot. The loser gets 429 `scan_quota_exceeded` before it can replay, because the quota charge comes before the unique-key insert.

If the manager is the loser and its write lands after the inline success:
- The scan becomes `failed` with a `serverWorldId`, which is not in `ACTIVE`, so its frames are never uploaded.
- The world sits in `uploading`, holding a quota slot, until the 24 h reaper.
- The only action left is Delete.

**Fix:** Put a refused scan back to `saved` and keep the reason, so the owner can re-quote and re-approve with the same idempotency key. No world exists, so the key is still free. Skip the write if a world was stored meanwhile:
```ts
} catch (e) {
  if (!refusedCreate(e)) throw e;
  if (local.get?.(scan.id)?.serverWorldId) return { kind: 'incomplete' }; // a racing create won
  local.update(scan.id, { uploadState: 'saved', failureCode: String(codeOf(e)).toUpperCase() });
  return { kind: 'failed' };
}
```
Add `get: getLocalScan` to the manager's `local` deps. Optionally, show `failureCode` on the `saved` Review screen ("Daily scan limit reached, try again tomorrow"). If a terminal `failed` is kept for the codes that really are permanent (`invalid_body`, `invalid_idempotency_key`), limit `refusedCreate` to those codes, and still apply the `serverWorldId` guard.

## Info

### IN-01: A zero-frame Stop now leaves an empty session directory behind

**File:** `virtumetry/src/capture/fixture-source.ts:150-156`, `virtumetry/src/app/capture/scan.tsx:130-133`
**Issue:** `stop()` now clears `this.dir` before returning. When `r.frameCount === 0`, `scan.tsx` calls `discardAndClose()` and then `cancel()`, which no longer sees the directory. The directory `start()` created (`session.json`, an empty `frames.jsonl`, `frames/`) stays in `Documents/sessions` and is not in the index. This happens if Stop is pressed before the first timer tick. It is a minor storage leak and loses no data.
**Fix:** In `stop()`, delete the directory when `this.emitted === 0` before clearing it, or have `scan.tsx` delete `r.dir` on the zero-frame path.

### IN-02: Refused-create codes outside the LIMIT set show a misleading reason

**File:** `virtumetry/src/library/display-state.ts:84-110`
**Issue:** The following codes fall through to "Something went wrong while processing", although nothing was processed:
- `INVALID_BODY`, `MISSING_IDEMPOTENCY_KEY` and `INVALID_IDEMPOTENCY_KEY`.
- Fastify's built-in `BAD REQUEST`, because `refusedCreate` accepts any string `error` on a 400.

**Fix:** Map these codes to "Couldn't start the upload", or restrict `refusedCreate` to the scan route's own codes.

### IN-03: `index.corrupt.json` is never read back and is overwritten by the next corruption (carried from iteration 2)

**File:** `virtumetry/src/capture/store.ts:36-41`
**Fix:** Timestamp the name, or skip the move if a corrupt file already exists.

### IN-04: A failing `releaseScanQuota` masks the original create error (carried from iteration 2)

**File:** `backend/src/routes/scans.ts:217-224`
**Fix:** `await releaseScanQuota(db, userId).catch((e) => req.log.error({ err: e }, 'quota refund failed'));`

### IN-05: `done` entries past the first 100 server rows are never pruned (carried from iteration 2)

**File:** `virtumetry/src/app/(tabs)/index.tsx:117-128`
**Fix:** Prune against all pages once paging exists, or prune `done` entries after N days.

The iteration-1 Info items remain as recorded in `04-REVIEW.iter1.md`.

---

_Reviewed: 2026-11-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
