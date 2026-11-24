---
phase: 03-owner-account-scan-library
plan: 03
subsystem: backend-library
tags: [worlds, ownership, rename, owner-create, better-auth]
requires: [03-02 session mode + ensureOwnerCredential]
provides:
  - "GET /v1/worlds items add failure_stage, failure_code, failure_message, charged, eta_seconds (null); existing names kept"
  - "PATCH /v1/worlds/:id { title } (strict, trimmed 1-80, owner-only, 404 for foreign/junk ids, bumps updated_at)"
  - "npm run owner:create (dev DB only, allowlisted email, hidden prompt, status word output)"
  - "ensureOwnerCredential reset now revokes all of the user's sessions"
affects: [backend/src/routes/worlds.ts, backend/src/auth/owner.ts]
tech-stack:
  added: []
  patterns: [owner-scoped UPDATE re-checks owner_id + deleted_at, script guards before any DB connection, spawn-based guard tests]
key-files:
  created:
    - backend/scripts/owner-create.ts
    - backend/test/integration/ownership.pg.test.ts
    - backend/test/integration/owner-create.pg.test.ts
  modified:
    - backend/src/routes/worlds.ts
    - backend/src/auth/owner.ts
    - backend/package.json
    - backend/test/worlds.list.test.ts
decisions:
  - "03-03: session revocation on password reset lives in ensureOwnerCredential (testable on a throwaway schema), not only in the script"
  - "03-03: owner:create builds a minimal Config cast for createAuth (ephemeral secret when BETTER_AUTH_SECRET unset) instead of loadConfig, so it needs no server env"
metrics:
  duration: ~20 min
  completed: 2026-11-24
  tasks: 2
  files: 7
---

# Phase 3 Plan 03: Owner-only library contract and owner:create Summary

Owner-scoped PATCH rename plus D-15a list fields on /v1/worlds, a two-account Postgres proof that foreign scans are 404, and an `owner:create` script that creates or resets the single allowlisted Better Auth owner on the Neon dev branch only.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | List fields, PATCH rename, two-account 404s | 38bd13f (RED), 3bb62da (GREEN) |
| 2 | owner:create script + helper fix | 47f549f (RED), af814da (GREEN) |

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run`: 34 files passed, 312 tests passed (67 skipped = pg suites without TEST_DATABASE_URL)
- `npm run test:pg` (full integration dir, throwaway schemas): 9 files passed, 70 tests passed, 1 skipped
  - ownership.pg.test.ts: 8/8; owner-create.pg.test.ts: 5/5 (1 helper create/reset + 4 guard spawns)
- Grep gates: `app.patch` 1, `max(80)` 1, `eta_seconds` 1, `heartbeat_at` kept; D-18 diff gate empty; `assertDevDb('MIGRATE_DATABASE_URL')` 1, `signUpEmail` 0, no console call printing email/password
- owner:create was NOT run against the real dev DB (owner's step, 03-09)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ensureOwnerCredential never reset, it duplicated credentials**
- **Found during:** Task 2 (RED test returned 'linked' instead of 'reset')
- **Issue:** `findUserByEmail(email)` without `{ includeAccounts: true }` returns an empty accounts list, so a second call linked a second credential account instead of updating the password.
- **Fix:** pass `{ includeAccounts: true }`; test asserts exactly one credential account after create + reset.
- **Files modified:** backend/src/auth/owner.ts
- **Commit:** af814da

**2. [Rule 2 - Security] Session revocation on reset placed in the helper**
- **Issue:** Plan put `deleteSessions` in the script; better-auth 1.7's user-level call is `internalAdapter.deleteUserSessions(userId)` and putting it in ensureOwnerCredential makes T-03-15 testable on a throwaway schema.
- **Fix:** reset branch calls `deleteUserSessions`; test proves a pre-reset cookie gets 401.
- **Files modified:** backend/src/auth/owner.ts
- **Commit:** af814da

**3. [Rule 2] Extra guard test** for OWNER_PASSWORD < 12 chars (script refuses before connecting).

## Notes

- PATCH without a route previously returned 404 before auth; with the route it is 401 unauthenticated.
- No CORS plugin is registered yet, so PATCH needs no CORS method change (web share page will need it later).

## Self-Check: PASSED

## Requirements

AUTH-01/AUTH-05 server halves done. LIB-01 and LIB-03 were left unchecked on purpose: the Library UI (03-06/07) and delete at SpAItial are still to come.
