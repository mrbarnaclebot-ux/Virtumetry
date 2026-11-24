---
phase: 03-owner-account-scan-library
fixed_at: 2026-11-24T00:00:00Z
review_path: .planning/phases/03-owner-account-scan-library/03-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-11-24
**Source review:** .planning/phases/03-owner-account-scan-library/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (1 critical, 5 warnings; Info out of scope)
- Fixed: 6
- Skipped: 0

**Verification after all fixes:** backend `tsc --noEmit` clean, `vitest run` 322 passed / 80 skipped, `npm run test:pg` (throwaway schemas on the Neon dev branch) 11 files / 87 passed, 1 skipped; app `tsc --noEmit` clean, `jest --ci` 100/100, `expo lint` clean.

## Fixed Issues

### CR-01: The app's DELETE always gets 400 from Fastify (empty JSON body)

**Files modified:** `virtumetry/src/lib/api.ts`, `virtumetry/src/__tests__/library-actions.test.tsx`, `backend/test/integration/ownership.pg.test.ts`
**Commit:** 4b2b0f3
**Applied fix:** `apiFetch` sends `content-type: application/json` only when `init.body != null`. The app test now asserts that a bodiless DELETE sends exactly `{ Cookie }`. A new pg test injects those exact headers into the real session-mode server and expects 200 plus a soft delete. It also pins the root cause: the old header set (JSON content type, no body) still gets 400.

### WR-01: The hard delete erases the only record of a possibly billed submit

**Files modified:** `backend/src/worker.ts`, `backend/test/integration/purge-cascade.pg.test.ts`
**Commit:** 169b304
**Applied fix:** `handlePurge` still purges storage and poses. Before the row hard delete, it now checks a world that has `submission_key` but no `provider_request_id`. If that key still holds an unreleased credit reservation (the send may have been billed), the purge throws `NonRetryableJobError`, which parks the job dead and keeps the soft-deleted row with its key and body for manual reconciliation. A released reservation means the provider is known not to have charged, so the hard delete goes ahead. I used the reservation instead of the reviewer's bare `submissionKey && !providerRequestId` check. The key is minted before preflight, and with the bare check every never-sent or refused submit would also have been parked. Two pg tests cover this (held → parked dead, row kept; released → hard deleted).
**Status:** fixed: requires human verification (logic change: confirm that an "unreleased reservation" matches the cases you want parked).

### WR-02: Account deletion in session mode keeps the Better Auth PII and locks the owner out for good

**Files modified:** `backend/src/routes/account.ts`, `backend/src/routes/index.ts`, `backend/test/integration/auth-session.pg.test.ts`, `virtumetry/src/lib/api.ts`, `virtumetry/src/__tests__/library.test.tsx`
**Commit:** 18ba820
**Applied fix:** `DELETE /v1/account` gets the Better Auth instance. When the user's subject is `ba:<id>`, it calls `internalAdapter.deleteUser(id)`, which removes the session and account rows (FK cascade, plus BA's own deletes). The pg test checks that the user, session and account rows are gone, the old cookie gets 401, and re-running `owner:create` for the same email signs in to a fresh library (no permanent 403). `apiFetch` treats a 403 `account_deleted` like a 401 (`endSession`), covered by a new jest test.

### WR-03: `seed:library` fails with an FK error once the worker has touched a seed world

**Files modified:** `backend/scripts/seed-library.ts`, `backend/test/integration/seed-library.pg.test.ts`
**Commit:** af50194
**Applied fix:** `resetSeeds` deletes `jobs`, then `captures`, then `worlds` for the seed ids in one transaction, and purges thumbnails only after the rows are gone. A new pg test enqueues a purge job for a seed world, then resets and re-seeds.

### WR-04: The dev bearer in session mode skips the allowlist and can claim the owner's `ba:` identity

**Files modified:** `backend/src/auth.ts`, `backend/test/auth.test.ts`
**Commit:** b8aae98
**Applied fix:** `parseDevAuth` rejects any `x-dev-user` that starts with `ba:` with a 401, plus a unit test. Skipped the reviewer's stronger option of refusing `DEV_AUTH_TOKEN` in session mode outside tests: WR-05 already refuses it on every deployed service.

### WR-05: The public dev deployment runs with every production guard turned off

**Files modified:** `backend/src/config.ts`, `backend/test/config.test.ts`, `backend/README.md`
**Commit:** 56b0496
**Applied fix:** `RAILWAY_ENVIRONMENT_ID` is added to the config schema. Railway sets it on every service. The four hardening refusals (`DEV_AUTH_TOKEN`, `AUTH_RATE_LIMIT=0`, a non-https `BETTER_AUTH_URL`, `STORAGE_DRIVER=local`) now apply when `NODE_ENV=production` OR that variable is present. `exp://` trust stays tied to NODE_ENV. Config tests cover a hardened Railway-dev config loading and each of the four being refused. The README documents the change.
**Status:** fixed: requires human verification. Before the next dev redeploy, confirm that the Railway dev `api` and `worker` services set `STORAGE_DRIVER=s3`, an https `BETTER_AUTH_URL`, and no `DEV_AUTH_TOKEN` / `AUTH_RATE_LIMIT=0`. If any of these is off, boot now fails loudly instead of running unguarded. The README says dev uses `virtumetry-dev` R2 and never sets `DEV_AUTH_TOKEN`, so it should pass, but I could not read the live variables because Railway commands were off-limits.

---

_Fixed: 2026-11-24_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
