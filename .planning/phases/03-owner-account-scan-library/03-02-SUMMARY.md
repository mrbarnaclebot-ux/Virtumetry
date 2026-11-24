---
phase: 03-owner-account-scan-library
plan: 02
subsystem: backend-auth
tags: [better-auth, session, allowlist, fastify, drizzle, migration]
requires: [03-01 approved package list]
provides:
  - "AUTH_MODE=session: Better Auth 1.7.27 at /api/auth/* (email+password, sign-up disabled, allowlist-gated)"
  - "createAuth / parseAllowlist / isAllowlisted (src/auth/better-auth.ts)"
  - "ensureOwnerCredential(auth, email, password) for owner:create in 03-03"
  - "session cookie -> exactly one users row (apple_sub = 'ba:' + Better Auth user id)"
  - "migration 0003_better_auth (user/session/account/verification), applied to Neon dev"
affects: [backend/src/auth.ts, backend/src/config.ts, backend/src/server.ts, backend/src/routes/index.ts]
tech-stack:
  added: [better-auth@1.7.27, "@better-auth/expo@1.7.27", "@fastify/cors@11.4.3"]
  patterns: [scoped raw-buffer Fetch bridge, getSetCookie multi-cookie copy, x-vm-client-ip from req.ip]
key-files:
  created:
    - backend/src/auth/better-auth.ts
    - backend/src/auth/owner.ts
    - backend/src/routes/auth-handler.ts
    - backend/drizzle/0003_better_auth.sql
    - backend/drizzle/meta/0003_snapshot.json
    - backend/.npmrc
    - backend/test/helpers/auth-app.ts
    - backend/test/integration/auth-session.pg.test.ts
    - backend/test/allowlist.test.ts
  modified:
    - backend/package.json
    - backend/package-lock.json
    - backend/src/db/schema.ts
    - backend/drizzle/meta/_journal.json
    - backend/src/auth.ts
    - backend/src/config.ts
    - backend/src/server.ts
    - backend/src/routes/index.ts
    - backend/src/routes/deps.ts
    - backend/test/config.test.ts
    - backend/test/migrate-folder.test.ts
decisions:
  - "03-02: Better Auth origin check forced on (advanced.disableOriginCheck:false); its isTest() default silently skips origin/CSRF checks under vitest"
  - "03-02: @better-auth/expo@1.7.27 installed in backend (approved in 03-01) for the expo() plugin that maps expo-origin -> Origin"
  - "03-02: backend/.npmrc legacy-peer-deps=true — better-auth's optional @sveltejs/kit peer (vite 8) clashes with vitest 2 (vite 5)"
  - "03-02: test helper seeds via its own createAuth on the same db+config; the server is not decorated with auth"
metrics:
  duration: 12min
  completed: 2026-11-24
  tasks: 3
  files: 20
---

# Phase 3 Plan 02: Better Auth session mode (server half of owner login) Summary

Allowlisted email+password sign-in through Better Auth 1.7.27 mounted at `/api/auth/*` behind a raw-body Fastify-to-Fetch bridge; the session cookie authenticates `/v1` as exactly one `users` row (`apple_sub = 'ba:' + id`), with sign-up disabled, a double allowlist gate, origin check, a 5/60 s per-IP sign-in limiter and server-side sign-out revocation, all proven against real Postgres.

## Tasks

| # | Task | Commit |
|---|------|--------|
| 1 | RED test + Better Auth tables + migration 0003 (applied to Neon dev) | b90cb3b |
| 2 | createAuth, ensureOwnerCredential, bridge, session branch in the /v1 hook (GREEN) | fdd76ae |
| 3 | Guard tests + production boot rules + origin-check fix | 2e8f9b7 |

RED evidence (Task 1): `Error: Failed to load url ../../src/auth/better-auth.js ... Does the file exist?` (0 tests collected, missing module, not a test syntax error).

## Verification

- `npx tsc --noEmit` clean.
- `npx vitest run`: 33 files passed, 307 tests passed (pg suites skipped without TEST_DATABASE_URL).
- `npm run test:pg -- test/integration/auth-session.pg.test.ts`: 10/10 passed in a throwaway schema.
- Full `npm run test:pg` (all integration suites, 0003 included via createTestSchema): 7 files passed, 57 tests passed, 1 skipped (r2-range, needs test:r2).
- `npm run db:migrate:dev` exit 0; `user`, `session`, `account`, `verification` confirmed on the Neon dev branch. 0003 contains only CREATE TABLE / FK / INDEX for the four new tables.
- No real emails in backend (`git grep` check empty); test passwords are `crypto.randomBytes` per run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Security bug] Better Auth skipped origin checks under vitest**
- **Found during:** Task 3 (evil-origin sign-in returned 200)
- **Issue:** `create-context.mjs` sets `skipOriginCheck = isTest() ? true : false` when `advanced.disableOriginCheck` is unset, so the CSRF/origin guard was off in any test-detected environment and the D-06 test would have been vacuous.
- **Fix:** `advanced.disableOriginCheck: false` in createAuth. Origin, sign-out and expo-origin tests now run against the real check.
- **Files:** backend/src/auth/better-auth.ts — **Commit:** 2e8f9b7

**2. [Rule 3 - Blocking] npm ERESOLVE on install**
- **Issue:** better-auth's optional peer `@sveltejs/kit` wants vite 8; vitest 2 pins vite 5.
- **Fix:** installed with `--legacy-peer-deps` and added `backend/.npmrc` (`legacy-peer-deps=true`) so `npm ci` in CI resolves the same way. No svelte packages installed; vitest not upgraded.
- **Commit:** b90cb3b

**3. [Rule 3 - Blocking] `@better-auth/expo` needed in backend**
- **Issue:** the plan's createAuth uses `expo()` (required for the expo-origin behavior test) but the install line listed only better-auth + cors.
- **Fix:** installed `@better-auth/expo@1.7.27` (on the 03-01 approved list).
- **Commit:** b90cb3b

**4. [Rule 3 - Blocking] `internalAdapter.createUser` needs a provisioning source in 1.7.27**
- **Fix:** `createUser({...}, { method: 'email-password' })`, same as Better Auth's own sign-up route.
- **Commit:** fdd76ae

**5. [Rule 1] migrate-folder history test pinned the migration list**
- **Fix:** added `0003_better_auth` to the expected history. **Commit:** fdd76ae

## Threat Flags

None beyond the plan's threat model (all T-03-01..T-03-09 mitigations implemented; T-03-08 accepted with a `ponytail:` note on the memory limiter).

## Notes for next plans

- Worker also passes through `refine()`: deploying `AUTH_MODE=session` needs `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` on both services (Pitfall 3, 03-03).
- `ensureOwnerCredential` is ready for `owner:create`.

## Self-Check: PASSED
