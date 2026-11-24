---
phase: 03-owner-account-scan-library
reviewed: 2026-11-24T00:00:00Z
depth: standard
files_reviewed: 62
files_reviewed_list:
  - Dockerfile
  - backend/.npmrc
  - .github/workflows/app.yml
  - .gitignore
  - virtumetry/.gitignore
  - backend/drizzle/0003_better_auth.sql
  - backend/package.json
  - backend/scripts/owner-create.ts
  - backend/scripts/seed-library.ts
  - backend/src/auth.ts
  - backend/src/auth/better-auth.ts
  - backend/src/auth/owner.ts
  - backend/src/config.ts
  - backend/src/db/schema.ts
  - backend/src/pipeline.ts
  - backend/src/provider/mock.ts
  - backend/src/provider/types.ts
  - backend/src/routes/auth-handler.ts
  - backend/src/routes/deps.ts
  - backend/src/routes/index.ts
  - backend/src/routes/worlds.ts
  - backend/src/server.ts
  - backend/src/worker.ts
  - backend/test/helpers/auth-app.ts
  - backend/test/integration/auth-session.pg.test.ts
  - backend/test/integration/owner-create.pg.test.ts
  - backend/test/integration/ownership.pg.test.ts
  - backend/test/integration/purge-cascade.pg.test.ts
  - backend/test/integration/seed-library.pg.test.ts
  - backend/test/allowlist.test.ts
  - backend/test/config.test.ts
  - backend/test/worlds.list.test.ts
  - backend/test/account-deleted.test.ts
  - virtumetry/.env.development
  - virtumetry/app.json
  - virtumetry/eas.json
  - virtumetry/package.json
  - virtumetry/jest.mjs-transformer.js
  - virtumetry/jest.setup.ts
  - virtumetry/tsconfig.json
  - virtumetry/src/app/_layout.tsx
  - virtumetry/src/app/sign-in.tsx
  - virtumetry/src/app/(tabs)/_layout.tsx
  - virtumetry/src/app/(tabs)/index.tsx
  - virtumetry/src/app/(tabs)/settings.tsx
  - virtumetry/src/components/library-row.tsx
  - virtumetry/src/components/rename-modal.tsx
  - virtumetry/src/components/app-tabs.tsx
  - virtumetry/src/components/app-tabs.web.tsx
  - virtumetry/src/components/themed-text.tsx
  - virtumetry/src/constants/theme.ts
  - virtumetry/src/config/api.ts
  - virtumetry/src/lib/api.ts
  - virtumetry/src/lib/auth-client.ts
  - virtumetry/src/lib/query-client.ts
  - virtumetry/src/lib/session.ts
  - virtumetry/src/library/display-state.ts
  - virtumetry/src/library/local-scans.ts
  - virtumetry/src/__tests__/library-actions.test.tsx
  - virtumetry/src/__tests__/library.test.tsx
  - virtumetry/src/__tests__/sign-in.test.tsx
  - virtumetry/src/__tests__/settings.test.tsx
findings:
  critical: 1
  warning: 5
  info: 7
  total: 13
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-11-24
**Depth:** standard
**Files Reviewed:** 62
**Status:** issues_found

## Summary

I reviewed the Better Auth integration (factory, Fastify bridge, onRequest gate), the owner/seed scripts, the hard-delete purge cascade, the rename route, and the Expo app's auth, session and Library layers.

The core auth design holds up. Sign-up is disabled. The allowlist is checked both at sign-in and on every /v1 request. The client IP is overwritten in the bridge. Origin checks are forced on. Production refuses the dev token, the disabled rate limit and http URLs. Ownership checks on PATCH and DELETE re-verify owner and not-deleted in the UPDATE itself. No secrets are committed: `.env.development` and `eas.json` hold only public URLs.

One blocker: **every app-side delete fails against the real backend.** I reproduced this with `fastify.inject`. The jest tests miss it because they stub `fetch`. The warnings cover a privacy and orphaned-spend gap that the new hard delete opens, account deletion in session mode, a seed script that breaks once the worker has touched a seed row, a dev-bearer path that can impersonate the owner, and a public dev deployment that skips every hardening guard.

## Critical Issues

### CR-01: The app's DELETE always gets 400 from Fastify (empty JSON body)

**File:** `virtumetry/src/lib/api.ts:26` (used by `deleteWorld`, line 68)
**Issue:** `apiFetch` always sends `content-type: application/json`, even for bodiless requests. Fastify parses DELETE bodies whenever a content type is present, and its JSON parser rejects an empty body. I checked this against the backend's own Fastify version:

```
DELETE /x  {"content-type":"application/json"}                     -> 400 FST_ERR_CTP_EMPTY_JSON_BODY
DELETE /x  {"content-type":"application/json","content-length":"0"} -> 400 FST_ERR_CTP_EMPTY_JSON_BODY
```

So `DELETE /v1/worlds/:id` from the phone returns 400, `useDeleteWorld` rolls back, and the user always sees "Couldn't delete". LIB-03 / SC4 cannot pass on device. `library-actions.test.tsx` uses a fake `fetch`, and the backend tests inject DELETE without a content type, so neither suite catches it.
**Fix:** Send the JSON content type only when there is a body:

```ts
headers: {
  ...(init.body != null ? { 'content-type': 'application/json' } : {}),
  ...(init.headers as Record<string, string>),
  Cookie: await authClient.getCookie(),
},
```

Add one backend test that injects `DELETE /v1/worlds/:id` with the exact headers the app sends.

## Warnings

### WR-01: The hard delete erases the only record of a possibly billed submit, leaving the scan at SpAItial for good

**File:** `backend/src/worker.ts:139-179`, together with `backend/src/pipeline.ts:128-129` and `:233-235`
**Issue:** Purge calls `provider.deleteWorld` only when `world.providerRequestId` is set. Consider a submit that hit a 5xx or timeout. `handleSubmit` throws `RetryLaterError` and keeps the reservation, because "the request may exist and be billed". If the user deletes the scan during that snooze, the next submit run sees `deletedAt` and completes without reconciling. Purge then finds no request id, skips the provider, and **hard-deletes the world row together with `submission_key` and `submit_body`**. Those are the only handles that could find the provider-side world again, via the idempotency key. Before this phase the soft-deleted row kept them. Now a private home scan can stay at the provider forever with no way to locate it, which contradicts the delete copy ("removes it from … SpAItial").
**Fix:** In `handlePurge`, refuse to hard-delete while `world.submissionKey != null && world.providerRequestId == null`. Either resolve the request id first (re-send with the same key, which is idempotent, then delete), or keep the row soft-deleted and park the job for review:

```ts
if (hardDelete && world.submissionKey && !world.providerRequestId) {
  throw new NonRetryableJobError('purge: submit outcome unknown, provider copy unreconciled');
}
```

### WR-02: Account deletion in session mode keeps the Better Auth PII and locks the owner out for good

**File:** `backend/src/routes/account.ts:32-33`, `backend/src/auth.ts:146-147`, `virtumetry/src/lib/api.ts:28-32`
**Issue:** `DELETE /v1/account` sets `users.deleted_at`. It does not delete the Better Auth `user`, `account` (password hash) or `session` rows (`ip_address`, `user_agent`). "Full account deletion" therefore keeps the email, credential and IP history, which goes against the privacy constraint in CLAUDE.md. And `owner:create` finds the same BA user by email, so `ba:<same id>` maps to the deleted `users` row. Every later sign-in then gets 403 `account_deleted` forever. On the app side, `apiFetch` handles only 401, so a 403 leaves the user signed in with a Library that never loads.
**Fix:** In session mode, also run `ctx.internalAdapter.deleteUser(baUserId)` in the account route. The cascade removes `session` and `account`. In `apiFetch`, treat a 403 with `error: 'account_deleted'` like a 401 (`endSession`).

### WR-03: `seed:library` fails with an FK error once the worker has touched a seed world

**File:** `backend/scripts/seed-library.ts:30-35`
**Issue:** The comment says "Seed worlds never get captures/jobs". That is false. `seed:1` is inserted as `status: 'uploading'`, so after 24 h the reaper (`worker.ts:296`) enqueues a `framesOnly` purge job for it. Deleting any seed row from the phone (the D-21 flow this seed exists to test) also enqueues a purge job until the worker runs. `jobs.world_id` is a NOT NULL FK with no ON DELETE, so `db.delete(worlds)` then fails and the script dies halfway, after it has already purged the thumbnails.
**Fix:** In `resetSeeds`, delete dependents first, inside one transaction:

```ts
await db.transaction(async (tx) => {
  const ids = seeds.map((s) => s.id);
  await tx.delete(jobs).where(inArray(jobs.worldId, ids));
  await tx.delete(captures).where(inArray(captures.worldId, ids));
  await tx.delete(worlds).where(inArray(worlds.id, ids));
});
```

Or seed `uploading` with a fresh `created_at` on every run and document the 24 h limit.

### WR-04: The dev bearer in session mode skips the allowlist and can claim the owner's `ba:` identity

**File:** `backend/src/auth.ts:135-137, 153-165` (`parseDevAuth`, lines 55-60)
**Issue:** In session mode, any request with *any* `Authorization` header goes to the dev path whenever `DEV_AUTH_TOKEN` is set (allowed under any NODE_ENV other than production). That path takes `x-dev-user` verbatim as `users.apple_sub`. A caller with the token who sends `x-dev-user: ba:<owner BA id>` becomes the owner's `users` row and sees, renames and deletes the owner's real scans. The second allowlist gate (D-03) never runs on this path. The README says `DEV_AUTH_TOKEN` is "never set" on Railway, but nothing enforces that.
**Fix:** In `parseDevAuth`, reject subjects with the reserved prefix (`if (subject.startsWith('ba:')) return { ok: false, status: 401, ... }`). Better still, refuse `DEV_AUTH_TOKEN` in `refine()` whenever `AUTH_MODE=session` and NODE_ENV is not `test`.

### WR-05: The public dev deployment runs with every production guard turned off

**File:** `backend/src/config.ts:203-236`, `virtumetry/.env.development:3`, `virtumetry/eas.json:11,18`
**Issue:** Every hardening check (`AUTH_RATE_LIMIT=0`, `DEV_AUTH_TOKEN`, an https `BETTER_AUTH_URL`, `STORAGE_DRIVER=local` with its unauthenticated `/dev-storage`) applies only when `NODE_ENV === 'production'`. The README sets the Railway dev service to `NODE_ENV=development` so that `exp://` stays trusted. That service is on the public internet, its URL is now in a public repo, and it holds the owner's real email and password credential. One mis-set variable on dev (for example `AUTH_RATE_LIMIT=0` copied from a test env) removes the brute-force limit on the owner's real password, and boot raises no error.
**Fix:** Make the guards depend on "deployed", not "production". For example, add `DEPLOYED=1` (or detect `RAILWAY_ENVIRONMENT`), apply the AUTH_RATE_LIMIT, DEV_AUTH_TOKEN, https and local-storage refusals whenever it is set, and keep only the `exp://` trust tied to NODE_ENV.

## Info

### IN-01: The LAN host regex is unanchored

**File:** `virtumetry/src/config/api.ts:3`
**Issue:** `^(localhost|…|10\.|…)` matches `localhost.attacker.net` and `10.evil.com`, so a development build would accept plain http to those hosts.
**Fix:** Anchor the end: `/^(localhost|127\.0\.0\.1|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/`.

### IN-02: Errors after a 401 still raise "Couldn't delete" / "Couldn't rename"

**File:** `virtumetry/src/lib/api.ts:81-86`
**Issue:** An `UnauthorizedError` has already signed the user out and moved them to sign-in. The delete `onError` then also shows a misleading connectivity alert on top.
**Fix:** `if (_err instanceof UnauthorizedError) return;` before the alert.

### IN-03: A background poll can bring an optimistically deleted row back

**File:** `virtumetry/src/lib/api.ts:43-48, 75-79`
**Issue:** `cancelQueries` cancels only the fetch already in flight. `refetchInterval` keeps firing while the mutation is pending, so a poll that lands before the server commits re-inserts the row until `onSettled`.
**Fix:** In `refetchInterval`, return `false` while `qc.isMutating({ mutationKey: ['deleteWorld'] })` is non-zero, and give the mutation that key.

### IN-04: A failed thumbnail stays failed, and its URL changes on every poll

**File:** `virtumetry/src/components/library-row.tsx:24-38`
**Issue:** `imageFailed` never resets when a fresh presigned `thumbnail_url` arrives. Separately, every 5 s poll mints a new presigned URL, so expo-image's URL-keyed cache misses and the thumbnail reloads.
**Fix:** Reset with `key={thumbnailUrl}` on the image wrapper. Pass `cacheKey={`thumb-${item.id}`}` to `Image`.

### IN-05: The rename modal pre-fills the placeholder "Untitled scan" as the value

**File:** `virtumetry/src/app/(tabs)/index.tsx:27`
**Issue:** `setRenaming({ id, title: state.displayTitle })` passes the display fallback, not the real (null) title.
**Fix:** Pass `item.title ?? ''`.

### IN-06: `endSession` mutates Better Auth's internal store atoms

**File:** `virtumetry/src/lib/session.ts:21-23`
**Issue:** `$store.atoms.session` is not public API. A Better Auth bump could silently break the offline logout fallback.
**Fix:** Keep the version pinned (it is), and add a test that fails if `authClient.$store.atoms.session` is missing.

### IN-07: The two allowlist checks normalize emails differently

**File:** `backend/src/auth.ts:145`
**Issue:** The gate uses `s.user.email.toLowerCase()` without `trim()`, while sign-in uses `isAllowlisted`, which trims. Both should go through one function.
**Fix:** `if (!isAllowlisted(allow, s.user.email)) return fail(401, 'unauthenticated');`

---

_Reviewed: 2026-11-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
